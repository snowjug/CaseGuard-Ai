import { randomBytes } from 'node:crypto';
import { createDatabase } from './client';
import type { IdGenerator } from './ids';
import { migrate } from './migrate';
import { createPgDatabase } from './pg-database';
import { createRepositories, type RepositoryDeps } from './repositories';
import { CONTOSO_TENANT_ID, FABRIKAM_TENANT_ID, seedFoundation } from './seed';
import type {
  Database,
  QueryResult,
  Repositories,
  SqlExecutor,
  TenantRepositories,
  TenantScope,
} from './repositories/types';

/** Test utilities for the data tier (used by this package's tests and by API integration tests). */

export const CONTOSO_SCOPE: TenantScope = {
  tenantId: CONTOSO_TENANT_ID,
  actorId: 'user_ava_engineer',
};
export const FABRIKAM_SCOPE: TenantScope = {
  tenantId: FABRIKAM_TENANT_ID,
  actorId: 'user_fabi_engineer',
};

/** True when the suite should run against a real PostgreSQL named by TEST_DATABASE_URL. */
export function usesRealPostgres(): boolean {
  return Boolean(process.env.TEST_DATABASE_URL);
}

/**
 * Hook timeout for the `beforeAll` that opens a test database. A cold PGlite takes several seconds
 * and much longer when many test files start theirs at once (or the data directory is on a slow,
 * synced disk), so the runner's default is too tight to rely on.
 */
export const TEST_DATABASE_STARTUP_TIMEOUT_MS = 180_000;

/** Wraps a database so that closing it also runs an extra cleanup (dropping a test schema). */
function withCleanup(database: Database, cleanup: () => Promise<void>): Database {
  return {
    kind: database.kind,
    query: (text, params) => database.query(text, params),
    transaction: (fn) => database.transaction(fn),
    withTenant: (scope, fn) => database.withTenant(scope, fn),
    ping: () => database.ping(),
    close: async () => {
      await database.close();
      await cleanup();
    },
  };
}

/**
 * Real-PostgreSQL mode (TEST_DATABASE_URL): every call gets a private schema so test files can run in
 * parallel against one server. The connecting role needs CREATEROLE (for caseguard_app) and must own
 * the schema it creates. This path is NOT exercised in the sandbox this was written in.
 */
