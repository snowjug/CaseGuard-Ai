import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite, type Results, type Transaction } from '@electric-sql/pglite';
import { SET_APP_ROLE_SQL, SET_TENANT_SQL, assertTenantScope } from './driver-types';
import { describeFailure, mapDatabaseError } from './errors';
import { PGLITE_PARSERS, normalizeParams, normalizeRows } from './normalize';
import type { Database, QueryResult, SqlExecutor, TenantScope } from './repositories/types';

interface PgliteQueryable {
  query<T>(text: string, params?: unknown[]): Promise<Results<T>>;
  exec(text: string): Promise<Results[]>;
}

async function runPglite<T>(
  target: PgliteQueryable,
  text: string,
  params?: readonly unknown[],
): Promise<QueryResult<T>> {
  try {
    const values = normalizeParams(params);
    if (values) {
      const result = await target.query<T>(text, values);
      return {
        rows: normalizeRows<T>(result.rows),
        rowCount: result.rowCount ?? result.affectedRows ?? result.rows.length,
      };
    }
    // Parameterless statements use the simple protocol, which (like pg) accepts multi-statement
    // scripts such as migrations. The last statement's result is returned.
    const results = await target.exec(text);
    const last = results[results.length - 1];
    if (!last) return { rows: [], rowCount: 0 };
    return {
      rows: normalizeRows<T>(last.rows),
      rowCount: last.rowCount ?? last.affectedRows ?? last.rows.length,
    };
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

class PgliteExecutor implements SqlExecutor {
  constructor(private readonly target: PgliteQueryable) {}
  query<T = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<T>> {
    return runPglite<T>(this.target, text, params);
  }
}

/**
 * In-process PostgreSQL (WASM) for local development and tests. PGlite has ONE connection:
 * transactions are serialised by its internal mutex, and a statement issued on this object while a
 * transaction callback is running would wait for that transaction forever. That deadlock is turned
 * into an immediate, descriptive error; use the transaction-bound executor instead.
 *
 * A file-backed data directory must be opened by one process at a time.
 */
export class PgliteDatabase implements Database {
  readonly kind = 'pglite' as const;
  private readonly frames = new AsyncLocalStorage<{ active: boolean }>();

  private constructor(private readonly pglite: PGlite) {}

  /** `dataDir` null opens an in-memory database. */
  static async open(dataDir: string | null): Promise<PgliteDatabase> {
    if (dataDir !== null) await mkdir(resolve(dataDir), { recursive: true });
    const pglite = await PGlite.create(dataDir ?? 'memory://', { parsers: PGLITE_PARSERS });
    await pglite.exec("SET TIME ZONE 'UTC'");
    return new PgliteDatabase(pglite);
  }

  private assertNotReentrant(): void {
    if (this.frames.getStore()?.active) {
      throw new Error(
        'Re-entrant database call inside a PGlite transaction: use the transaction-bound executor ' +
          'passed to the callback (a second call would wait for the open transaction forever).',
      );
    }
  }

  async query<T = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<T>> {
    this.assertNotReentrant();
    return runPglite<T>(this.pglite, text, params);
  }

  async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    this.assertNotReentrant();
    const frame = { active: true };
    try {
      return await this.pglite.transaction((tx: Transaction) =>
        this.frames.run(frame, () => fn(new PgliteExecutor(tx))),
      );
    } catch (error) {
      throw mapDatabaseError(error);
    } finally {
      frame.active = false;
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
      await this.query('SELECT 1 AS ok');
      return {
        ok: true,
        latencyMs: Math.round((performance.now() - started) * 100) / 100,
        detail: 'PGlite (in-process PostgreSQL) reachable',
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Math.round((performance.now() - started) * 100) / 100,
        detail: describeFailure(error),
      };
    }
  }

  async close(): Promise<void> {
    if (!this.pglite.closed) await this.pglite.close();
  }
}
