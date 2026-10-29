import { IsoTimestampSchema } from '@caseguard/schemas';
import type { z } from 'zod';
import { NotFoundError, ValidationFailedError, VersionConflictError } from '../../errors';
import { DataIntegrityError, TenantViolationError } from '../errors';
import { toJsonParam } from '../normalize';
import type { SqlExecutor, TenantScope } from './types';

/** Runs a unit of work on one connection: its own transaction, or the enclosing one when bound. */
export type Run = <T>(fn: (tx: SqlExecutor) => Promise<T>) => Promise<T>;

export interface RepoContext {
  readonly scope: TenantScope;
  readonly kind: 'pg' | 'pglite';
  readonly run: Run;
  readonly now: () => Date;
  readonly newId: (prefix: string) => string;
  readonly idempotency: { readonly ttlMs: number; readonly reservationTtlMs: number };
}

export function nowIso(ctx: RepoContext): string {
  return ctx.now().toISOString();
}

function issuesOf(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((segment) => String(segment)).join('.'),
    message: issue.message,
  }));
}

/** Validates data read from the database; failure is an internal error and nothing is returned. */
export function parseStored<S extends z.ZodType>(
  schema: S,
  value: unknown,
  what: string,
): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new DataIntegrityError(what, issuesOf(result.error));
  return result.data;
}

/** Validates data about to be written; failure is reported to the caller as a validation error. */
export function validateInput<S extends z.ZodType>(
  schema: S,
  value: unknown,
  what: string,
): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationFailedError(`Invalid ${what}`, issuesOf(result.error));
  }
  return result.data;
}

/** Defence in depth on top of RLS: a write must carry the tenant the repositories are scoped to. */
export function assertTenant(ctx: RepoContext, tenantId: string): void {
  if (tenantId !== ctx.scope.tenantId) throw new TenantViolationError();
}

/** Validates an `asOf`/range instant and normalises it to millisecond precision. */
export function normalizeInstant(value: string, field: string): string {
  const parsed = IsoTimestampSchema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationFailedError(`${field} must be a UTC ISO-8601 timestamp`, [
      { path: field, message: 'Expected a UTC ISO-8601 timestamp such as 2024-05-01T09:30:00Z' },
    ]);
  }
  return new Date(value).toISOString();
}

/** Millisecond-precision UTC form of an already validated timestamp. */
export function ts(value: string): string {
  return new Date(value).toISOString();
}

export function tsOrNull(value: string | null | undefined): string | null {
  return value === null || value === undefined ? null : ts(value);
}

export function requireFound<T>(value: T | null | undefined, what: string, id: string): T {
  if (value === null || value === undefined) throw new NotFoundError(what, id);
  return value;
}

/** Incrementally builds a parameterised WHERE clause; values never reach the SQL text. */
export class QueryBuilder {
  readonly params: unknown[] = [];
  private readonly conditions: string[] = [];

  /** Registers a bind parameter and returns its placeholder (`$n`). */
  bind(value: unknown): string {
    this.params.push(value);
    return `$${this.params.length}`;
  }

  /** Adds a condition; build it with the placeholders returned by `bind`. */
  where(condition: string): this {
    this.conditions.push(condition);
    return this;
  }

  get clause(): string {
    return this.conditions.length > 0 ? this.conditions.join(' AND ') : 'TRUE';
  }
}

// ------------------------------------------------------------------ table specs and bulk writes

export type PgType = 'text' | 'int' | 'float8' | 'bool' | 'timestamptz' | 'jsonb' | 'text[]';

const CAST: Record<PgType, string> = {
  text: 'text',
  int: 'integer',
  float8: 'double precision',
  bool: 'boolean',
  timestamptz: 'timestamptz',
  jsonb: 'jsonb',
  'text[]': 'text[]',
};

export interface ColumnSpec<T> {
  readonly name: string;
  readonly type: PgType;
  readonly get: (row: T) => unknown;
}

/** One table: the primary-key columns and how to project an entity onto every column. */
export interface TableSpec<T> {
  readonly table: string;
  readonly key: readonly string[];
  readonly columns: readonly ColumnSpec<T>[];
}

export function col<T>(name: string, type: PgType, get: (row: T) => unknown): ColumnSpec<T> {
  return { name, type, get };
}

/** PostgreSQL allows 65 535 bind parameters per statement; stay far below it. */
const MAX_PARAMS_PER_STATEMENT = 20_000;

function encode(type: PgType, value: unknown): unknown {
  return type === 'jsonb' ? toJsonParam(value) : value;
}

