import type { Problem } from '@caseguard/schemas';

export interface ApiIssue {
  path: string;
  message: string;
}

export interface ApiErrorInit {
  status: number;
  code: string;
  title: string;
  message?: string | undefined;
  correlationId?: string | undefined;
  issues?: readonly ApiIssue[] | undefined;
  /** Delay requested by `Retry-After`, in milliseconds. */
  retryAfterMs?: number | undefined;
  cause?: unknown;
}

/**
 * Every failure of an API call. HTTP errors come from RFC 9457 Problem Details; `status` 0 means the request never got
 * an answer (`network_error`, `timeout`). The message is safe to show: it never contains a stack trace.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly correlationId: string | undefined;
  readonly issues: readonly ApiIssue[];
  readonly retryAfterMs: number | undefined;

  constructor(init: ApiErrorInit) {
    super(init.message ?? init.title, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.title = init.title;
    this.correlationId = init.correlationId;
    this.issues = init.issues ?? [];
    this.retryAfterMs = init.retryAfterMs;
  }

  get isUnauthenticated(): boolean {
    return this.status === 401;
  }
  get isForbidden(): boolean {
    return this.status === 403;
  }
  get isNotFound(): boolean {
    return this.status === 404;
  }
  get isNetwork(): boolean {
    return this.code === 'network_error';
  }
  /** A gateway or proxy answered for the API (5xx without Problem Details): the API itself is down or unreachable. */
  get isUnavailable(): boolean {
    return this.code === 'upstream_unavailable';
  }
  get isTimeout(): boolean {
    return this.code === 'timeout';
  }
  /** The web server cannot forward to the API (`API_INTERNAL_URL` missing or invalid): retrying cannot help. */
  get isMisconfigured(): boolean {
    return this.code === 'upstream_not_configured';
  }
  /** Transient failures worth retrying for idempotent requests. */
  get isRetryable(): boolean {
    return (
      !this.isMisconfigured &&
      (this.isNetwork ||
        this.isUnavailable ||
        this.isTimeout ||
        this.status === 429 ||
        this.status === 502 ||
        this.status === 503 ||
        this.status === 504)
    );
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/** Builds an ApiError from a parsed Problem Details document. */
export function apiErrorFromProblem(
  problem: Problem,
  fallbackCorrelationId: string | undefined,
  retryAfterMs?: number,
): ApiError {
  return new ApiError({
    status: problem.status,
    code: problem.code,
    title: problem.title,
    message: problem.detail ?? problem.title,
    correlationId: problem.correlationId ?? fallbackCorrelationId,
    issues: problem.errors ?? [],
    retryAfterMs,
  });
}

/** One-line, person-friendly explanation of an error, used by ErrorState descriptions and toasts. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.isMisconfigured)
      return 'The web server is not configured to reach the CaseGuard API (API_INTERNAL_URL). Ask an administrator to set it.';
    if (error.isNetwork || error.isUnavailable)
      return 'The CaseGuard API could not be reached. Check that the API server is running, then retry.';
    if (error.isTimeout) return 'The request took too long to answer. Retry in a moment.';
    if (error.isUnauthenticated) return 'You are not signed in.';
    if (error.isForbidden) return 'Your role does not allow this.';
    if (error.status >= 500)
      return 'The server had a problem handling the request. Retry in a moment.';
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return 'Something unexpected happened.';
}
