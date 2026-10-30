import { describe, expect, it } from 'vitest';
import { DEFAULT_REDACTION_CONFIG, type ValidationIssue } from '@caseguard/schemas';
import {
  RedactionIncompleteError,
  createCustomPatternBudget,
  type CustomPatternBudget,
} from '@caseguard/security';
import { sanitizeIssues } from '../src/services/ingestion/issues';
import { runPipeline } from '../src/services/ingestion/pipeline';
import { redactionOptionsFor } from '../src/services/ingestion/redact';
import type { PipelineEnv } from '../src/services/ingestion/types';
import type { IngestSource } from '../src/services/ports';
import { bundleOf, pipelineEnv, secrets, transcriptOf, uploadOf } from './ingestion-fixtures';

/*
 * A tenant's custom redaction pattern that cannot be applied (it matches too often, cannot be compiled,
 * or the request has no time left for it) means the payload is only partly redacted. It is refused: the
 * preview says not ok with one error issue and shows nothing of the payload, and a create answers 422
 * (review H2). Nothing of the payload may be in anything the pipeline returns.
 */

const LAMP = 'sentinel-lamp-4471';
const TICKETS = { name: 'ticket marks', pattern: 'TKT-[0-9]{6}' };
const BROKEN = { name: 'broken', pattern: '(' };
const refusal = (label: string): string =>
  `The content could not be redacted completely: custom redaction pattern "${label}" could not be applied`;

const tenantWith = (...patterns: { name: string; pattern: string }[]): Partial<PipelineEnv> => ({
  redaction: { ...DEFAULT_REDACTION_CONFIG, customPatterns: patterns },
});
const csvOf = (message: string): string =>
  [
    'Timestamp,From,Role,Message',
    `2026-05-05T09:00:00Z,Customer,customer_admin,"${message}"`,
    '2026-05-05T09:05:00Z,Engineer,support_engineer,"Looking into it now."',
  ].join('\n');

/** 1,001 matches of the ticket pattern in one text: one more than the engine allows per text. */
const greedy = `${'TKT-123456 '.repeat(1_001)}${LAMP}`;
const ordinary = `Ordinary text with ${LAMP} in it`;

const causes: {
  name: string;
  env: Partial<PipelineEnv>;
  label: string;
  code: string;
  body: string;
}[] = [
  {
    name: 'a pattern that matches too often',
    env: tenantWith(TICKETS),
    label: 'ticket marks',
    code: 'match_limit',
    body: greedy,
  },
  {
    name: 'a pattern that cannot be compiled',
    env: tenantWith(BROKEN),
    label: 'broken',
    code: 'invalid',
    body: ordinary,
  },
  {
    name: 'a request with no time left for patterns',
    env: { ...tenantWith(TICKETS), customPatternBudget: createCustomPatternBudget(0) },
    label: 'ticket marks',
    code: 'budget_exhausted',
    body: ordinary,
  },
];

const sources: { name: string; make: (body: string) => IngestSource }[] = [
  { name: 'a JSON bundle', make: (body) => ({ type: 'bundle', bundle: bundleOf({ body }) }) },
  {
    name: 'pasted text',
    make: (body) => ({
      type: 'paste',
      text: transcriptOf([body, 'Please send two failed sign-in times.']),
    }),
  },
  {
    name: 'a CSV file',
    make: (body) => ({ type: 'file', file: uploadOf('events.csv', csvOf(body), 'text/csv') }),
  },
  {
    name: 'a JSON file',
    make: (body) => ({
      type: 'file',
      file: uploadOf('bundle.json', JSON.stringify(bundleOf({ body })), 'application/json'),
    }),
  },
];

