import { AppError, ConflictError, ForbiddenError, ValidationFailedError } from '../errors';

/** Raised when a write targets a different tenant than the one the repositories are scoped to. */
export class TenantViolationError extends AppError {
  constructor(message = 'The record does not belong to the current tenant') {
    super('tenant_violation', 403, message);
  }
}

/** Raised when data read back from the database fails schema validation (never returned to callers). */
export class DataIntegrityError extends AppError {
  constructor(what: string, issues: { path: string; message: string }[] = []) {
    super('internal', 500, `Stored ${what} failed validation and was not returned`, {
      what,
      issues: issues.slice(0, 10),
    });
  }
}

/** Generic failure of the data store; the original error is kept only as a sanitised `cause`. */
export class DataStoreError extends AppError {
  constructor(message = 'The data store failed to complete the operation') {
    super('internal', 500, message);
  }
}

export class DataStoreUnavailableError extends AppError {
  constructor(message = 'The data store is temporarily unavailable') {
    super('provider_unavailable', 503, message);
  }
}

/** Non-sensitive diagnostic fields of a database error: no SQL text, parameters or row values. */
export interface DatabaseErrorInfo {
  code: string;
  severity?: string | undefined;
  constraint?: string | undefined;
  table?: string | undefined;
  column?: string | undefined;
  schema?: string | undefined;
  routine?: string | undefined;
  /** True for "new row violates row-level security policy" (the message itself is not kept). */
  rowLevelSecurity?: boolean | undefined;
}

/**
 * Stand-in for the driver error that is safe to log. Drivers attach the SQL text, bind parameters
 * and a `detail` with offending key values to their errors; none of that is copied here.
 */
export class SanitizedDatabaseError extends Error {
  readonly info: DatabaseErrorInfo;
  constructor(info: DatabaseErrorInfo) {
    const where = [info.table ? `table ${info.table}` : null, constraintLabel(info)]
      .filter((part): part is string => part !== null)
      .join(', ');
    super(`database error ${info.code}${where ? ` (${where})` : ''}`);
    this.name = 'SanitizedDatabaseError';
    this.info = info;
  }
}

function constraintLabel(info: DatabaseErrorInfo): string | null {
  return info.constraint ? `constraint ${info.constraint}` : null;
}

const SQLSTATE = /^[0-9A-Z]{5}$/;
const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
]);
const NETWORK_MESSAGES = [
  /connection terminated/i,
  /timeout exceeded when trying to connect/i,
  /client has encountered a connection error/i,
  /cannot use a pool after calling end/i,
];

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Extracts SQLSTATE and schema object names from a pg or PGlite error; null for other errors. */
export function extractDatabaseErrorInfo(error: unknown): DatabaseErrorInfo | null {
  if (error instanceof SanitizedDatabaseError) return error.info;
  if (error === null || typeof error !== 'object') return null;
  const record = error as Record<string, unknown>;
  const code = record.code;
  if (typeof code !== 'string' || !SQLSTATE.test(code)) return null;
  // Node system errors (ECONNREFUSED, ...) are longer than five characters; this guards the rest.
  if (!('severity' in record) && !('routine' in record) && !('constraint' in record)) return null;
  return {
    code,
    severity: optionalString(record, 'severity'),
    constraint: optionalString(record, 'constraint'),
    table: optionalString(record, 'table'),
    column: optionalString(record, 'column'),
    schema: optionalString(record, 'schema'),
    routine: optionalString(record, 'routine'),
    rowLevelSecurity:
      typeof record.message === 'string' && /row-level security/i.test(record.message),
  };
}

/** SQLSTATE of the underlying database error, looking through mapped AppErrors. */
export function getDatabaseErrorCode(error: unknown): string | null {
  const direct = extractDatabaseErrorInfo(error);
  if (direct) return direct.code;
  if (error instanceof Error && error.cause !== undefined) {
    return extractDatabaseErrorInfo(error.cause)?.code ?? null;
  }
  return null;
}

/** Custom SQLSTATE raised by the immutability triggers. */
export const IMMUTABLE_SQLSTATE = 'CG001';

/** Friendlier messages for the constraints callers are most likely to trip over. */
const CONSTRAINT_MESSAGES: Record<string, string> = {
  case_sources_tenant_received_sha_uq: 'A case with this content has already been ingested',
  cases_tenant_reference_uq: 'A case with this reference already exists in this workspace',
  skills_tenant_key_uq: 'A skill with this key already exists',
  skill_versions_semver_uq: 'This skill already has a version with the same version number',
  jobs_idempotency_uq: 'A job with this idempotency key already exists',
  skill_approvals_distinct_approver_chk:
    'An approval requires an approver other than the requester',
};

