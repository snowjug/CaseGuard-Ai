/**
 * Domain errors shared by the data tier and the HTTP layer. The HTTP error handler maps each
 * class to a Problem Details response; nothing here carries stack traces to clients.
 */
export type ErrorCode =
  | 'not_found'
  | 'conflict'
  | 'version_conflict'
  | 'validation_failed'
  | 'forbidden'
  | 'unauthenticated'
  | 'tenant_violation'
  | 'idempotency_conflict'
  | 'unsafe_content'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'rate_limited'
  | 'precondition_failed'
  | 'budget_exceeded'
  | 'provider_unavailable'
  | 'internal';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, status: number, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class NotFoundError extends AppError {
  constructor(what: string, id?: string) {
    super('not_found', 404, id ? `${what} "${id}" was not found` : `${what} was not found`);
  }
}

/** Optimistic-lock failure: the caller's expected version is stale. */
export class VersionConflictError extends AppError {
  constructor(what: string, expected: number, actual: number) {
    super(
      'version_conflict',
      409,
      `${what} was modified by someone else (expected version ${expected}, found ${actual}). Reload and retry.`,
      {
        expected,
        actual,
      },
    );
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('conflict', 409, message, details);
  }
}

export class ValidationFailedError extends AppError {
  readonly issues: { path: string; message: string }[];
  constructor(message: string, issues: { path: string; message: string }[] = []) {
    super('validation_failed', 422, message);
    this.issues = issues;
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action') {
    super('forbidden', 403, message);
  }
}

export class PreconditionFailedError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('precondition_failed', 412, message, details);
  }
}
