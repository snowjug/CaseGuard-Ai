import { createIdGenerator } from '../ids';

/** Header carrying the caller's request id, echoed on responses and forwarded downstream. */
export const REQUEST_ID_HEADER = 'x-request-id';
/** Azure SDK convention for a caller-chosen request id; echoed so Azure-side logs correlate with ours. */
export const CLIENT_REQUEST_ID_HEADER = 'x-ms-client-request-id';

/**
 * Accepted inbound `x-request-id`: 8-64 characters, URL-safe alphabet, alphanumeric first character.
 * The alphabet excludes whitespace, quotes, CR/LF, `%`, `<`, `>` and every other character that
 * could forge a log line, split a header or reach a template.
 */
const INBOUND_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$/;

/** Identifiers set by our own code (request, tenant, user ids) may be shorter but share the alphabet. */
export const CONTEXT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

const defaultRequestIdGenerator = createIdGenerator('req');

/**
 * Validates a client-supplied request id. Returns `undefined` for anything that is not a single,
 * well-formed string, including repeated headers (arrays), so the caller can generate its own.
 */
export function acceptRequestId(value: unknown): string | undefined {
  return typeof value === 'string' && INBOUND_REQUEST_ID.test(value) ? value : undefined;
}

/** New request id `req_<ULID>`. Inject `generate` for deterministic tests; invalid output is a bug and throws. */
export function newRequestId(generate: () => string = defaultRequestIdGenerator): string {
  const id = generate();
  if (typeof id !== 'string' || !CONTEXT_ID_PATTERN.test(id)) {
    throw new TypeError('Request id generator returned an id outside the allowed alphabet');
  }
  return id;
}

/** Result of `resolveRequestId`. */
export interface ResolvedRequestId {
  readonly requestId: string;
  /** `header` when the client's id was accepted, `generated` otherwise. */
  readonly source: 'header' | 'generated';
}

/** Accepts the inbound header when valid, otherwise generates an id. */
export function resolveRequestId(inbound: unknown, generate?: () => string): ResolvedRequestId {
  const accepted = acceptRequestId(inbound);
  return accepted === undefined
    ? { requestId: newRequestId(generate), source: 'generated' }
    : { requestId: accepted, source: 'header' };
}
