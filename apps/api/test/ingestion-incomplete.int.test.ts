import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_REDACTION_CONFIG, type RedactionConfig } from '@caseguard/schemas';
import type { Database } from '../src/db';
import { TEST_DATABASE_STARTUP_TIMEOUT_MS } from '../src/db/testing';
import { bundleOf } from './ingestion-fixtures';
import {
  CREATE_FILE_URL,
  PREVIEW_FILE_URL,
  createCase,
  csvWith,
  leakSurface,
  openHarness,
  openWarmDatabase,
  previewCase,
  resetDatabase,
  storedObjects,
  uploadFile,
} from './ingestion-support';
import { CONTOSO, PERSONAS, type ApiResponse, type Harness } from './support/app-harness';

/*
 * A payload that a tenant's redaction pattern could not be applied to is only partly redacted, so it
 * must go nowhere (review H2): not into the case tables, the object store, the search, the audit trail
 * or the logs, and not back to the caller either. Once the pattern is fixed the same payload works.
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

const engineer = PERSONAS.engineer;
const KNOWN = 'zephyrquartz';
const LAMP = 'lanternmosaic';
const TICKETS: RedactionConfig = {
  ...DEFAULT_REDACTION_CONFIG,
  customPatterns: [{ name: 'ticket marks', pattern: 'TKT-[0-9]{6}' }],
};
const REFUSAL =
  'The content could not be redacted completely: custom redaction pattern "ticket marks" could not be applied';

/** One match more than the engine allows in one text. The marker word is in the title as well, because search reads titles. */
const tooMany = `${'TKT-123456 '.repeat(1_001)}${LAMP}`;
const bundleSource = (body: string, reference: string, title?: string) => ({
  type: 'bundle',
  bundle: bundleOf({ reference, body, ...(title === undefined ? {} : { title }) }),
});

async function configure(h: Harness, value: RedactionConfig, expectedVersion: number) {
  const repos = h.repos(CONTOSO);
  await repos.governance.getSettings();
  await repos.governance.updateSection('redaction', value, {
    expectedVersion,
    changeNote: 'test configuration',
    by: PERSONAS.admin,
  });
}

const search = (h: Harness, word: string): Promise<ApiResponse> =>
  h.call(engineer, { method: 'GET', url: `/api/v1/search?q=${word}` });

