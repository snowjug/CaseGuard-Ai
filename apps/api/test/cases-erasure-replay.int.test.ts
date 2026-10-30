import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/db';
import { TEST_DATABASE_STARTUP_TIMEOUT_MS } from '../src/db/testing';
import { findExample } from '../src/samples';
import {
  CREATE_FILE_URL,
  FOLLOWUP_SOURCE,
  SAMPLE_SOURCE,
  createCase,
  openHarness,
  openWarmDatabase,
  resetDatabase,
  uploadFile,
} from './ingestion-support';
import { PERSONAS, type ApiResponse, type Harness } from './support/app-harness';

/*
 * A stored idempotent response carries the case summary (and the job) of an ingest, for 24 hours, so
 * that a retry can replay it. Erasing a case must erase those responses too (review M3): a retry with
 * the same key and body may never hand back a case that no longer exists. The data tier does it inside
 * CaseRepository.delete; these tests go through the HTTP routes and look at the table itself.
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
const csv = findExample('events-teams-signin-proxy')?.text ?? '';

const remove = (h: Harness, caseId: string): Promise<ApiResponse> =>
  h.call(PERSONAS.admin, { method: 'DELETE', url: `/api/v1/cases/${caseId}` });
const read = (h: Harness, caseId: string): Promise<ApiResponse> =>
  h.call(engineer, { method: 'GET', url: `/api/v1/cases/${caseId}` });

/** Every row of the idempotency table, every column, whatever the tenant. */
async function keyRows(h: Harness): Promise<Record<string, unknown>[]> {
  const result = await h.infra.database.query('SELECT * FROM idempotency_keys ORDER BY created_at');
  return result.rows;
}
const text = (rows: unknown): string => JSON.stringify(rows);

const withKey = (key: string): Record<string, string> => ({ 'idempotency-key': key });

const creations: {
  name: string;
  send: (h: Harness, persona: string, key: string) => Promise<ApiResponse>;
}[] = [
  {
    name: 'cases.create (JSON body, analysis started)',
    send: (h, persona, key) => createCase(h, persona, SAMPLE_SOURCE, undefined, withKey(key)),
  },
  {
    name: 'cases.createFromFile (CSV upload)',
    send: (h, persona, key) =>
      uploadFile(h, persona, CREATE_FILE_URL, 'events.csv', csv, 'text/csv', withKey(key)),
  },
];

describe('erasing a case erases what an Idempotency-Key could replay of it (review M3)', () => {
  it.each(creations)(
    '$name: a retry with the same key and body after the erasure is a new create',
    async ({ send }) => {
      const { h } = await openHarness(database, harnesses);
      const key = 'erase-replay-key-0001';

      const first = await send(h, engineer, key);
      expect(first.statusCode).toBe(201);
      const erased: string = first.data.case.id;

      // While the case exists the key replays it, and the table holds the response that describes it.
      const replay = await send(h, engineer, key);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.data.case.id).toBe(erased);
      const stored = await keyRows(h);
      expect(stored).toHaveLength(1);
      expect(text(stored)).toContain(erased);

      expect((await remove(h, erased)).statusCode).toBe(200);
      expect((await read(h, erased)).statusCode).toBe(404);

      // No column of any row still names the erased case: the response went with it.
      expect(text(await keyRows(h))).not.toContain(erased);
      expect(await keyRows(h)).toEqual([]);

      // The retry is not a replay: the key is free, the payload is stored again as a new case.
      const retry = await send(h, engineer, key);
      expect(retry.statusCode).toBe(201);
      expect(retry.headers['idempotent-replayed']).toBeUndefined();
      expect(retry.data.created).toBe(true);
      expect(retry.data.case.id).not.toBe(erased);
      expect((await read(h, erased)).statusCode).toBe(404);
      expect((await read(h, retry.data.case.id)).statusCode).toBe(200);

      // And the table now describes the new case only.
      const after = text(await keyRows(h));
      expect(after).toContain(retry.data.case.id);
      expect(after).not.toContain(erased);
    },
  );

  it('removes only the responses about the erased case: other cases and other workspaces keep replaying', async () => {
    const { h } = await openHarness(database, harnesses);
    const one = await createCase(
      h,
      engineer,
      SAMPLE_SOURCE,
      undefined,
      withKey('erase-key-one-0001'),
    );
    const two = await createCase(
      h,
      engineer,
      FOLLOWUP_SOURCE,
      undefined,
      withKey('erase-key-two-0001'),
    );
    // The same key text in another workspace is another key.
    const theirs = await createCase(
      h,
      PERSONAS.otherTenantEngineer,
      SAMPLE_SOURCE,
      undefined,
      withKey('erase-key-one-0001'),
    );
    expect([one, two, theirs].map((res) => res.statusCode)).toEqual([201, 201, 201]);
    expect(await keyRows(h)).toHaveLength(3);

    expect((await remove(h, one.data.case.id)).statusCode).toBe(200);

    const left = text(await keyRows(h));
    expect(await keyRows(h)).toHaveLength(2);
    expect(left).not.toContain(one.data.case.id);
    expect(left).toContain(two.data.case.id);
    expect(left).toContain(theirs.data.case.id);

    const replayTwo = await createCase(
      h,
      engineer,
      FOLLOWUP_SOURCE,
      undefined,
      withKey('erase-key-two-0001'),
    );
    expect(replayTwo.headers['idempotent-replayed']).toBe('true');
    expect(replayTwo.data.case.id).toBe(two.data.case.id);
    const replayTheirs = await createCase(
      h,
      PERSONAS.otherTenantEngineer,
      SAMPLE_SOURCE,
      undefined,
      withKey('erase-key-one-0001'),
    );
    expect(replayTheirs.headers['idempotent-replayed']).toBe('true');
    expect(replayTheirs.data.case.id).toBe(theirs.data.case.id);
  });
});
