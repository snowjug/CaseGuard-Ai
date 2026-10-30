import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_REDACTION_CONFIG, type RedactionConfig } from '@caseguard/schemas';
import type { Database } from '../src/db';
import { TEST_DATABASE_STARTUP_TIMEOUT_MS } from '../src/db/testing';
import { bundleOf, transcriptOf } from './ingestion-fixtures';
import {
  auditOf,
  createCase,
  openHarness,
  openWarmDatabase,
  previewCase,
  resetDatabase,
  storedObjects,
} from './ingestion-support';
import { CONTOSO, FABRIKAM, PERSONAS, type ApiResponse, type Harness } from './support/app-harness';

/*
 * Preview must predict create. Every row previews a payload and then creates it, and the one rule
 * that holds for all of them is: a preview that says ok is never followed by a 409 or a 422, and a
 * preview that says it is not ok is always followed by one. Each row adds what it expects on top.
 */

let database: Database;
const harnesses: Harness[] = [];

beforeAll(async () => {
  database = await openWarmDatabase();
}, TEST_DATABASE_STARTUP_TIMEOUT_MS);

afterAll(async () => {
  for (const h of harnesses) await h.close();
  await database.close();
});

beforeEach(() => resetDatabase(database));

const DAY_MS = 24 * 3_600_000;

const bundleSource = (bundle: unknown): { type: 'bundle'; bundle: unknown } => ({
  type: 'bundle',
  bundle,
});

/** A copy of the bundle with one event patched (its position in the file, not its id). */
function withEvent(
  bundle: Record<string, unknown>,
  index: number,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const events = (bundle.events as Record<string, unknown>[]).map((event, position) =>
    position === index ? { ...event, ...patch } : event,
  );
  return { ...bundle, events };
}

/** Chat text whose stamps carry a time of day only: the day comes from the clock of the workspace. */
const TIME_ONLY_TEXT = [
  '[09:00] Customer: Our users cannot sign in to Teams since this morning.',
  '[09:05] Support Engineer: Could you share the error code shown on the sign-in screen?',
  '[09:07] Customer: It says AADSTS50076 and asks for MFA again and again.',
].join('\n');
const paste = (extra: Record<string, unknown> = {}) => ({
  type: 'paste',
  text: TIME_ONLY_TEXT,
  workload: 'teams-authentication',
  ...extra,
});

/** 28 short e-mail addresses: 195 characters in an action label (limit 200), far more once redacted. */
const MAILS_IN_A_LABEL = 'a@b.co '.repeat(28).trim();
/** 40 public addresses: about 360 characters in a structured value (limit 500), more once redacted. */
const IPS_IN_A_VALUE = Array.from({ length: 40 }, (_, index) => `8.8.${index}.${index}`).join(',');
/** 2,857 short e-mail addresses: 19,999 characters in a body (limit 20,000). */
const MAILS_IN_A_BODY = 'a@b.co '.repeat(2857);

/** A tenant pattern for ticket ids, and a text with one match more than the engine allows in one text. */
const withPatterns = (...patterns: { name: string; pattern: string }[]): RedactionConfig => ({
  ...DEFAULT_REDACTION_CONFIG,
  customPatterns: patterns,
});
const TICKET_PATTERNS = withPatterns({ name: 'ticket marks', pattern: 'TKT-[0-9]{6}' });
const BROKEN_PATTERNS = withPatterns({ name: 'broken', pattern: '(' });
const TOO_MANY_TICKETS = `${'TKT-123456 '.repeat(1_001)}and the end`;

interface Row {
  readonly name: string;
  /** Redaction settings of the workspace (tenant patterns); the default ones when omitted. */
  readonly redaction?: RedactionConfig;
  /** Payloads created before the one under test. */
  readonly before?: readonly unknown[];
  /** Days the workspace clock moves after `before` was created. */
  readonly days?: number;
  readonly source: unknown;
  readonly outcome: 'created' | 'replayed' | 'conflict' | 'refused';
  /** For `refused`: the field the error is about. */
  readonly field?: string;
  /**
   * For `refused`: how the create reports it. Validation failures list their fields in `errors`; a
   * security refusal (a redaction that could not be completed) is a problem whose `detail` is the
   * message of the preview's issue.
   */
  readonly reportedAs?: 'errors' | 'detail';
  /** Whether the created case must have another reference than the first one that was stored. */
  readonly newReference?: boolean;
}