describe.each(causes)('$name', (cause) => {
  it.each(sources)('refuses $name and returns nothing of it', async (source) => {
    const outcome = await runPipeline(source.make(cause.body), pipelineEnv(cause.env));

    expect(outcome.incomplete).toBeInstanceOf(RedactionIncompleteError);
    expect(outcome.incomplete).toMatchObject({ status: 422, code: 'unsafe_content' });
    expect(outcome.incomplete?.failures.map((item) => [item.code, item.label])).toContainEqual([
      cause.code,
      cause.label,
    ]);
    expect(outcome.prepared).toBeNull();
    expect(outcome.preview).toMatchObject({
      ok: false,
      synthetic: false,
      summary: null,
      eventsPreview: [],
      redaction: { applied: false, totalReplacements: 0, findings: [] },
      injection: { detected: false, highestSeverity: 'none', findings: [] },
      alreadyIngestedCaseId: null,
    });
    expect(outcome.preview.issues[0]).toEqual({
      path: 'redaction',
      severity: 'error',
      message: refusal(cause.label),
    });
    expect(outcome.incomplete?.message).toBe(refusal(cause.label));
    expect(outcome.notes.join('\n')).toContain(`"${cause.label}" could not be applied`);

    // Not a trace of the payload or of the pattern source anywhere in what comes back.
    const shown = JSON.stringify({ ...outcome, message: outcome.incomplete?.message });
    expect(shown).not.toContain(LAMP);
    expect(shown).not.toContain('TKT-123456');
    expect(shown).not.toContain('TKT-[0-9]');
  });
});

describe('a tenant pattern that cannot be applied, in the other places text is redacted', () => {
  it('withholds the texts of the parse issues of unreadable input, and says why', async () => {
    const text = `just some words ${LAMP} without any structure`;
    const plain = await runPipeline({ type: 'paste', text }, pipelineEnv());
    const outcome = await runPipeline({ type: 'paste', text }, pipelineEnv(tenantWith(BROKEN)));

    expect(plain.preview.ok).toBe(false);
    expect(outcome.preview.ok).toBe(false);
    expect(outcome.preview.issues).toContainEqual({
      path: 'redaction',
      severity: 'error',
      message: refusal('broken'),
    });
    const others = outcome.preview.issues.filter((issue) => issue.path !== 'redaction');
    expect(others.length).toBeGreaterThan(0);
    for (const issue of others) {
      expect(issue).toMatchObject({ path: '(withheld)' });
      expect(issue.message).toMatch(/^Details withheld/);
    }
    // None of the texts that the plain run shows survives.
    const shownBefore = plain.preview.issues.map((issue) => issue.message);
    for (const issue of outcome.preview.issues) expect(shownBefore).not.toContain(issue.message);
    // Unreadable input stays a validation failure for a create, not a redaction refusal.
    expect(outcome.incomplete).toBeNull();
    expect(outcome.notes.join('\n')).toContain('"broken"');
    expect(JSON.stringify(outcome)).not.toContain(LAMP);
  });

  it('keeps a payload that was redacted completely when only the texts of its issues could not be', async () => {
    // The budget affords one evaluation: the bundle gets it, the issue texts that follow do not.
    let evaluations = 0;
    const oneEvaluation: CustomPatternBudget = {
      remainingMs: () => (evaluations === 0 ? 3_000 : 0),
      consume: () => {
        evaluations += 1;
      },
    };
    // An unknown key: the parser accepts the bundle and warns, naming the key.
    const bundle = { ...bundleOf(), extra_key_for_the_warning: 'x' };
    const outcome = await runPipeline(
      { type: 'bundle', bundle },
      pipelineEnv({ ...tenantWith(TICKETS), customPatternBudget: oneEvaluation }),
    );

    expect(outcome.preview.ok).toBe(true);
    expect(outcome.prepared).not.toBeNull();
    expect(outcome.incomplete).toBeNull();
    expect(outcome.preview.issues).toEqual([
      {
        severity: 'warning',
        path: '(withheld)',
        message: expect.stringMatching(/^Details withheld/),
      },
    ]);
    expect(JSON.stringify(outcome.preview)).not.toContain('extra_key_for_the_warning');
    expect(outcome.notes.join('\n')).toContain('"ticket marks"');
  });

  it('applies a pattern that works to the whole bundle as before', async () => {
    const outcome = await runPipeline(
      {
        type: 'bundle',
        bundle: bundleOf({ body: `Ticket TKT-123456 ${secrets.githubToken()} ok` }),
      },
      pipelineEnv(tenantWith(TICKETS)),
    );
    expect(outcome.incomplete).toBeNull();
    expect(outcome.preview.ok).toBe(true);
    expect(outcome.prepared?.bundle.events[0]?.body).toBe(
      'Ticket [REDACTED:custom] [REDACTED:github_token] ok',
    );
  });
});

