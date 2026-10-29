import { parseDatabaseUrl, type DatabaseOptions } from './driver-types';
import { createPgDatabase } from './pg-database';
import { PgliteDatabase } from './pglite-database';
import type { Database } from './repositories/types';

export type { DatabaseOptions, DbLogger, DatabaseAuth } from './driver-types';
export { PgDatabase } from './pg-database';
export { PgliteDatabase } from './pglite-database';

/**
 * Opens the database named by `options.url`:
 *  - `pglite://memory` or `pglite://<dir>`: in-process PostgreSQL (local development and tests);
 *  - `postgres://...`: a pg pool (production). TLS is configured through the connection string
 *    (`sslmode=require`); `auth: 'entra'` uses a Microsoft Entra token as the password.
 *
 * Row-level security is only effective when the connecting role is a non-superuser that belongs to
 * `caseguard_app`: PostgreSQL superusers bypass RLS (even FORCE ROW LEVEL SECURITY). Production must
 * connect as such a role; PGlite always runs as a superuser, which is why `withTenant` switches to
 * `caseguard_app` for every tenant-scoped transaction.
 */
export async function createDatabase(options: DatabaseOptions): Promise<Database> {
  const target = parseDatabaseUrl(options.url);
  if (target.kind === 'pglite') return PgliteDatabase.open(target.dataDir);
  return createPgDatabase(target.connectionString, options);
}