const rows: readonly Row[] = [
  {
    name: 'a fresh payload',
    source: bundleSource(bundleOf({ reference: 'CG-PAR-1001' })),
    outcome: 'created',
  },
  {
    name: 'the same payload again (identical content)',
    before: [bundleSource(bundleOf({ reference: 'CG-PAR-1002' }))],
    source: bundleSource(bundleOf({ reference: 'CG-PAR-1002' })),
    outcome: 'replayed',
  },
  {
    name: 'a reference that a case with other content already uses',
    before: [bundleSource(bundleOf({ reference: 'CG-PAR-1003', body: 'The first version.' }))],
    source: bundleSource(bundleOf({ reference: 'CG-PAR-1003', body: 'A second version.' })),
    outcome: 'conflict',
  },
  {
    name: 'the same chat text again on the same day',
    before: [paste()],
    source: paste(),
    outcome: 'replayed',
  },
  {
    name: 'the same chat text the next day (the stamps have a new date)',
    before: [paste()],
    days: 1,
    source: paste(),
    outcome: 'created',
    newReference: true,
  },
  {
    name: 'the same chat text with another title',
    before: [paste({ title: 'Teams sign-in loop after MFA prompt' })],
    source: paste({ title: 'Teams sign-in loop, MFA asked repeatedly' }),
    outcome: 'created',
    newReference: true,
  },
  {
    name: 'redaction that pushes an action label past its limit',
    source: bundleSource(
      withEvent(bundleOf({ reference: 'CG-PAR-2001' }), 1, { action: { label: MAILS_IN_A_LABEL } }),
    ),
    outcome: 'refused',
    field: 'events[1].action.label',
  },
  {
    name: 'redaction that pushes a structured value past its limit',
    source: bundleSource(
      bundleOf({ reference: 'CG-PAR-2002', structured: { clientIps: IPS_IN_A_VALUE } }),
    ),
    outcome: 'refused',
    field: 'events[0].structured.clientIps',
  },
  {
    name: 'redaction that pushes an event body past its limit',
    source: bundleSource(bundleOf({ reference: 'CG-PAR-2003', body: MAILS_IN_A_BODY })),
    outcome: 'refused',
    field: 'events[0].body',
  },
  {
    name: 'text the parser cannot read',
    source: { type: 'paste', text: 'just some words without any structure' },
    outcome: 'refused',
  },
  {
    name: 'a tenant pattern that works',
    redaction: TICKET_PATTERNS,
    source: bundleSource(bundleOf({ reference: 'CG-PAR-6001', body: 'Ticket TKT-123456 opened.' })),
    outcome: 'created',
  },
  {
    name: 'a tenant pattern that matches too often to be applied (bundle)',
    redaction: TICKET_PATTERNS,
    source: bundleSource(bundleOf({ reference: 'CG-PAR-6002', body: TOO_MANY_TICKETS })),
    outcome: 'refused',
    field: 'redaction',
    reportedAs: 'detail',
  },
  {
    name: 'a tenant pattern that matches too often to be applied (pasted text)',
    redaction: TICKET_PATTERNS,
    source: { type: 'paste', text: transcriptOf([TOO_MANY_TICKETS, 'Please send two times.']) },
    outcome: 'refused',
    field: 'redaction',
    reportedAs: 'detail',
  },
  {
    name: 'a tenant pattern that cannot be compiled',
    redaction: BROKEN_PATTERNS,
    source: bundleSource(bundleOf({ reference: 'CG-PAR-6003' })),
    outcome: 'refused',
    field: 'redaction',
    reportedAs: 'detail',
  },
];

const engineer = PERSONAS.engineer;

