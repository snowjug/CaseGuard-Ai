import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/db';
import { TEST_DATABASE_STARTUP_TIMEOUT_MS } from '../src/db/testing';
import { referenceInUseMessage } from '../src/services/ingestion/reference';
import { bundleOf } from './ingestion-fixtures';
import {
  auditOf,
  createCase,
  openHarness,
  openWarmDatabase,
  resetDatabase,
  storedObjects,
  withStatementLog,
  type RecordedStatement,
} from './ingestion-support';
import { CONTOSO, PERSONAS, type ApiResponse, type Harness } from './support/app-harness';

/*
 * Creates that race for one reference (review L3). The exact lookup answers the check, and the unique
 * (tenant, reference) index of migration 0010 settles two requests that both passed it. Whoever loses
 * is told what the check would have told them: a 409 with the same problem, never a 500.
 *
 * The test database serialises transactions (one connection), so two requests cannot truly overlap
 * and the second one would always see the first. To reach the index anyway, the lookups the checks
 * make are answered as a request that read before the other committed would have seen them: no row.
 * Everything after that (the failing INSERT, its error, the rollback, the cleanup) is the real thing.
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

const REFERENCE = 'CG-RACE-1001';
const engineer = PERSONAS.engineer;

const withBody = (body: string) => ({
  type: 'bundle',
  bundle: bundleOf({ reference: REFERENCE, body }),
});

/** `CaseRepository.findByReference`: the exact lookup behind the check. */
const isReferenceLookup = (statement: RecordedStatement): boolean =>
  /FROM cases WHERE tenant_id = \$1 AND reference = \$2/.test(statement.sql) &&
  statement.params[1] === REFERENCE;
const isCaseInsert = (statement: RecordedStatement): boolean =>
  /^\s*INSERT INTO cases \(/.test(statement.sql);

/** Answers the next `times` reference lookups with no row. */
function staleReferenceReads(initial = 0) {
  let left = initial;
  let served = 0;
  return {
    isStale: (statement: RecordedStatement): boolean => {
      if (left === 0 || !isReferenceLookup(statement)) return false;
      left -= 1;
      served += 1;
      return true;
    },
    arm: (times: number): void => {
      left = times;
      served = 0;
    },
    served: (): number => served,
  };
}

const problemOf = (res: ApiResponse) => {
  const { type, title, status, detail } = res.data as Record<string, unknown>;
  return { type, title, status, detail };
};

describe('two creates for one new reference', () => {
  it.each([
    { name: 'the second request sees the first one (the check decides)', stale: 0, inserts: 1 },
    {
      name: 'neither sees the other when it checks (the unique index decides)',
      stale: 2,
      inserts: 2,
    },
  ])('answer one 201 and one 409, never a 500: $name', async ({ stale, inserts }) => {
    const reads = staleReferenceReads(stale);
    const log = withStatementLog(database, reads.isStale);
    const { h } = await openHarness(log, harnesses);

    const sent = await Promise.all([
      createCase(h, engineer, withBody('The first version.'), { analyze: false }),
      createCase(h, engineer, withBody('A second version.'), { analyze: false }),
    ]);

    expect(sent.map((res) => res.statusCode).sort()).toEqual([201, 409]);
    const loser = sent.find((res) => res.statusCode === 409);
    expect(loser?.data).toMatchObject({ status: 409, detail: referenceInUseMessage(REFERENCE) });
    // The index was reached exactly when the checks were made blind.
    expect(reads.served()).toBe(stale);
    expect(log.statements.filter(isCaseInsert)).toHaveLength(inserts);

    // One case, one stored payload, one audit row: the loser left nothing behind.
    expect((await h.repos(CONTOSO).cases.list({ limit: 10 })).items).toHaveLength(1);
    expect(storedObjects(h)).toHaveLength(1);
    expect(await auditOf(h, 'case.ingested')).toHaveLength(1);
    expect(h.logs().some((line) => line.event === 'ingest.orphaned_object')).toBe(false);
  });

  it('give the loser of the index the very problem that the check gives', async () => {
    const reads = staleReferenceReads();
    const log = withStatementLog(database, reads.isStale);
    const { h } = await openHarness(log, harnesses);

    const first = await createCase(h, engineer, withBody('The first version.'), { analyze: false });
    expect(first.statusCode).toBe(201);
    const byCheck = await createCase(h, engineer, withBody('A second version.'), {
      analyze: false,
    });
    expect(byCheck.statusCode).toBe(409);

    log.clear();
    reads.arm(1);
    const byIndex = await createCase(h, engineer, withBody('A third version.'), {
      analyze: false,
    });
    expect(byIndex.statusCode).toBe(409);
    expect(reads.served()).toBe(1);
    expect(log.statements.filter(isCaseInsert)).toHaveLength(1);

    expect(problemOf(byIndex)).toEqual(problemOf(byCheck));
    expect(problemOf(byCheck).detail).toBe(referenceInUseMessage(REFERENCE));
    expect(storedObjects(h)).toHaveLength(1);
    expect((await h.repos(CONTOSO).cases.list({ limit: 10 })).items).toHaveLength(1);
    expect(await auditOf(h, 'case.ingested')).toHaveLength(1);
  });
});
