import type { ExecutionStatus, ModelExecutionWithUsage } from '@caseguard/schemas';

export type ProviderErrorCode =
  | 'timeout'
  | 'cancelled'
  | 'rate_limited'
  | 'server_error'
  | 'unauthorized'
  | 'forbidden'
  | 'bad_request'
  | 'content_filtered'
  | 'model_refusal'
  | 'network'
  | 'invalid_response'
  | 'not_configured'
  | 'unsupported_task'
  | 'tool_call_blocked'
  | 'response_too_large'
  | 'overloaded';

const RETRYABLE: ReadonlySet<ProviderErrorCode> = new Set([
  'rate_limited',
  'server_error',
  'network',
]);

/** Failures that say something about provider health (as opposed to a bad prompt or the caller leaving). */
const BREAKER_RELEVANT: ReadonlySet<ProviderErrorCode> = new Set([
  'timeout',
  'rate_limited',
  'server_error',
  'network',
  'unauthorized',
  'forbidden',
  'invalid_response',
  'response_too_large',
]);

export interface ProviderErrorOptions {
  status?: number | null;
  retryAfterMs?: number | null;
  attempts?: number;
  cause?: unknown;
  /** Short, sanitised reason (`ENOTFOUND`, `DeploymentNotFound`); never message text, URLs or headers. */
  causeCode?: string | null;
}

/**
 * Typed, sanitised provider failure. The message never contains prompts, response bodies, headers
 * or credentials, so it is safe to log and to surface in execution records.
 */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly status: number | null;
  readonly retryAfterMs: number | null;
  readonly attempts: number;
  readonly causeCode: string | null;

  constructor(code: ProviderErrorCode, message: string, options: ProviderErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProviderError';
    this.code = code;
    this.status = options.status ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.attempts = options.attempts ?? 1;
    this.causeCode = options.causeCode ?? null;
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.code);
  }

  get countsTowardBreaker(): boolean {
    return BREAKER_RELEVANT.has(this.code);
  }

  /**
   * A fault of our own configuration that no retry will cure: rejected or missing credentials
   * (401, 403), a deployment or endpoint that does not exist (404), or settings we refuse to use.
   * Other 4xx answers are about the request itself, not about how we are set up.
   */
  get isConfigurationFault(): boolean {
    return (
      this.code === 'unauthorized' ||
      this.code === 'forbidden' ||
      this.code === 'not_configured' ||
      (this.code === 'bad_request' && this.status === 404)
    );
  }
}

export const isProviderError = (error: unknown): error is ProviderError =>
  error instanceof ProviderError;

export type AiTaskErrorCode =
  'invalid_input' | 'internal_validation_failure' | 'unsupported_agent' | 'cancelled';

/** Orchestration failure that is not a provider problem (bad input, cancellation, or a bug in our own output). */
export class AiTaskError extends Error {
  readonly code: AiTaskErrorCode;
  /** Record describing the attempt (for example a cancelled execution) so callers can still persist it. */
  readonly execution: ModelExecutionWithUsage | null;

  constructor(
    code: AiTaskErrorCode,
    message: string,
    execution: ModelExecutionWithUsage | null = null,
  ) {
    super(message);
    this.name = 'AiTaskError';
    this.code = code;
    this.execution = execution;
  }
}

/** Maps a provider failure to the execution status recorded for the attempt. */
export function executionStatusFor(error: ProviderError): ExecutionStatus {
  switch (error.code) {
    case 'timeout':
      return 'timed_out';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'failed';
  }
}

/** Short, secret-free description of any thrown value for logs and execution records. */
export function describeError(error: unknown): string {
  if (error instanceof ProviderError) return `${error.code}: ${error.message}`.slice(0, 380);
  if (error instanceof AiTaskError) return `${error.code}: ${error.message}`.slice(0, 380);
  if (error instanceof Error) return error.name.slice(0, 80);
  return 'unknown error';
}

const CAUSE_CODE = /^[A-Za-z][A-Za-z0-9_.:-]{1,95}$/;
const OAUTH_ERROR = /^[a-z][a-z_]{2,63}$/;
const GENERIC_ERROR_NAMES: ReadonlySet<string> = new Set(['Error', 'TypeError']);

/**
 * A short, sanitised identifier for why a call failed: a system error code (`ENOTFOUND`,
 * `ECONNREFUSED`, `CERT_HAS_EXPIRED`) found on the error or on its cause chain (fetch wraps the
 * system error), or the name of a credential error (`CredentialUnavailableError`, with the OAuth
 * error code when there is one). Never message text, URLs, host names, headers or response bodies.
 * Null when nothing usable is there.
 */
export function causeCodeOf(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && typeof current === 'object' && current !== null; depth++) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === 'string' && CAUSE_CODE.test(code)) return code;
    current = cause;
  }
  if (!(error instanceof Error)) return null;
  if (GENERIC_ERROR_NAMES.has(error.name) || !CAUSE_CODE.test(error.name)) return null;
  const oauth = (error as { errorResponse?: { error?: unknown } }).errorResponse?.error;
  return typeof oauth === 'string' && OAUTH_ERROR.test(oauth)
    ? `${error.name}:${oauth}`
    : error.name;
}
