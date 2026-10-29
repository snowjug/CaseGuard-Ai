import { Pool, types as pgTypes, type CustomTypesConfig, type PoolConfig } from 'pg';
import {
  SET_APP_ROLE_SQL,
  SET_TENANT_SQL,
  assertTenantScope,
  type DatabaseOptions,
  type DbLogger,
} from './driver-types';
import { createDefaultEntraTokenSource, createEntraPasswordProvider } from './entra';
import { describeFailure, mapDatabaseError } from './errors';
import {
  PG_OID,
  normalizeParams,
  normalizeRows,
  parseInt8,
  parseNumeric,
  parseTimestamptz,
} from './normalize';
import type { Database, QueryResult, SqlExecutor, TenantScope } from './repositories/types';

/** The slice of a pg client the data tier uses; lets tests drive PgDatabase without a server. */
export interface PgClientLike {
  query(text: string, values?: unknown[]): Promise<unknown>;
  release(error?: Error): void;
}

export interface PgPoolLike {
  query(text: string, values?: unknown[]): Promise<unknown>;
  connect(): Promise<PgClientLike>;
  end(): Promise<void>;
  onError(listener: (error: Error) => void): void;
}

type Queryable = { query(text: string, values?: unknown[]): Promise<unknown> };

interface ResultLike {
  rows: readonly unknown[];
  rowCount?: number | null;
}

function isResultLike(value: unknown): value is ResultLike {
  return typeof value === 'object' && value !== null && Array.isArray((value as ResultLike).rows);
}

/** Simple-protocol multi-statement queries return one result per statement; the last one wins. */
function toQueryResult<T>(raw: unknown): QueryResult<T> {
  const result: unknown = Array.isArray(raw) ? raw[raw.length - 1] : raw;
  if (!isResultLike(result)) return { rows: [], rowCount: 0 };
  const rows = normalizeRows<T>(result.rows);
  return { rows, rowCount: typeof result.rowCount === 'number' ? result.rowCount : rows.length };
}

