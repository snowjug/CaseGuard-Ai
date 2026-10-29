import { secureRandomBytes, type RandomBytes } from '../ids';
import { acceptRequestId, newRequestId, REQUEST_ID_HEADER } from './request-id';
import type { RequestContext } from './store';
import {
  generateSpanId,
  generateTraceId,
  parseTraceparent,
  sanitizeTracestate,
  TRACEPARENT_HEADER,
  TRACESTATE_HEADER,
} from './w3c';

/** Header bag as produced by Node and Fastify (`IncomingHttpHeaders`) or a plain record. */
export type HeaderBag = Readonly<Record<string, string | readonly string[] | undefined>>;

/** Options for `createRequestContext`. */
export interface RequestContextInput {
  readonly headers?: HeaderBag;
  /** Overrides request-id generation (deterministic tests). */
  readonly generateRequestId?: () => string;
  /** Overrides randomness for trace/span ids (deterministic tests). */
  readonly randomBytes?: RandomBytes;
  /** Sampled flag for traces started here (no valid inbound `traceparent`). Default true. */
  readonly sampled?: boolean;
}

/** Looks a header up case-insensitively; returns the value only when it was sent exactly once. */
export function readSingleHeader(headers: HeaderBag, name: string): string | undefined {
  const direct = headers[name];
  const value =
    direct !== undefined
      ? direct
      : Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
  if (typeof value === 'string') return value;
  return value !== undefined && value.length === 1 ? value[0] : undefined;
}

/**
 * Builds the correlation context for an inbound request: accepts a well-formed `x-request-id` (else
 * generates one), continues a valid `traceparent` (else starts a new trace) and allocates this
 * request's own span id. Hostile or malformed headers are ignored, never echoed.
 */
export function createRequestContext(input: RequestContextInput = {}): RequestContext {
  const headers = input.headers ?? {};
  const random = input.randomBytes ?? secureRandomBytes;
  const incoming = parseTraceparent(readSingleHeader(headers, TRACEPARENT_HEADER));
  const tracestate = incoming
    ? sanitizeTracestate(readSingleHeader(headers, TRACESTATE_HEADER))
    : undefined;
  return {
    requestId:
      acceptRequestId(readSingleHeader(headers, REQUEST_ID_HEADER)) ??
      newRequestId(input.generateRequestId),
    traceId: incoming?.traceId ?? generateTraceId(random),
    spanId: generateSpanId(random),
    ...(incoming ? { parentSpanId: incoming.parentId } : {}),
    traceFlags: incoming?.traceFlags ?? (input.sampled === false ? '00' : '01'),
    ...(tracestate ? { tracestate } : {}),
  };
}
