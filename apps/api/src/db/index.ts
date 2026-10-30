export { createDatabase, PgDatabase, PgliteDatabase } from './client';
export type { DatabaseAuth, DatabaseOptions, DbLogger } from './client';
export { createRepositories } from './repositories';
export type { RepositoryDeps } from './repositories';
export type * from './repositories/types';
export {
  MigrationError,
  getMigrationStatus,
  loadMigrations,
  migrate,
  type MigrateOptions,
  type MigrationFile,
  type MigrationResult,
} from './migrate';
export {
  CONTOSO_TENANT_ID,
  DEV_PERSONAS,
  FABRIKAM_TENANT_ID,
  seedFoundation,
  type SeedSummary,
} from './seed';
export { createIdGenerator, isGeneratedId, type IdGenerator } from './ids';
export { canonicalJson, sha256Hex } from './hash';
export { AUDIT_GENESIS_HASH, computeAuditHash } from './repositories/audit-repository';
export { MAX_EVENTS_PER_CASE } from './repositories/case-repository';
export {
  DEFAULT_PURGE_BATCH,
  MAX_IDEMPOTENT_RESPONSE_BYTES,
  MAX_PURGE_BATCH,
} from './repositories/idempotency-repository';
export { MAX_DASHBOARD_LIST, MAX_SUMMARY_CASES } from './repositories/analysis-read-models';
export {
  MAX_SEARCH_RESULTS,
  MAX_SNIPPET_CHARS,
  SEARCH_TYPE_WEIGHTS,
} from './repositories/search-repository';
export { SNAPSHOT_LIMITS } from './repositories/analysis-snapshot';
export {
  DataIntegrityError,
  DataStoreError,
  DataStoreUnavailableError,
  TenantViolationError,
  getDatabaseErrorCode,
  mapDatabaseError,
} from './errors';