async function runQuery<T>(
  target: Queryable,
  text: string,
  params?: readonly unknown[],
): Promise<QueryResult<T>> {
  try {
    const values = normalizeParams(params);
    // Without parameters pg uses the simple protocol, which also allows multi-statement scripts.
    const raw = values ? await target.query(text, values) : await target.query(text);
    return toQueryResult<T>(raw);
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

class PgExecutor implements SqlExecutor {
  constructor(private readonly client: Queryable) {}
  query<T = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<T>> {
    return runQuery<T>(this.client, text, params);
  }
}

/**
 * PostgreSQL through a `pg` pool. Each `transaction` pins one pooled connection; `withTenant` adds
 * `SET LOCAL ROLE caseguard_app` plus the `app.tenant_id` setting so row-level security applies.
 *
 * The connecting role must be a member of `caseguard_app` and must NOT be a superuser (superusers
 * bypass row-level security entirely, including FORCE ROW LEVEL SECURITY).
 */
export class PgDatabase implements Database {
  readonly kind = 'pg' as const;
  private lastPoolError: string | null = null;

  constructor(
    private readonly pool: PgPoolLike,
    private readonly logger?: DbLogger,
  ) {
    pool.onError((error) => {
      // Idle clients emit 'error' when the server drops them; the pool replaces them on demand.
      this.lastPoolError = describeFailure(error);
      this.logger?.warn('PostgreSQL pool reported an error on an idle connection', {
        reason: this.lastPoolError,
      });
    });
  }

  query<T = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<T>> {
    return runQuery<T>(this.pool, text, params);
  }

  async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    let client: PgClientLike;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw mapDatabaseError(error);
    }
    let discard: Error | undefined;
    try {
      await runQuery(client, 'BEGIN');
      const result = await fn(new PgExecutor(client));
      await runQuery(client, 'COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        // The connection is in an unknown state: destroy it instead of returning it to the pool.
        discard = rollbackError instanceof Error ? rollbackError : new Error('ROLLBACK failed');
        this.logger?.warn('ROLLBACK failed; the connection was discarded', {
          reason: describeFailure(rollbackError),
        });
      }
      throw mapDatabaseError(error);
    } finally {
      client.release(discard);
    }
  }

  async withTenant<T>(scope: TenantScope, fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    assertTenantScope(scope);
    return this.transaction(async (tx) => {
      await tx.query(SET_APP_ROLE_SQL);
      await tx.query(SET_TENANT_SQL, [scope.tenantId]);
      return fn(tx);
    });
  }

  async ping(): Promise<{ ok: boolean; latencyMs: number; detail: string }> {
    const started = performance.now();
    try {
      await runQuery(this.pool, 'SELECT 1 AS ok');
      return { ok: true, latencyMs: elapsed(started), detail: 'PostgreSQL reachable' };
    } catch (error) {
      const detail = this.lastPoolError
        ? `${describeFailure(error)}; last pool error: ${this.lastPoolError}`
        : describeFailure(error);
      return { ok: false, latencyMs: elapsed(started), detail };
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function elapsed(started: number): number {
  return Math.round((performance.now() - started) * 100) / 100;
}

/** pg-types' own parser for an OID (typed loosely by its declarations, hence the assertion). */
function defaultParser(oid: number, format: 'text' | 'binary'): (value: never) => unknown {
  return pgTypes.getTypeParser(oid, format === 'binary' ? 'binary' : 'text') as (
    value: never,
  ) => unknown;
}

/** Applies the shared type normalisation so rows look the same as PGlite's. */
export const PG_TYPE_OVERRIDES: CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') => {
    if (format !== 'binary') {
      if (oid === PG_OID.timestamptz) return parseTimestamptz;
      if (oid === PG_OID.int8) return parseInt8;
      if (oid === PG_OID.numeric) return parseNumeric;
    }
    return defaultParser(oid, format ?? 'text');
  }) as CustomTypesConfig['getTypeParser'],
};

const SCHEMA_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/** Opens a pg pool. Connections are lazy: nothing is dialled until the first query. */
export async function createPgDatabase(
  connectionString: string,
  options: DatabaseOptions,
): Promise<PgDatabase> {
  if (options.schema !== undefined && !SCHEMA_NAME.test(options.schema)) {
    throw new TypeError('Invalid schema name for the database connection');
  }
  const password =
    options.auth === 'entra'
      ? (options.tokenProvider ??
        createEntraPasswordProvider(await createDefaultEntraTokenSource()))
      : undefined;
  const statementTimeout = options.statementTimeoutMs ?? 30_000;
  const config: PoolConfig = {
    connectionString,
    max: options.poolMax ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: options.applicationName ?? 'caseguard-api',
    statement_timeout: statementTimeout > 0 ? statementTimeout : false,
    types: PG_TYPE_OVERRIDES,
    ...(password ? { password } : {}),
  };
  const pool = new Pool(config);
  const sessionSettings = [
    "SET TIME ZONE 'UTC'",
    ...(options.schema ? [`SET search_path TO "${options.schema}"`] : []),
  ];
  pool.on('connect', (client) => {
    // Session settings are applied per connection rather than as startup options, which
    // connection poolers such as PgBouncer reject.
    for (const statement of sessionSettings) {
      client.query(statement).catch((error: unknown) => {
        options.logger?.warn('Could not apply a PostgreSQL session setting', {
          reason: describeFailure(error),
        });
      });
    }
  });
  const adapter: PgPoolLike = {
    query: (text, values) => pool.query(text, values),
    async connect() {
      const client = await pool.connect();
      return {
        query: (text, values) => client.query(text, values),
        release: (error) => {
          client.release(error);
        },
      };
    },
    end: () => pool.end(),
    onError: (listener) => {
      pool.on('error', listener);
    },
  };
  return new PgDatabase(adapter, options.logger);
}
