import type { Problem } from '@caseguard/schemas';
import { RedactionIncompleteError, SecurityError } from '@caseguard/security';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { AppError, RateLimitedError, ValidationFailedError, type ErrorCode } from '../errors';

export interface ProblemResult {
  readonly status: number;
  readonly problem: Problem;
  readonly headers: Readonly<Record<string, string>>;
  /** The caller was refused (as opposed to a fault); used to choose the audit outcome. */
  readonly denied: boolean;
  /** An unexpected fault: log it with the underlying error. */
  readonly unexpected: boolean;
}

export interface ProblemOptions {
  readonly requestId: string;
}

const TITLES: Record<ErrorCode, string> = {
  not_found: 'Not found',
  conflict: 'Conflict',
  version_conflict: 'The record was changed by someone else',
  validation_failed: 'The request is not valid',
  forbidden: 'Forbidden',
  unauthenticated: 'Authentication required',
  tenant_violation: 'Forbidden',
  idempotency_conflict: 'Idempotency key reuse',
  unsafe_content: 'The content was refused for safety reasons',
  payload_too_large: 'Payload too large',
  unsupported_media_type: 'Unsupported media type',
  rate_limited: 'Too many requests',
  precondition_failed: 'Precondition failed',
  budget_exceeded: 'Budget exceeded',
  provider_unavailable: 'Service temporarily unavailable',
  not_implemented: 'Not implemented',
  internal: 'Internal server error',
};

const GENERIC_SERVER_MESSAGE =
  'An unexpected error occurred. Quote the correlation id when you contact support.';

const DENIED: ReadonlySet<ErrorCode> = new Set([
  'forbidden',
  'tenant_violation',
  'unauthenticated',
]);

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

function codeFromStatus(status: number): ErrorCode {
  switch (status) {
    case 401:
      return 'unauthenticated';
    case 403:
      return 'forbidden';
    case 404:
    case 405:
      return 'not_found';
    case 409:
      return 'conflict';
    case 412:
      return 'precondition_failed';
    case 413:
      return 'payload_too_large';
    case 415:
      return 'unsupported_media_type';
    case 429:
      return 'rate_limited';
    case 501:
      return 'not_implemented';
    case 503:
      return 'provider_unavailable';
    default:
      return status >= 500 ? 'internal' : 'validation_failed';
  }
}

interface Extra {
  detail?: string;
  errors?: { path: string; message: string }[];
  headers?: Record<string, string>;
  reason?: string;
}

/** Only a short snake_case token can travel as a reason: it is a code a client switches on, never text. */
const REASON = /^[a-z][a-z0-9_]{2,39}$/;

function reasonOf(error: AppError): string | undefined {
  const value = error.details?.reason;
  return typeof value === 'string' && REASON.test(value) ? value : undefined;
}

function build(
  code: ErrorCode,
  status: number,
  options: ProblemOptions,
  extra: Extra = {},
): ProblemResult {
  const serverFault = status >= 500 && code === 'internal';
  const detail = serverFault ? GENERIC_SERVER_MESSAGE : extra.detail;
  const problem: Problem = {
    type: `urn:caseguard:problem:${code}`,
    title: TITLES[code],
    status,
    code,
    ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
    correlationId: options.requestId,
    ...(detail !== undefined ? { detail: clip(detail, 1000) } : {}),
    ...(extra.errors && extra.errors.length > 0
      ? {
          errors: extra.errors
            .slice(0, 100)
            .map((issue) => ({ path: clip(issue.path, 300), message: clip(issue.message, 500) })),
        }
      : {}),
  };
  const headers: Record<string, string> = { ...extra.headers };
  if (status === 401) headers['www-authenticate'] = 'Bearer realm="caseguard"';
  return { status, problem, headers, denied: DENIED.has(code), unexpected: serverFault };
}

interface FastifyLikeError {
  statusCode?: unknown;
  message?: unknown;
  validation?: unknown;
  validationContext?: unknown;
  code?: unknown;
  name?: unknown;
}

function asFastifyLike(error: unknown): FastifyLikeError | null {
  return typeof error === 'object' && error !== null ? error : null;
}

/**
 * Only Fastify's own client errors (`FST_*` codes: body too large, invalid JSON, wrong media type...)
 * may choose the response status and message. Any other error that happens to carry a 4xx
 * `statusCode` (an Azure SDK `RestError` relaying a storage or identity answer, for example) is a
 * server-side fault: its status and text describe a dependency, not this caller's request.
 */
