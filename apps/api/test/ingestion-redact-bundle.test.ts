import { describe, expect, it } from 'vitest';
import { CaseBundleSchema, DEFAULT_REDACTION_CONFIG, type CaseBundle } from '@caseguard/schemas';
import {
  RedactionIncompleteError,
  canonicalJson,
  createCustomPatternBudget,
  type CustomPatternBudget,
  type RedactionOptions,
} from '@caseguard/security';
import {
  credentialLikeIdentifiers,
  redactBundle,
  redactionOptionsFor,
} from '../src/services/ingestion/redact';
import { bundleOf, secrets } from './ingestion-fixtures';
import { referenceRedactBundle } from './ingestion-redact-reference';

/*
 * The bundle is redacted as one batch (review H3): every free-text field is collected, the engine runs
 * once, and the results are written back. What comes out must be what redacting field by field gave.
 */

const noPause = (): Promise<void> => Promise.resolve();
const TICKETS = { name: 'ticket marks', pattern: 'TKT-[0-9]{6}' };
const withPatterns = (...patterns: { name: string; pattern: string }[]) => ({
  ...DEFAULT_REDACTION_CONFIG,
  customPatterns: patterns,
});

/** A bundle with something to redact in every kind of field, and the same addresses in several fields. */
function richBundle(): CaseBundle {
  const base = bundleOf({ eventCount: 120 });
  const events = (base.events as Record<string, unknown>[]).map((event, index) => {
    const mail = `user${index % 7}@real-company.com`;
    return {
      ...event,
      ...(index % 3 === 0 ? { title: `Mail from ${mail}` } : {}),
      body: [
        `Message ${index}: contact ${mail} or +1 425 555 01${String(index % 100).padStart(2, '0')}.`,
        `Resolver 10.20.1.${index % 250} and documentation host 203.0.113.${index % 250}.`,
        index % 5 === 0 ? `password=${secrets.password(index + 1)}` : 'nothing secret here',
        index % 11 === 0 ? `token ${secrets.githubToken(index + 1)}` : '',
        index % 13 === 0 ? 'Tickets TKT-123456 and TKT-654321 were opened.' : '',
      ].join(' '),
      ...(index % 4 === 0
        ? {
            action: {
              label: `Asked ${mail} for logs`,
              customerEffort: 'low',
              destructive: false,
            },
          }
        : {}),
      correlationIds: index % 6 === 0 ? [`corr-${index}`, mail] : [],
      ...(index % 2 === 0
        ? {
            structured: {
              password: secrets.password(index + 3),
              apiKey: secrets.githubToken(index + 5),
              notes: [`ping ${mail}`, 'ok'],
              count: index,
              flag: true,
              empty: null,
              host: `10.0.0.${index % 250}`,
            },
          }
        : {}),
    };
  });
  return CaseBundleSchema.parse({
    ...base,
    syntheticNotice: `Fictional. Contact jane.doe@real-company.com, ${secrets.githubToken(2)}`,
    case: {
      ...(base.case as object),
      title: 'Sign-in fails for jane.doe@real-company.com and others',
      product: 'Microsoft Teams',
      customerAlias: 'Contoso, 203.0.113.9',
      tags: ['synthetic', 'owner:jane.doe@real-company.com'],
    },
    participants: [
      { id: 'p-cust', role: 'customer_admin', alias: 'Admin jane.doe@real-company.com' },
      { id: 'p-eng', role: 'support_engineer', alias: 'Support Engineer 1' },
    ],
    events,
    resolution: {
      resolvedAt: '2026-05-06T09:00:00Z',
      summary: 'Fixed by user1@real-company.com after the resolver 10.20.1.5 was repaired.',
      rootCause: `The proxy at 203.0.113.50 sent ${secrets.githubToken(9)} upstream.`,
      workaround: 'Ask user2@real-company.com to retry.',
      permanentFix: 'Rotate the credential; see TKT-111111.',
      validation: {
        validatedAt: '2026-05-06T10:00:00Z',
        method: 'Checked by user3@real-company.com from 10.20.1.6',
        outcome: 'confirmed',
        evidenceEventIds: ['e01'],
      },
    },
  });
}

