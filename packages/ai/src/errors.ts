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

  constructor(code: ProviderErrorCode, message: string, options: ProviderErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProviderError';
    this.code = code;
    this.status = options.status ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.attempts = options.attempts ?? 1;
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.code);
  }

  get countsTowardBreaker(): boolean {
    return BREAKER_RELEVANT.has(this.code);
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
