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
 * Two plain requests do not always reach the index. PGlite serialises transactions (one
 * connection), so the second request sees the first one's case and the check answers. A real
 * PostgreSQL (TEST_DATABASE_URL) runs them in parallel: whether the second check comes before the
 * first commit is up to the timing, so one or two INSERTs are sent and the outcome is the same
 * either way. To reach the index every time, the lookups the checks make are answered as a request
 * that read before the other committed would have seen them: no row. Everything after that (the
 * failing INSERT, its error, the rollback, the cleanup) is the real thing.
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
    {
      name: 'the check, or the unique index when both checks come first, decides',
      stale: 0,
      // One INSERT when the second check sees the first request's case, two when it ran before that
      // commit: which one happens depends on the database and on the timing.
      inserts: [1, 2],
    },
    {
      name: 'neither sees the other when it checks (the unique index decides)',
      stale: 2,
      inserts: [2],
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
    expect(reads.served()).toBe(stale);
    // Both requests reach the INSERT when both checks were blind; otherwise it is up to the timing.
    expect(inserts).toContain(log.statements.filter(isCaseInsert).length);

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

/**
 * `parties` requests meet here: each `arrive()` waits until all have arrived, and every later one passes at once.
 * It gives up with a clear message instead of hanging, which is also what happens when the database cannot run the
 * requests at the same time.
 */
function rendezvous(parties: number, timeoutMs: number) {
  let arrived = 0;
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    arrive: async (): Promise<void> => {
      arrived += 1;
      if (arrived >= parties) open();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `only ${arrived} of ${parties} requests reached the check in ${timeoutMs} ms`,
              ),
            ),
          timeoutMs,
        );
      });
      try {
        await Promise.race([opened, late]);
      } finally {
        clearTimeout(timer);
      }
    },
    arrivals: (): number => arrived,
  };
}

/*
 * The same race, with nothing simulated. Each request runs its real lookup of the reference inside its own
 * transaction, on its own connection, and finds nothing, because neither has committed. They then wait for each
 * other at that point, so both are certain to INSERT and the unique index of migration 0010 has to choose. That
 * needs a database that runs two transactions at once, which PGlite (one connection) cannot: the meeting would
 * never complete. It runs against a real PostgreSQL (TEST_DATABASE_URL), as CI does.
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'two creates for one new reference on a real PostgreSQL',
  () => {
    it('both pass the check on their own connection and the unique index admits exactly one', async () => {
      const lookups: number[] = [];
      const meeting = rendezvous(2, 20_000);
      const log = withStatementLog(
        database,
        () => false,
        async (statement, rowCount) => {
          if (!isReferenceLookup(statement)) return;
          lookups.push(rowCount);
          await meeting.arrive();
        },
      );
      const { h } = await openHarness(log, harnesses);

      const sent = await Promise.all([
        createCase(h, engineer, withBody('The first version.'), { analyze: false }),
        createCase(h, engineer, withBody('A second version.'), { analyze: false }),
      ]);

      // Both lookups really ran, concurrently, and really found nothing.
      expect(meeting.arrivals()).toBeGreaterThanOrEqual(2);
      expect(lookups.slice(0, 2)).toEqual([0, 0]);
      // So both requests reached the INSERT: the index, not the check, decided.
      expect(log.statements.filter(isCaseInsert)).toHaveLength(2);
      expect(sent.map((res) => res.statusCode).sort()).toEqual([201, 409]);
      const loser = sent.find((res) => res.statusCode === 409);
      expect(loser?.data).toMatchObject({ status: 409, detail: referenceInUseMessage(REFERENCE) });

      // One case, one stored payload, one audit row: the loser left nothing behind.
      expect((await h.repos(CONTOSO).cases.list({ limit: 10 })).items).toHaveLength(1);
      expect(storedObjects(h)).toHaveLength(1);
      expect(await auditOf(h, 'case.ingested')).toHaveLength(1);
      expect(h.logs().some((line) => line.event === 'ingest.orphaned_object')).toBe(false);
    });
  },
);
