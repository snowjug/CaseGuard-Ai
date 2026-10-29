import { randomHex, secureRandomBytes, type RandomBytes } from '../ids';

/** Parsed W3C `traceparent` header (https://www.w3.org/TR/trace-context/#traceparent-header). */
export interface TraceParent {
  readonly version: string;
  readonly traceId: string;
  /** Span id of the caller; becomes our parent span id. */
  readonly parentId: string;
  /** Two lower-case hex digits. */
  readonly traceFlags: string;
  readonly sampled: boolean;
}

/** W3C trace context header names. */
export const TRACEPARENT_HEADER = 'traceparent';
export const TRACESTATE_HEADER = 'tracestate';

const TRACEPARENT_MIN_LENGTH = 55;
// Future versions may append fields; a hard cap keeps hostile input from costing more than a length check.
const TRACEPARENT_MAX_LENGTH = 512;
const LOWER_HEX = /^[0-9a-f]+$/;
const ZERO_TRACE_ID = '0'.repeat(32);
const ZERO_SPAN_ID = '0'.repeat(16);

const isLowerHex = (text: string, length: number): boolean =>
  text.length === length && LOWER_HEX.test(text);

/** True for 32 lower-case hex digits that are not all zero. */
export function isValidTraceId(value: string): boolean {
  return isLowerHex(value, 32) && value !== ZERO_TRACE_ID;
}

/** True for 16 lower-case hex digits that are not all zero. */
export function isValidSpanId(value: string): boolean {
  return isLowerHex(value, 16) && value !== ZERO_SPAN_ID;
}

/** True for exactly two lower-case hex digits. */
export function isValidTraceFlags(value: string): boolean {
  return isLowerHex(value, 2);
}

/**
 * Strict `traceparent` parser. Returns `null` for anything malformed: wrong length or separators,
 * upper-case or non-hex digits, version `ff`, all-zero ids, trailing data on version `00`, and any
 * non-string input. Never throws.
 */
export function parseTraceparent(value: unknown): TraceParent | null {
  if (typeof value !== 'string') return null;
  if (value.length < TRACEPARENT_MIN_LENGTH || value.length > TRACEPARENT_MAX_LENGTH) return null;
  const version = value.slice(0, 2);
  if (!isLowerHex(version, 2) || version === 'ff') return null;
  if (value.charAt(2) !== '-' || value.charAt(35) !== '-' || value.charAt(52) !== '-') return null;
  if (version === '00') {
    if (value.length !== TRACEPARENT_MIN_LENGTH) return null;
  } else if (value.length > TRACEPARENT_MIN_LENGTH && value.charAt(55) !== '-') {
    return null;
  }
  const traceId = value.slice(3, 35);
  const parentId = value.slice(36, 52);
  const traceFlags = value.slice(53, 55);
  if (!isValidTraceId(traceId) || !isValidSpanId(parentId) || !isValidTraceFlags(traceFlags)) {
    return null;
  }
  return {
    version,
    traceId,
    parentId,
    traceFlags,
    sampled: (Number.parseInt(traceFlags, 16) & 1) === 1,
  };
}

/** True when `value` is a well-formed `traceparent` header (see `parseTraceparent`). */
export function isValidTraceparent(value: unknown): boolean {
  return parseTraceparent(value) !== null;
}

/** Inputs of `formatTraceparent`. */
export interface TraceparentParts {
  readonly traceId: string;
  readonly spanId: string;
  /** Explicit flags win over `sampled`. */
  readonly traceFlags?: string;
  /** Defaults to true: downstream services should record a trace we started for correlation. */
  readonly sampled?: boolean;
}

/** Formats a version-00 `traceparent`. Throws `TypeError` on invalid ids: that is a programming error. */
export function formatTraceparent(parts: TraceparentParts): string {
  if (!isValidTraceId(parts.traceId))
    throw new TypeError('traceId must be 32 lower-case hex digits and not all zero');
  if (!isValidSpanId(parts.spanId))
    throw new TypeError('spanId must be 16 lower-case hex digits and not all zero');
  const flags = parts.traceFlags ?? (parts.sampled === false ? '00' : '01');
  if (!isValidTraceFlags(flags)) throw new TypeError('traceFlags must be 2 lower-case hex digits');
  return `00-${parts.traceId}-${parts.spanId}-${flags}`;
}

/** New random trace id (never all zero). */
export function generateTraceId(random: RandomBytes = secureRandomBytes): string {
  const id = randomHex(16, random);
  return id === ZERO_TRACE_ID ? `${id.slice(0, 31)}1` : id;
}

/** New random span id (never all zero). */
export function generateSpanId(random: RandomBytes = secureRandomBytes): string {
  const id = randomHex(8, random);
  return id === ZERO_SPAN_ID ? `${id.slice(0, 15)}1` : id;
}

// https://www.w3.org/TR/trace-context/#tracestate-header-field-values
const TRACESTATE_KEY =
  /^(?:[a-z][a-z0-9_*/-]{0,255}|[a-z0-9][a-z0-9_*/-]{0,240}@[a-z][a-z0-9_*/-]{0,13})$/;
const TRACESTATE_VALUE = /^[\x20-\x2b\x2d-\x3c\x3e-\x7e]{0,255}[\x21-\x2b\x2d-\x3c\x3e-\x7e]$/;
const TRACESTATE_MAX_LENGTH = 512;
const TRACESTATE_MAX_MEMBERS = 32;

/** Optional whitespace in a `tracestate` list is space or tab only (not every Unicode space). */
function trimOws(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && (text.charAt(start) === ' ' || text.charAt(start) === '\t')) start += 1;
  while (end > start && (text.charAt(end - 1) === ' ' || text.charAt(end - 1) === '\t')) end -= 1;
  return text.slice(start, end);
}

/**
 * Validates a `tracestate` header. The spec says an invalid header must be discarded entirely, so
 * this returns the normalised value or `undefined`; it never repairs a broken list.
 */
export function sanitizeTracestate(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > TRACESTATE_MAX_LENGTH) {
    return undefined;
  }
  const seen = new Set<string>();
  const members: string[] = [];
  for (const raw of value.split(',')) {
    const member = trimOws(raw);
    if (member === '') continue;
    const separator = member.indexOf('=');
    if (separator <= 0) return undefined;
    const key = member.slice(0, separator);
    const memberValue = member.slice(separator + 1);
    if (!TRACESTATE_KEY.test(key) || !TRACESTATE_VALUE.test(memberValue) || seen.has(key)) {
      return undefined;
    }
    seen.add(key);
    members.push(member);
  }
  return members.length > 0 && members.length <= TRACESTATE_MAX_MEMBERS
    ? members.join(',')
    : undefined;
}