describe('sanitizeIssues redacts the texts of issues in one batch', () => {
  const issue = (
    severity: ValidationIssue['severity'],
    message: string,
    path = 'events[0].body',
  ) => ({
    severity,
    path,
    message,
  });

  it('redacts messages and paths, keeps the severity and the order, and cuts to the contract', () => {
    const token = secrets.githubToken(7);
    const result = sanitizeIssues(
      [
        issue('error', `The value ${token} is not allowed`),
        issue('warning', 'Mail ava.lee@customer.io was seen', `structured.${token}`),
        issue('error', 'x'.repeat(900), 'p'.repeat(400)),
      ],
      redactionOptionsFor(DEFAULT_REDACTION_CONFIG, false),
    );
    expect(result.incomplete).toBeNull();
    expect(result.issues).toHaveLength(3);
    expect(result.issues[0]).toEqual({
      severity: 'error',
      path: 'events[0].body',
      message: 'The value [REDACTED:github_token] is not allowed',
    });
    expect(result.issues[1]).toEqual({
      severity: 'warning',
      path: 'structured.[REDACTED:github_token]',
      message: expect.stringContaining('[REDACTED:email_address'),
    });
    expect(result.issues[2]?.message).toHaveLength(500);
    expect(result.issues[2]?.path).toHaveLength(300);
  });

  it('evaluates a tenant pattern once for all the texts, and not at all for no issues', () => {
    const runs: number[] = [];
    const budget: CustomPatternBudget = {
      remainingMs: () => 3_000,
      consume: (ms) => void runs.push(ms),
    };
    const options = {
      ...redactionOptionsFor({ ...DEFAULT_REDACTION_CONFIG, customPatterns: [TICKETS] }, true),
      customPatternBudget: budget,
    };
    sanitizeIssues(
      Array.from({ length: 100 }, (_, index) => issue('warning', `Problem ${index}`)),
      options,
    );
    expect(runs).toHaveLength(1);
    expect(sanitizeIssues([], options)).toEqual({ issues: [], incomplete: null });
    expect(runs).toHaveLength(1);
  });

  it('withholds every text, whatever it said, when a pattern cannot be applied', () => {
    const options = redactionOptionsFor(
      { ...DEFAULT_REDACTION_CONFIG, customPatterns: [BROKEN] },
      true,
    );
    const result = sanitizeIssues(
      [
        issue('error', `Bad value ${LAMP}`, `structured.${LAMP}`),
        issue('error', 'Another'),
        issue('warning', 'A warning'),
      ],
      options,
    );
    expect(result.incomplete).toBeInstanceOf(RedactionIncompleteError);
    expect(result.incomplete?.message).toBe(refusal('broken'));
    // One neutral issue per severity: an error stays an error, so the verdict does not change.
    expect(result.issues).toEqual([
      {
        severity: 'error',
        path: '(withheld)',
        message: expect.stringMatching(/^Details withheld/),
      },
      {
        severity: 'warning',
        path: '(withheld)',
        message: expect.stringMatching(/^Details withheld/),
      },
    ]);
    expect(JSON.stringify(result.issues)).not.toContain(LAMP);
  });
});