function withCause<T extends Error>(error: T, cause: unknown): T {
  error.cause = cause;
  return error;
}

/**
 * Converts a driver error into an AppError whose message is safe to show to callers. Non-database
 * errors (including AppErrors thrown by repositories) pass through unchanged.
 */
export function mapDatabaseError(error: unknown): Error {
  if (error instanceof AppError) return error;
  const info = extractDatabaseErrorInfo(error);
  if (info) return mapSqlState(info);
  if (isNetworkFailure(error)) {
    // The original message can contain host names, so only the error code is kept for logs.
    const code = (error as { code?: unknown }).code;
    const label = typeof code === 'string' && code.length <= 40 ? ` (${code})` : '';
    return withCause(
      new DataStoreUnavailableError(),
      new Error(`database connection failure${label}`),
    );
  }
  return error instanceof Error ? error : new Error('Unknown data store failure');
}

function mapSqlState(info: DatabaseErrorInfo): Error {
  const cause = new SanitizedDatabaseError(info);
  const constraintMessage = info.constraint ? CONSTRAINT_MESSAGES[info.constraint] : undefined;
  switch (info.code) {
    case IMMUTABLE_SQLSTATE:
      return withCause(
        new ConflictError('This record is immutable and cannot be modified or deleted', {
          reason: 'immutable',
        }),
        cause,
      );
    case '23505':
      return withCause(
        new ConflictError(constraintMessage ?? 'A record with the same identifier already exists', {
          reason: 'duplicate',
        }),
        cause,
      );
    case '23503':
      return withCause(
        new ConflictError(
          constraintMessage ??
            'The operation references a record that does not exist or is still in use',
          { reason: 'reference' },
        ),
        cause,
      );
    case '23514':
      return withCause(
        new ValidationFailedError(
          constraintMessage ?? 'The data violates a storage rule and was not saved',
        ),
        cause,
      );
    case '22P05':
    case '22021':
      return withCause(
        new ValidationFailedError('The content contains characters that cannot be stored', [
          { path: 'content', message: 'Remove NUL or invalid characters and retry' },
        ]),
        cause,
      );
    // A value the caller supplied does not fit its column type: out of range (22003), not a date
    // (22007), an impossible date (22008) or not a number/JSON text (22P02). Callers validate first;
    // this is the last line, so such a value is a 422 and not an "unexpected" 500. No value or SQL
    // text is copied into the message.
    case '22003':
    case '22007':
    case '22008':
    case '22P02':
      return withCause(
        new ValidationFailedError('A value in the request is out of range or malformed', [
          { path: 'request', message: 'Check the numbers, dates and identifiers in the request' },
        ]),
        cause,
      );
    case '40001':
    case '40P01':
      return withCause(
        new ConflictError('The operation conflicted with a concurrent change; retry', {
          reason: 'concurrency',
          retryable: true,
        }),
        cause,
      );
    case '42501':
      return withCause(
        info.rowLevelSecurity
          ? new AppError('tenant_violation', 403, 'The operation is not permitted for this tenant')
          : new ForbiddenError('The data store denied the operation'),
        cause,
      );
    case '57014':
    case '55P03':
      return withCause(
        new DataStoreUnavailableError('The data store did not respond in time'),
        cause,
      );
    default:
      if (info.code.startsWith('08') || info.code.startsWith('53') || info.code.startsWith('57P')) {
        return withCause(new DataStoreUnavailableError(), cause);
      }
      return withCause(new DataStoreError(), cause);
  }
}

function isNetworkFailure(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const record = error as Record<string, unknown>;
  if (typeof record.code === 'string' && NETWORK_CODES.has(record.code)) return true;
  const message = typeof record.message === 'string' ? record.message : '';
  return NETWORK_MESSAGES.some((pattern) => pattern.test(message));
}

/** Short, secret-free description of a failure for health checks. */
export function describeFailure(error: unknown): string {
  const info = extractDatabaseErrorInfo(error);
  if (info) return `database error ${info.code}`;
  if (error instanceof AppError) {
    // Mapped errors keep a sanitised cause (SQLSTATE or connection error code) worth reporting.
    return error.cause instanceof Error ? error.cause.message : error.message;
  }
  if (error !== null && typeof error === 'object') {
    const code = (error as Record<string, unknown>).code;
    if (typeof code === 'string' && code.length <= 40) return `connection failure (${code})`;
  }
  return 'database unreachable';
}