describe('preview and create agree (review M2)', () => {
  it.each(rows)('$name', async (row) => {
    const { h } = await openHarness(database, harnesses);
    if (row.redaction !== undefined) {
      const repos = h.repos(CONTOSO);
      await repos.governance.getSettings();
      await repos.governance.updateSection('redaction', row.redaction, {
        expectedVersion: 1,
        changeNote: 'test configuration',
        by: PERSONAS.admin,
      });
    }
    const stored: ApiResponse[] = [];
    for (const source of row.before ?? []) {
      const response = await createCase(h, engineer, source, { analyze: false });
      expect(response.statusCode, 'arranging the workspace').toBeLessThan(300);
      stored.push(response);
    }
    if (row.days !== undefined) h.clock.advance(row.days * DAY_MS);

    const preview = await previewCase(h, engineer, row.source);
    const create = await createCase(h, engineer, row.source, { analyze: false });
    expect(preview.statusCode).toBe(200);

    // The rule that holds for every row.
    if (preview.data.ok === true) {
      expect(create.statusCode, JSON.stringify(create.data)).toBeLessThan(300);
    } else {
      expect([409, 422], JSON.stringify(create.data)).toContain(create.statusCode);
    }

    const issuePaths = (preview.data.issues as { path: string; severity: string }[])
      .filter((issue) => issue.severity === 'error')
      .map((issue) => issue.path);
    switch (row.outcome) {
      case 'created':
        expect(preview.data).toMatchObject({ ok: true, alreadyIngestedCaseId: null });
        expect(create.data.created).toBe(true);
        if (row.newReference === true) {
          expect(create.data.case.reference).not.toBe(stored[0]?.data.case.reference);
        }
        break;
      case 'replayed':
        expect(preview.data).toMatchObject({
          ok: true,
          alreadyIngestedCaseId: stored[0]?.data.case.id,
        });
        expect(create.data).toMatchObject({ created: false, analysisJob: null });
        expect(create.data.case.id).toBe(stored[0]?.data.case.id);
        break;
      case 'conflict': {
        expect(preview.data.ok).toBe(false);
        expect(preview.data.alreadyIngestedCaseId).toBeNull();
        expect(issuePaths).toEqual(['case.reference']);
        expect(create.statusCode).toBe(409);
        const message = (preview.data.issues as { message: string }[])[0]?.message;
        expect(create.data.detail).toBe(message);
        break;
      }
      case 'refused':
        expect(preview.data.ok).toBe(false);
        expect(create.statusCode).toBe(422);
        if (row.reportedAs === 'detail') {
          const [first] = preview.data.issues as { message: string }[];
          expect(create.data.code).toBe('unsafe_content');
          expect(create.data.detail).toBe(first?.message);
        }
        if (row.field !== undefined) expect(issuePaths).toContain(row.field);
        if (row.field !== undefined && row.reportedAs !== 'detail') {
          const reported = (create.data.errors as { path: string }[]).map((error) => error.path);
          expect(reported).toContain(row.field);
        }
        break;
    }
  });

  it('still describes the payload when its reference is taken, so the form can show it next to the error', async () => {
    const { h } = await openHarness(database, harnesses);
    await createCase(
      h,
      engineer,
      bundleSource(bundleOf({ reference: 'CG-PAR-3001', body: 'One.' })),
    );
    const preview = await previewCase(
      h,
      engineer,
      bundleSource(bundleOf({ reference: 'CG-PAR-3001', body: 'Two.', eventCount: 4 })),
    );
    expect(preview.data.ok).toBe(false);
    expect(preview.data.summary).toMatchObject({ reference: 'CG-PAR-3001', eventCount: 4 });
    expect(preview.data.eventsPreview).toHaveLength(4);
  });

  it('never counts a reference of another workspace as taken', async () => {
    const { h } = await openHarness(database, harnesses);
    const theirs = await createCase(
      h,
      PERSONAS.otherTenantEngineer,
      bundleSource(bundleOf({ reference: 'CG-PAR-4001', body: 'Another workspace.' })),
    );
    expect(theirs.statusCode).toBe(201);
    const source = bundleSource(bundleOf({ reference: 'CG-PAR-4001', body: 'This workspace.' }));
    const preview = await previewCase(h, engineer, source);
    expect(preview.data).toMatchObject({ ok: true, alreadyIngestedCaseId: null });
    expect((await createCase(h, engineer, source)).statusCode).toBe(201);
    expect((await h.repos(CONTOSO).cases.list({ limit: 10 })).items).toHaveLength(1);
    expect((await h.repos(FABRIKAM).cases.list({ limit: 10 })).items).toHaveLength(1);
  });

  it('writes nothing while it checks: no case, no object, no audit row', async () => {
    const { h } = await openHarness(database, harnesses);
    await createCase(
      h,
      engineer,
      bundleSource(bundleOf({ reference: 'CG-PAR-5001', body: 'One.' })),
    );
    expect(await auditOf(h, 'case.ingested')).toHaveLength(1);
    await previewCase(
      h,
      engineer,
      bundleSource(bundleOf({ reference: 'CG-PAR-5001', body: 'Two.' })),
    );
    expect((await h.repos(CONTOSO).cases.list({ limit: 10 })).items).toHaveLength(1);
    expect(await auditOf(h, 'case.ingested')).toHaveLength(1);
    expect(storedObjects(h)).toHaveLength(1);
  });
});