/** `[name, options, fewest replacements, fewest events with a replacement]` so no row compares nothing. */
const optionSets: [string, RedactionOptions, number, number][] = [
  [
    'a synthetic workspace (reserved values stay readable)',
    redactionOptionsFor(DEFAULT_REDACTION_CONFIG, true),
    300,
    100,
  ],
  [
    'real data (reserved values are redacted too)',
    redactionOptionsFor(DEFAULT_REDACTION_CONFIG, false),
    300,
    100,
  ],
  [
    'only the secret categories',
    redactionOptionsFor({ ...DEFAULT_REDACTION_CONFIG, enabledCategories: [] }, false),
    100,
    60,
  ],
  ['a tenant pattern on top', redactionOptionsFor(withPatterns(TICKETS), false), 300, 100],
];

describe('redactBundle equals field-by-field redaction, byte for byte', () => {
  it.each(optionSets)('%s', async (_name, options, replacements, events) => {
    const bundle = richBundle();
    const expected = referenceRedactBundle(bundle, options);
    const actual = await redactBundle(bundle, options, noPause);

    expect(canonicalJson(actual.bundle)).toBe(canonicalJson(expected.bundle));
    expect(actual.summary).toEqual(expected.summary);
    expect(actual.byEventId).toEqual(expected.byEventId);
    expect(actual.summary.totalReplacements).toBeGreaterThan(replacements);
    expect(Object.keys(actual.byEventId).length).toBeGreaterThan(events);
  });

  it('numbers the same address alike in every field and keeps the first-seen order', async () => {
    const bundle = richBundle();
    const redacted = (
      await redactBundle(bundle, redactionOptionsFor(DEFAULT_REDACTION_CONFIG, false), noPause)
    ).bundle;
    // jane.doe@ appears first in the case title: it is #1 everywhere (title, tag, alias, notice).
    expect(redacted.case.title).toContain('[REDACTED:email_address#1]');
    expect(redacted.case.tags[1]).toBe('owner:[REDACTED:email_address#1]');
    expect(redacted.participants[0]?.alias).toBe('Admin [REDACTED:email_address#1]');
    expect(redacted.syntheticNotice).toContain('[REDACTED:email_address#1]');
    expect(redacted.events[0]?.body).toContain('[REDACTED:email_address#2]');
  });

  it('keeps identifiers, the structure and the plain text exactly as they were', async () => {
    const bundle = richBundle();
    const redacted = (
      await redactBundle(bundle, redactionOptionsFor(DEFAULT_REDACTION_CONFIG, true), noPause)
    ).bundle;
    expect(redacted.case.reference).toBe(bundle.case.reference);
    expect(redacted.case.workload).toBe(bundle.case.workload);
    expect(redacted.events.map((event) => event.id)).toEqual(
      bundle.events.map((event) => event.id),
    );
    // Event 1 holds a private and a documentation address: both stay readable in a synthetic workspace.
    const body = redacted.events[1]?.body ?? '';
    expect(body).toContain('Message 1: contact [REDACTED:email_address#');
    expect(body).toContain('Resolver 10.20.1.1 and documentation host 203.0.113.1.');
    expect(body).toContain('nothing secret here');
    expect(redacted.events[8]?.structured?.count).toBe(8);
    expect(redacted.events[0]?.structured?.password).toBe('[REDACTED:password_assignment]');
    expect(bundle.events[0]?.structured?.password).not.toBe('[REDACTED:password_assignment]');
  });
});

describe('redactBundle asks the engine once (review H3)', () => {
  it('evaluates a tenant pattern once for the whole bundle, not once per field', async () => {
    const runs: number[] = [];
    const budget: CustomPatternBudget = {
      remainingMs: () => 3_000,
      consume: (ms) => void runs.push(ms),
    };
    const options: RedactionOptions = {
      ...redactionOptionsFor(withPatterns({ name: 'accounts', pattern: 'ACME0-[0-9]{6}' }), true),
      customPatternBudget: budget,
    };
    await redactBundle(richBundle(), options, noPause);
    // The bundle holds over a thousand strings; one pattern is one sandbox run over all of them.
    expect(runs).toHaveLength(1);
  });

  it('shares the request budget: what the bundle used is gone for the next call', async () => {
    const budget = createCustomPatternBudget(3_000);
    const options: RedactionOptions = {
      ...redactionOptionsFor(withPatterns(TICKETS), true),
      customPatternBudget: budget,
    };
    await redactBundle(richBundle(), options, noPause);
    expect(budget.remainingMs()).toBeLessThan(3_000);
  });
});

