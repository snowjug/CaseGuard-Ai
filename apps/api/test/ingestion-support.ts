import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AuditEvent } from '@caseguard/schemas';
import {
  CONTOSO,
  PERSONAS,
  createHarness,
  openSharedDatabase,
  type ApiResponse,
  type Harness,
} from './support/app-harness';
import type { Database, QueryResult, SqlExecutor } from '../src/db';
import { resetTestDatabase } from '../src/db/testing';
import { fakeAnalysis, type FakeAnalysis } from './ingestion-fixtures';
import type { HarnessOptions } from './support/app-harness';
import { multipartBody } from './support/fixtures';

/** Helpers shared by the database-backed ingestion and cases tests. */

export const SAMPLE_SOURCE = { type: 'sample', sampleId: 'case-one-teams-signin-dns' } as const;
export const FOLLOWUP_SOURCE = { type: 'sample', sampleId: 'case-two-teams-signin-proxy' } as const;

export const post = (
  h: Harness,
  persona: string | null,
  url: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<ApiResponse> =>
  h.call(persona, { method: 'POST', url, payload: payload as object, headers });

export const createCase = (
  h: Harness,
  persona: string | null,
  source: unknown,
  options?: { analyze?: boolean },
  headers: Record<string, string> = {},
): Promise<ApiResponse> =>
  post(h, persona, '/api/v1/cases', { source, ...(options ? { options } : {}) }, headers);

export const previewCase = (
  h: Harness,
  persona: string | null,
  source: unknown,
): Promise<ApiResponse> => post(h, persona, '/api/v1/ingestion/preview', { source });

export const PREVIEW_FILE_URL = '/api/v1/ingestion/preview-file';
export const CREATE_FILE_URL = '/api/v1/cases/upload';

/** Sends one file as multipart/form-data in the "file" field. */
export function uploadFile(
  h: Harness,
  persona: string | null,
  url: string,
  filename: string,
  content: string | Buffer,
  type = 'text/plain',
  headers: Record<string, string> = {},
): Promise<ApiResponse> {
  const body = multipartBody([{ name: 'file', filename, type, content }]);
  return h.call(persona, {
    method: 'POST',
    url,
    payload: body.payload,
    headers: { ...body.headers, ...headers },
  });
}

/** A two-row CSV whose first message is `message` (already CSV-escaped). */
export const csvWith = (message: string): string =>
  [
    'Timestamp,From,Role,Message',
    `2026-05-05T09:00:00Z,Customer,customer_admin,"${message}"`,
    '2026-05-05T09:05:00Z,Engineer,support_engineer,"Looking into it now."',
  ].join('\n');

/**
 * Opens the shared database and drives one throw-away app through a preview, so the cold start
 * (module loading, route compilation) is paid under the long start-up timeout and not by the first
 * test of the file: on a busy machine that alone can exceed the per-test limit.
 */
export async function openWarmDatabase(): Promise<Database> {
  const database = await openSharedDatabase();
  const warm = await createHarness({ database, services: { analysis: fakeAnalysis() } });
  try {
    await previewCase(warm, PERSONAS.engineer, SAMPLE_SOURCE);
  } finally {
    await warm.close();
  }
  return database;
}

/** Opens a harness over the shared database with a fake analysis port (the real one is another group's). */
export async function openHarness(
  database: Database,
  harnesses: Harness[],
  options: HarnessOptions = {},
): Promise<{ h: Harness; analysis: FakeAnalysis }> {
  const analysis = fakeAnalysis();
  const h = await createHarness({
    database,
    ...options,
    services: { analysis, ...options.services },
  });
  harnesses.push(h);
  return { h, analysis };
}

/** Empties every table and re-seeds the tenants and users, so each test starts from nothing. */
export const resetDatabase = (database: Database): Promise<void> => resetTestDatabase(database);

export interface RecordedStatement {
  sql: string;
  params: readonly unknown[];
}

export interface StatementLog extends Database {
  /** Every statement the repositories ran through this database since the last `clear()`. */
  readonly statements: RecordedStatement[];
  clear(): void;
}

/**
 * Decorates a database so a test can see which statements a request ran (to prove there is no N+1).
 * `staleRead` may answer a SELECT with no rows instead of running it: what a request that checked
 * before a concurrent one committed would have seen. The statement is still recorded.
 */
export function withStatementLog(
  database: Database,
  staleRead: (statement: RecordedStatement) => boolean = () => false,
): StatementLog {
  const statements: RecordedStatement[] = [];
  const record = (executor: SqlExecutor): SqlExecutor => ({
    query: <T = Record<string, unknown>>(
      text: string,
      params?: readonly unknown[],
    ): Promise<QueryResult<T>> => {
      const statement = { sql: text, params: params ?? [] };
      statements.push(statement);
      if (staleRead(statement)) return Promise.resolve({ rows: [], rowCount: 0 });
      return executor.query<T>(text, params);
    },
  });
  return {
    kind: database.kind,
    statements,
    clear: () => {
      statements.length = 0;
    },
    query: (text, params) => record(database).query(text, params),
    transaction: (fn) => database.transaction((tx) => fn(record(tx))),
    withTenant: (scope, fn) => database.withTenant(scope, (tx) => fn(record(tx))),
    ping: () => database.ping(),
    close: () => database.close(),
  };
}

/** Files the local object store holds (metadata sidecars excluded). */
export function storedObjects(h: Harness): string[] {
  if (h.config.storage.provider !== 'local') throw new Error('tests use the local object store');
  return readdirSync(h.config.storage.localDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.endsWith('.cgmeta'))
    .map((entry) => join(entry.parentPath, entry.name));
}

/** Audit events of one action, newest first. */
export async function auditOf(
  h: Harness,
  action: string,
  tenantId: string = CONTOSO,
): Promise<AuditEvent[]> {
  return (await h.repos(tenantId).audit.list({ action, limit: 100 })).items;
}

/** The redacted payloads of every stored case source, read straight from the table. */
export async function storedPayloads(h: Harness): Promise<string[]> {
  const result = await h.infra.database.query<{ payload: string }>(
    'SELECT payload FROM case_sources',
  );
  return result.rows.map((row) => row.payload);
}

/** Everything a test may assert on to prove a secret did not leak: logs, audit rows and stored data. */
export async function leakSurface(h: Harness): Promise<string> {
  const audit = await h.infra.database.query('SELECT action, details FROM audit_events');
  const events = await h.infra.database.query('SELECT data FROM case_events');
  const cases = await h.infra.database.query('SELECT data FROM cases');
  return JSON.stringify({
    logs: h.logs(),
    audit: audit.rows,
    events: events.rows,
    cases: cases.rows,
    payloads: await storedPayloads(h),
  });
}
