import { ValidationFailedError } from '../errors';
import type { TenantScope } from './repositories/types';

/** The non-login role every tenant-scoped transaction switches into (see migration 0001). */
export const APP_ROLE = 'caseguard_app';

/** Statements that open the tenant row-level-security context of a transaction. */
export const SET_APP_ROLE_SQL = `SET LOCAL ROLE ${APP_ROLE}`;
export const SET_TENANT_SQL = "SELECT set_config('app.tenant_id', $1, true)";

/** Minimal logger the data tier needs; the API injects its pino logger behind this shape. */
export interface DbLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
}

export type DatabaseAuth = 'password' | 'entra';

export interface DatabaseOptions {
  /** `pglite://memory`, `pglite://<directory>` or a `postgres://` / `postgresql://` URL. */
  url: string;
  /**
   * `password` (default) or `entra`: pass a Microsoft Entra access token as the PostgreSQL password.
   * Entra token acquisition is implemented but NOT validated against a live Azure server.
   */
  auth?: DatabaseAuth | undefined;
  /** pg pool size (`DB_POOL_MAX`). Ignored by PGlite, which has a single connection. */
  poolMax?: number | undefined;
  /** Server-side statement timeout for pg connections; 0 disables it. Default 30 000 ms. */
  statementTimeoutMs?: number | undefined;
  applicationName?: string | undefined;
  /** Restricts pg connections to one schema (used by the real-PostgreSQL test mode). */
  schema?: string | undefined;
  logger?: DbLogger | undefined;
  /** Test seam: replaces Entra token acquisition. */
  tokenProvider?: (() => Promise<string>) | undefined;
}

export function assertTenantScope(scope: TenantScope): void {
  if (
    typeof scope.tenantId !== 'string' ||
    scope.tenantId.length === 0 ||
    scope.tenantId.length > 120
  ) {
    throw new ValidationFailedError('A tenant scope requires a tenant id', [
      { path: 'tenantId', message: 'Expected a non-empty tenant id of at most 120 characters' },
    ]);
  }
}

export type ParsedDatabaseUrl =
  { kind: 'pglite'; dataDir: string | null } | { kind: 'pg'; connectionString: string };

/** Classifies DATABASE_URL. Error messages never echo the URL because it may carry a password. */
export function parseDatabaseUrl(url: string): ParsedDatabaseUrl {
  if (url.startsWith('pglite://')) {
    const rest = url.slice('pglite://'.length);
    return { kind: 'pglite', dataDir: rest === '' || rest === 'memory' ? null : rest };
  }
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    return { kind: 'pg', connectionString: url };
  }
  throw new ValidationFailedError('DATABASE_URL has an unsupported scheme', [
    { path: 'DATABASE_URL', message: 'Use pglite://memory, pglite://<dir> or postgres://...' },
  ]);
}
