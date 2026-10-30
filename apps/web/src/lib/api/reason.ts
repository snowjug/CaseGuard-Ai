import { ApiError } from './errors';

/**
 * True for an `ApiError` that carries this stable `reason` token (and, when given, this error `code`). Branch on this,
 * never on the wording of the message.
 */
export function hasReason(error: unknown, reason: string, code?: string): error is ApiError {
  return (
    error instanceof ApiError &&
    error.reason === reason &&
    (code === undefined || error.code === code)
  );
}

/** What to do after a rate limit: the delay the server asked for (`Retry-After`), or a plain "in a moment". */
export function retryAdvice(error: ApiError): string {
  if (error.retryAfterMs === undefined) return 'Try again in a moment.';
  const seconds = Math.max(1, Math.ceil(error.retryAfterMs / 1000));
  return `Try again in about ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`;
}