/** Multi-row INSERT (optionally upserting or ignoring conflicts), chunked below the parameter limit. Returns the rows written. */
export async function insertRows<T>(
  tx: SqlExecutor,
  spec: TableSpec<T>,
  rows: readonly T[],
  mode: 'insert' | 'upsert' | 'ignore' = 'insert',
): Promise<number> {
  if (rows.length === 0) return 0;
  const names = spec.columns.map((column) => column.name).join(', ');
  const rowsPerStatement = Math.max(1, Math.floor(MAX_PARAMS_PER_STATEMENT / spec.columns.length));
  const updatable = spec.columns.filter((column) => !spec.key.includes(column.name));
  let conflict = '';
  if (mode === 'upsert') {
    const assignments = updatable.map((column) => `${column.name} = EXCLUDED.${column.name}`);
    conflict = ` ON CONFLICT (${spec.key.join(', ')}) DO UPDATE SET ${assignments.join(', ')}`;
  } else if (mode === 'ignore') {
    conflict = ` ON CONFLICT (${spec.key.join(', ')}) DO NOTHING`;
  }
  let written = 0;
  for (let offset = 0; offset < rows.length; offset += rowsPerStatement) {
    const params: unknown[] = [];
    const tuples = rows.slice(offset, offset + rowsPerStatement).map((row) => {
      const placeholders = spec.columns.map((column) => {
        params.push(encode(column.type, column.get(row)));
        return `$${params.length}::${CAST[column.type]}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    const result = await tx.query(
      `INSERT INTO ${spec.table} (${names}) VALUES ${tuples.join(', ')}${conflict}`,
      params,
    );
    written += result.rowCount;
  }
  return written;
}

/**
 * Rewrites one row identified by its primary key. `columns` limits the SET list (default: every
 * non-key column). With `expectedVersion` the update only applies while the stored version matches.
 * Returns the number of rows changed.
 */
export async function updateRow<T>(
  tx: SqlExecutor,
  spec: TableSpec<T>,
  row: T,
  options: { columns?: readonly string[]; expectedVersion?: number } = {},
): Promise<number> {
  const params: unknown[] = [];
  const bind = (column: ColumnSpec<T>): string => {
    params.push(encode(column.type, column.get(row)));
    return `$${params.length}::${CAST[column.type]}`;
  };
  const settable = spec.columns.filter((column) =>
    options.columns ? options.columns.includes(column.name) : !spec.key.includes(column.name),
  );
  const assignments = settable.map((column) => `${column.name} = ${bind(column)}`);
  const keyConditions = spec.key.map((name) => {
    const column = spec.columns.find((candidate) => candidate.name === name);
    if (!column) throw new Error(`Key column ${name} is not part of table spec ${spec.table}`);
    return `${name} = ${bind(column)}`;
  });
  if (options.expectedVersion !== undefined) {
    params.push(options.expectedVersion);
    keyConditions.push(`version = $${params.length}::integer`);
  }
  const result = await tx.query(
    `UPDATE ${spec.table} SET ${assignments.join(', ')} WHERE ${keyConditions.join(' AND ')}`,
    params,
  );
  return result.rowCount;
}

/** Takes the row lock that serialises writers of one case; false when the case does not exist. */
export async function lockCase(
  tx: SqlExecutor,
  tenantId: string,
  caseId: string,
): Promise<boolean> {
  const result = await tx.query(
    'SELECT 1 AS locked FROM cases WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
    [tenantId, caseId],
  );
  return result.rows.length > 0;
}

/**
 * Opts the surrounding transaction into the erasure path of the immutability triggers for the
 * duration of `fn` only. If `fn` fails the transaction aborts and the setting is discarded with it.
 */
export async function withErasure<T>(tx: SqlExecutor, fn: () => Promise<T>): Promise<T> {
  await tx.query("SELECT set_config('app.allow_erasure', 'on', true)");
  const result = await fn();
  await tx.query("SELECT set_config('app.allow_erasure', 'off', true)");
  return result;
}

export interface DataRow {
  data: unknown;
}

export const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

/** Text that comes from outside the system: control characters and whitespace runs become one space. */
export function cleanText(value: string): string {
  return value
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cuts `value` to at most `max` characters, ending in an ellipsis when something was removed. */
export function clipText(value: string, max: number): string {
  const characters = Array.from(value);
  if (characters.length <= max) return value;
  return `${characters
    .slice(0, max - 1)
    .join('')
    .trimEnd()}…`;
}

/** Reads a single integer produced by `count(*)::int` style queries. */
export async function readCount(
  tx: SqlExecutor,
  sql: string,
  params: readonly unknown[],
): Promise<number> {
  const result = await tx.query<{ n: unknown }>(sql, params);
  const value = result.rows[0]?.n;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new DataIntegrityError('aggregate result');
  }
  return value;
}

/** Locks one row (`FOR UPDATE`) and returns its validated entity with the stored version column. */
export async function loadVersioned<S extends z.ZodType>(
  tx: SqlExecutor,
  options: { table: string; key: Record<string, string>; schema: S; what: string; id: string },
): Promise<{ entity: z.output<S>; version: number }> {
  const names = Object.keys(options.key);
  const conditions = names.map((name, index) => `${name} = $${index + 1}`);
  const result = await tx.query<DataRow & { version: number }>(
    `SELECT data, version FROM ${options.table} WHERE ${conditions.join(' AND ')} FOR UPDATE`,
    names.map((name) => options.key[name]),
  );
  const row = requireFound(result.rows[0], options.what, options.id);
  return {
    entity: parseStored(options.schema, row.data, options.what.toLowerCase()),
    version: row.version,
  };
}

/** Optimistic locking: the caller's expected version must equal the stored one. */
export function assertVersion(what: string, expected: number, actual: number): void {
  if (expected !== actual) throw new VersionConflictError(what, expected, actual);
}