function isFastifyClientError(error: FastifyLikeError | null): error is FastifyLikeError {
  return (
    error !== null &&
    typeof error.statusCode === 'number' &&
    error.statusCode >= 400 &&
    error.statusCode < 500 &&
    typeof error.code === 'string' &&
    error.code.startsWith('FST_')
  );
}

const DEPENDENCY_ERROR_NAMES: ReadonlySet<string> = new Set([
  'RestError',
  'CredentialUnavailableError',
  'AuthenticationRequiredError',
  'AggregateAuthenticationError',
]);

const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
]);

/** PostgreSQL connection exceptions (class 08), server shutdown (57P01-03) and too many connections. */
const POSTGRES_UNAVAILABLE = /^(08[A-Z0-9]{3}|57P0[123]|53300)$/;

/** A dependency (database, storage, identity service) is unreachable or refused the service itself. */
function isDependencyFault(error: FastifyLikeError | null): boolean {
  if (error === null) return false;
  if (typeof error.name === 'string' && DEPENDENCY_ERROR_NAMES.has(error.name)) return true;
  return (
    typeof error.code === 'string' &&
    (NETWORK_ERROR_CODES.has(error.code) || POSTGRES_UNAVAILABLE.test(error.code))
  );
}

function validationIssues(error: FastifyLikeError): { path: string; message: string }[] {
  const context =
    error.validationContext === 'querystring'
      ? 'query'
      : typeof error.validationContext === 'string'
        ? error.validationContext
        : 'request';
  const items: unknown[] = Array.isArray(error.validation) ? error.validation : [];
  return items.map((raw) => {
    const item = (raw ?? {}) as { instancePath?: unknown; message?: unknown };
    const path = typeof item.instancePath === 'string' ? item.instancePath : '';
    const suffix = path
      .split('/')
      .filter((part) => part !== '')
      .join('.');
    return {
      path: suffix === '' ? context : `${context}.${suffix}`,
      message: typeof item.message === 'string' ? item.message : 'Invalid value',
    };
  });
}

/**
 * Converts any thrown value into an RFC 9457-style problem. Messages of expected errors are safe by
 * construction; anything unexpected becomes a generic 500 carrying only the correlation id, so no
 * stack trace, SQL, path or secret can reach a client.
 */
export function toProblem(error: unknown, options: ProblemOptions): ProblemResult {
  if (error instanceof AppError) {
    const issues = error instanceof ValidationFailedError ? error.issues : undefined;
    const reason = reasonOf(error);
    return build(error.code, error.status, options, {
      detail: error.message,
      ...(reason !== undefined ? { reason } : {}),
      ...(issues ? { errors: issues } : {}),
      ...(error instanceof RateLimitedError
        ? { headers: { 'retry-after': String(Math.max(1, Math.ceil(error.retryAfterSeconds))) } }
        : {}),
    });
  }

  if (error instanceof SecurityError) {
    return build(error.code, error.status, options, {
      detail: error.message,
      // A refused payload whose custom redaction could not be applied is not a refused file: say which.
      ...(error instanceof RedactionIncompleteError ? { reason: 'redaction_incomplete' } : {}),
    });
  }

  if (hasZodFastifySchemaValidationErrors(error)) {
    const like = asFastifyLike(error);
    return build('validation_failed', 422, options, {
      detail: 'One or more fields are not valid.',
      errors: like ? validationIssues(like) : [],
    });
  }

  const like = asFastifyLike(error);
  if (isFastifyClientError(like)) {
    // Fastify's own 4xx messages (body too large, invalid JSON, wrong media type) contain no request data.
    const status = like.statusCode as number;
    const hasValidation = Array.isArray(like.validation);
    const detail = hasValidation
      ? 'One or more fields are not valid.'
      : typeof like.message === 'string'
        ? like.message
        : undefined;
    return build(codeFromStatus(status), status, options, {
      ...(detail !== undefined ? { detail } : {}),
      ...(hasValidation ? { errors: validationIssues(like) } : {}),
    });
  }

  if (isDependencyFault(like)) {
    // Retryable for the client, and a fault for the operator: logged with the underlying error.
    return {
      ...build('provider_unavailable', 503, options, {
        detail: 'A required service is temporarily unavailable. Try again shortly.',
      }),
      unexpected: true,
    };
  }

  return build('internal', 500, options);
}
