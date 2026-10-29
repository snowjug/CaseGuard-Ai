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
  | 'not_implemented'
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

/** The request could not be read at all (a broken multipart envelope, an upload cut short). */
export class MalformedRequestError extends AppError {
  constructor(message = 'The request is malformed') {
    super('validation_failed', 400, message);
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

/** The same Idempotency-Key was reused with a different request. */
export class IdempotencyConflictError extends AppError {
  constructor(message = 'This Idempotency-Key was already used with a different request') {
    super('idempotency_conflict', 422, message);
  }
}

/** Content failed a safety check (malware hook, active content, unsafe URL). */
export class UnsafeContentError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('unsafe_content', 422, message, details);
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message = 'The request payload is too large', limitBytes?: number) {
    super('payload_too_large', 413, message, limitBytes === undefined ? undefined : { limitBytes });
  }
}

export class UnsupportedMediaTypeError extends AppError {
  constructor(message = 'Unsupported media type') {
    super('unsupported_media_type', 415, message);
  }
}

export class RateLimitedError extends AppError {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number, message = 'Too many requests; slow down and retry') {
    super('rate_limited', 429, message, { retryAfterSeconds });
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** A configured token or cost budget would be exceeded; the call is refused, never silently cut. */
export class BudgetExceededError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('budget_exceeded', 429, message, details);
  }
}

export class ProviderUnavailableError extends AppError {
  constructor(message = 'A required provider is temporarily unavailable') {
    super('provider_unavailable', 503, message);
  }
}

/** A documented route whose implementation is not available in this build. */
export class NotImplementedError extends AppError {
  constructor(what: string) {
    super('not_implemented', 501, `${what} is not implemented`);
  }
}