describe('redactBundle refuses what it could not redact completely (review H2)', () => {
  const lamp = 'sentinel-lamp-4471';
  const greedyBundle = (): CaseBundle =>
    CaseBundleSchema.parse(bundleOf({ body: `${'TKT-123456 '.repeat(1_001)}${lamp}` }));

  async function refusalOf(
    bundle: CaseBundle,
    options: RedactionOptions,
  ): Promise<RedactionIncompleteError> {
    try {
      await redactBundle(bundle, options, noPause);
    } catch (error) {
      if (error instanceof RedactionIncompleteError) return error;
      throw error;
    }
    throw new Error('the bundle was expected to be refused');
  }

  it('a pattern that matches too often: no result, and an error that names the pattern only', async () => {
    const error = await refusalOf(greedyBundle(), redactionOptionsFor(withPatterns(TICKETS), true));
    expect(error.status).toBe(422);
    expect(error.code).toBe('unsafe_content');
    expect(error.message).toBe(
      'The content could not be redacted completely: custom redaction pattern "ticket marks" could not be applied',
    );
    expect(error.failures).toMatchObject([{ code: 'match_limit', label: 'ticket marks' }]);
    const shown = JSON.stringify({ message: error.message, failures: error.failures });
    expect(shown).not.toContain(lamp);
    expect(shown).not.toContain('TKT-[0-9]');
  });

  it('a pattern that cannot be compiled is not skipped either', async () => {
    const error = await refusalOf(
      CaseBundleSchema.parse(bundleOf()),
      redactionOptionsFor(withPatterns({ name: 'broken', pattern: '(' }), true),
    );
    expect(error.failures).toMatchObject([{ code: 'invalid', label: 'broken' }]);
  });

  it('a request that has used up its time budget refuses instead of running unredacted', async () => {
    const options: RedactionOptions = {
      ...redactionOptionsFor(
        withPatterns(TICKETS, { name: 'accounts', pattern: 'ACME0-[0-9]{6}' }),
        true,
      ),
      customPatternBudget: createCustomPatternBudget(0),
    };
    const error = await refusalOf(CaseBundleSchema.parse(bundleOf()), options);
    expect(error.failures.map((failure) => failure.code)).toEqual([
      'budget_exhausted',
      'budget_exhausted',
    ]);
    expect(error.message).toBe(
      'The content could not be redacted completely: custom redaction pattern "ticket marks", "accounts" could not be applied',
    );
  });

  it('a bundle that no pattern fails on is redacted as before, whatever patterns are set', async () => {
    const options = redactionOptionsFor(withPatterns(TICKETS), true);
    const redacted = await redactBundle(
      CaseBundleSchema.parse(bundleOf({ body: 'Ticket TKT-123456 opened.' })),
      options,
      noPause,
    );
    expect(redacted.bundle.events[0]?.body).toBe('Ticket [REDACTED:custom] opened.');
    expect(redacted.byEventId.e01).toEqual({ redacted: true, categories: ['custom'] });
  });
});

describe('the reference and the workload are checked by the built-in rules only (review L2)', () => {
  it('ignores tenant patterns and does not spend the request budget on them', () => {
    const budget = createCustomPatternBudget(3_000);
    const options: RedactionOptions = {
      ...redactionOptionsFor(withPatterns({ name: 'ids', pattern: 'CG-[A-Z]+-[0-9]{4}' }), true),
      customPatternBudget: budget,
    };
    const bundle = CaseBundleSchema.parse(bundleOf({ reference: 'CG-ABC-1234' }));
    expect(credentialLikeIdentifiers(bundle, options)).toEqual([]);
    expect(budget.remainingMs()).toBe(3_000);
  });

  it('still refuses a credential-looking reference', () => {
    const bundle = CaseBundleSchema.parse(bundleOf({ reference: secrets.awsAccessKeyId() }));
    expect(
      credentialLikeIdentifiers(bundle, redactionOptionsFor(DEFAULT_REDACTION_CONFIG, true)),
    ).toMatchObject([{ path: 'case.reference', severity: 'error' }]);
  });
});