async function openRealPostgres(url: string): Promise<Database> {
  const schema = `cg_test_${randomBytes(6).toString('hex')}`;
  const admin = await createPgDatabase(url, { url, poolMax: 1 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const database = await createPgDatabase(url, { url, schema, poolMax: 5 });
  return withCleanup(database, async () => {
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.close();
  });
}

export interface TestDatabaseOptions {
  /** Seed tenants, users and governance defaults (default true). */
  seed?: boolean;
  /** Apply migrations (default true). */
  migrate?: boolean;
}

/**
 * A fresh database for one test file: in-memory PGlite (or a private schema on TEST_DATABASE_URL)
 * with migrations applied and the foundation seeded.
 */
export async function createTestDatabase(options: TestDatabaseOptions = {}): Promise<Database> {
  const url = process.env.TEST_DATABASE_URL;
  const database = url
    ? await openRealPostgres(url)
    : await createDatabase({ url: 'pglite://memory' });
  try {
    if (options.migrate ?? true) await migrate(database);
    if ((options.seed ?? true) && (options.migrate ?? true)) await seedFoundation(database);
    return database;
  } catch (error) {
    await database.close();
    throw error;
  }
}

/**
 * Empties every table (keeping the schema, roles and migration history) and re-seeds the foundation,
 * so a file can reuse one database across tests. TRUNCATE ... CASCADE bypasses row triggers and RLS
 * and needs the owner connection that `createTestDatabase` returns.
 */
export async function resetTestDatabase(database: Database): Promise<void> {
  await database.query('TRUNCATE tenants CASCADE');
  await seedFoundation(database);
}

/** Deterministic millisecond clock. Each read can advance time by `stepMs`. */
export class TestClock {
  private current: number;
  constructor(
    start = '2026-01-15T09:00:00.000Z',
    private readonly stepMs = 0,
  ) {
    this.current = Date.parse(start);
  }

  readonly now = (): Date => {
    const value = new Date(this.current);
    this.current += this.stepMs;
    return value;
  };

  set(iso: string): void {
    this.current = Date.parse(iso);
  }

  advance(ms: number): Date {
    this.current += ms;
    return new Date(this.current);
  }
}

/** `<prefix>_<26 digits>` ids that are valid generated ids and fully predictable. */
export function createSequentialIdGenerator(start = 1): IdGenerator {
  let counter = start;
  return (prefix) => {
    const value = counter;
    counter += 1;
    return `${prefix}_${String(value).padStart(26, '0')}`;
  };
}

export interface TestHarness {
  database: Database;
  repositories: Repositories;
  clock: TestClock;
  newId: IdGenerator;
  /** Repositories scoped to the seeded Contoso engineer (Ava). */
  contoso: () => TenantRepositories;
  /** Repositories scoped to the seeded Fabrikam engineer (Fabi): the other tenant. */
  fabrikam: () => TenantRepositories;
  reset: () => Promise<void>;
  close: () => Promise<void>;
}

/** Database + repositories with an injected clock and sequential ids. */
export async function createTestRepositories(
  options: TestDatabaseOptions & {
    deps?: RepositoryDeps;
    clockStepMs?: number;
    database?: Database;
  } = {},
): Promise<TestHarness> {
  const database = options.database ?? (await createTestDatabase(options));
  const clock = new TestClock('2026-01-15T09:00:00.000Z', options.clockStepMs ?? 0);
  const newId = createSequentialIdGenerator();
  const repositories = createRepositories(database, {
    now: clock.now,
    newId,
    ...options.deps,
  });
  return {
    database,
    repositories,
    clock,
    newId,
    contoso: () => repositories.forTenant(CONTOSO_SCOPE),
    fabrikam: () => repositories.forTenant(FABRIKAM_SCOPE),
    reset: () => resetTestDatabase(database),
    close: () => database.close(),
  };
}

export interface FaultInjection {
  /** Statements whose SQL matches are counted; the (after + 1)-th one fails. */
  match: RegExp;
  /** Number of matching statements allowed to succeed first (default 0). */
  after?: number;
  error?: Error;
}

export interface FaultInjectingDatabase extends Database {
  /** Starts counting and failing according to the rule. */
  arm(rule: FaultInjection): void;
  disarm(): void;
}

/**
 * Decorates a database so a chosen statement fails mid-transaction. Used to prove that multi-step
 * writes are atomic: nothing may be persisted when a later statement of the same unit of work fails.
 */
export function withFaultInjection(database: Database): FaultInjectingDatabase {
  let rule: FaultInjection | null = null;
  let seen = 0;

  const guard = (executor: SqlExecutor): SqlExecutor => ({
    async query<T = Record<string, unknown>>(
      text: string,
      params?: readonly unknown[],
    ): Promise<QueryResult<T>> {
      if (rule?.match.test(text)) {
        seen += 1;
        if (seen > (rule.after ?? 0)) throw rule.error ?? new Error('injected failure');
      }
      return executor.query<T>(text, params);
    },
  });

  return {
    kind: database.kind,
    query: (text, params) => guard(database).query(text, params),
    transaction: (fn) => database.transaction((tx) => fn(guard(tx))),
    withTenant: (scope, fn) => database.withTenant(scope, (tx) => fn(guard(tx))),
    ping: () => database.ping(),
    close: () => database.close(),
    arm(next: FaultInjection) {
      rule = next;
      seen = 0;
    },
    disarm() {
      rule = null;
      seen = 0;
    },
  };
}