describe('a payload that cannot be redacted completely goes nowhere (review H2)', () => {
  it('is refused by the preview and by both ways of creating, and leaves no trace of it', async () => {
    const { h } = await openHarness(database, harnesses);
    await configure(h, TICKETS, 1);

    // A case that works, so the checks below can tell "found nothing" from "cannot find anything".
    const known = await createCase(
      h,
      engineer,
      bundleSource('Plain text.', 'CG-H2-1001', `Problem with ${KNOWN} sign-in`),
    );
    expect(known.statusCode).toBe(201);
    expect((await search(h, KNOWN)).data.items.length).toBeGreaterThan(0);

    const source = bundleSource(tooMany, 'CG-H2-1002', `Problem with ${LAMP} sign-in`);
    const preview = await previewCase(h, engineer, source);
    expect(preview.statusCode).toBe(200);
    expect(preview.data).toMatchObject({
      ok: false,
      summary: null,
      eventsPreview: [],
      redaction: { applied: false, totalReplacements: 0, findings: [] },
      alreadyIngestedCaseId: null,
    });
    expect(preview.data.issues[0]).toEqual({
      path: 'redaction',
      severity: 'error',
      message: REFUSAL,
    });

    const create = await createCase(h, engineer, source);
    expect(create.statusCode).toBe(422);
    expect(create.data).toMatchObject({ code: 'unsafe_content', status: 422, detail: REFUSAL });

    const csv = csvWith(tooMany);
    const previewFile = await uploadFile(
      h,
      engineer,
      PREVIEW_FILE_URL,
      'events.csv',
      csv,
      'text/csv',
    );
    expect(previewFile.statusCode).toBe(200);
    expect(previewFile.data).toMatchObject({ ok: false, summary: null, eventsPreview: [] });
    expect(previewFile.data.issues[0].message).toBe(REFUSAL);
    const createFile = await uploadFile(
      h,
      engineer,
      CREATE_FILE_URL,
      'events.csv',
      csv,
      'text/csv',
    );
    expect(createFile.statusCode).toBe(422);
    expect(createFile.data).toMatchObject({ code: 'unsafe_content', detail: REFUSAL });

    // Nothing of it came back...
    for (const res of [preview, create, previewFile, createFile]) {
      expect(res.body).not.toContain(LAMP);
      expect(res.body).not.toContain('TKT-123456');
      expect(res.body).not.toContain('TKT-[0-9]');
    }
    // ... and nothing was kept: no case, no stored payload, no audit of an ingest, nothing to search.
    expect((await h.repos(CONTOSO).cases.list({ limit: 10 })).items).toHaveLength(1);
    expect(storedObjects(h)).toHaveLength(1);
    const tables = await h.infra.database.query<{ n: number }>(
      'SELECT (SELECT count(*) FROM cases)::int + (SELECT count(*) FROM case_sources)::int + (SELECT count(*) FROM case_events)::int AS n',
    );
    expect(tables.rows[0]?.n).toBe(1 + 1 + 3);
    expect(
      (await h.repos(CONTOSO).audit.list({ action: 'case.ingested', limit: 100 })).items,
    ).toHaveLength(1);
    expect((await search(h, LAMP)).data.items).toEqual([]);

    // The audit trail and the logs name the pattern at most, never the payload or the pattern source.
    const audit = JSON.stringify((await h.repos(CONTOSO).audit.list({ limit: 200 })).items);
    const logs = JSON.stringify(h.logs());
    for (const surface of [audit, logs, await leakSurface(h)]) {
      expect(surface).not.toContain(LAMP);
      expect(surface).not.toContain('TKT-[0-9]');
    }
    const note = h.logs().find((line) => line.event === 'ingest.redaction_notes');
    expect(note).toMatchObject({ level: 'warn', refused: true });
    expect(note?.notes).toEqual([
      expect.stringContaining(
        'Custom redaction pattern "ticket marks" could not be applied (match_limit)',
      ),
    ]);
  });

  it('is accepted once the pattern is fixed, also under the same Idempotency-Key (the refusal is not replayed)', async () => {
    const { h } = await openHarness(database, harnesses);
    await configure(h, TICKETS, 1);
    const source = bundleSource(tooMany, 'CG-H2-2001', `Problem with ${LAMP} sign-in`);
    const headers = { 'idempotency-key': 'redaction-refusal-0001' };

    const refused = await createCase(h, engineer, source, undefined, headers);
    expect(refused.statusCode).toBe(422);
    expect(await h.infra.database.query('SELECT 1 FROM idempotency_keys')).toMatchObject({
      rowCount: 0,
    });

    // The administrator replaces the pattern by one that cannot match too often.
    await h.repos(CONTOSO).governance.updateSection(
      'redaction',
      {
        ...DEFAULT_REDACTION_CONFIG,
        customPatterns: [{ name: 'ticket marks', pattern: 'TKT-[0-9]{6}X' }],
      },
      { expectedVersion: 2, changeNote: 'a narrower pattern', by: PERSONAS.admin },
    );
    const accepted = await createCase(h, engineer, source, undefined, headers);
    expect(accepted.statusCode).toBe(201);
    expect(accepted.headers['idempotent-replayed']).toBeUndefined();
    expect(accepted.data.created).toBe(true);
    const [event] = await h.repos(CONTOSO).cases.getAllEvents(accepted.data.case.id);
    expect(event?.body).toContain(LAMP);
    expect((await search(h, LAMP)).data.items.length).toBeGreaterThan(0);
  });
});
