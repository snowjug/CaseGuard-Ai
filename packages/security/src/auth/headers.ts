import { AuthenticationError } from '../errors';
import type { HeadersLike } from './types';

function isHeadersReader(headers: HeadersLike): headers is { get(name: string): string | null } {
  return typeof (headers as { get?: unknown }).get === 'function';
}

/**
 * Reads a header that must appear at most once. Returns `undefined` when absent and throws a
 * `malformed_credentials` `AuthenticationError` when it is repeated, because an ambiguous
 * Authorization or persona header is how request-smuggling and proxy-confusion tricks start.
 */
export function readSingleHeader(headers: HeadersLike, name: string): string | undefined {
  const lower = name.toLowerCase();
  if (isHeadersReader(headers)) return headers.get(lower) ?? undefined;

  let found: string | readonly string[] | undefined = Object.hasOwn(headers, lower)
    ? headers[lower]
    : undefined;
  if (found === undefined) {
    const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === lower);
    found = key === undefined ? undefined : headers[key];
  }

  if (found === undefined) return undefined;
  if (typeof found === 'string') return found;
  if (found.length === 0) return undefined;
  if (found.length > 1) throw new AuthenticationError('malformed_credentials');
  return found[0];
}
