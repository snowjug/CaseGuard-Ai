import type { Attributes, AttributeValue } from '@opentelemetry/api';
import { classifyKey } from '../redaction/keys';
import { REDACTED } from '../redaction/rules';
import type { Scrubber } from '../redaction/scrubber';

/** Limits applied to span attributes. */
export interface SpanAttributeLimits {
  readonly maxAttributes?: number;
  readonly maxStringLength?: number;
  readonly maxArrayLength?: number;
}

const ATTRIBUTE_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const DEFAULT_MAX_ATTRIBUTES = 32;
const DEFAULT_MAX_STRING_LENGTH = 256;
const DEFAULT_MAX_ARRAY_LENGTH = 16;

type Primitive = string | number | boolean;

function toPrimitive(value: unknown, scrubber: Scrubber, maxString: number): Primitive | undefined {
  switch (typeof value) {
    case 'string':
      return scrubber.text(value, maxString);
    case 'number':
      return Number.isFinite(value) ? value : undefined;
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    default:
      break;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  }
  return undefined;
}

function toAttributeValue(
  value: unknown,
  scrubber: Scrubber,
  limits: Required<SpanAttributeLimits>,
): AttributeValue | undefined {
  if (!Array.isArray(value)) return toPrimitive(value, scrubber, limits.maxStringLength);
  // OpenTelemetry arrays must be homogeneous: keep the elements that match the first usable one.
  const items: Primitive[] = [];
  let kind: string | undefined;
  for (const element of value as unknown[]) {
    if (items.length >= limits.maxArrayLength) break;
    const primitive = toPrimitive(element, scrubber, limits.maxStringLength);
    if (primitive === undefined) continue;
    kind ??= typeof primitive;
    if (typeof primitive === kind) items.push(primitive);
  }
  if (items.length === 0) return undefined;
  if (kind === 'string') return items as string[];
  if (kind === 'number') return items as number[];
  return items as boolean[];
}

/**
 * Turns caller-supplied span attributes into values that are safe to export: invalid keys are
 * dropped, credential/PII-named keys keep only a placeholder, strings are scrubbed and length
 * limited, arrays are homogeneous and short, and nested objects are dropped entirely (they would
 * need serialising, which is where case content leaks).
 */
export function sanitizeSpanAttributes(
  input: Readonly<Record<string, unknown>> | undefined,
  scrubber: Scrubber,
  limits: SpanAttributeLimits = {},
): Attributes {
  const resolved: Required<SpanAttributeLimits> = {
    maxAttributes: limits.maxAttributes ?? DEFAULT_MAX_ATTRIBUTES,
    maxStringLength: limits.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH,
    maxArrayLength: limits.maxArrayLength ?? DEFAULT_MAX_ARRAY_LENGTH,
  };
  const attributes: Attributes = {};
  if (input === undefined) return attributes;
  let count = 0;
  for (const key of Object.keys(input)) {
    if (count >= resolved.maxAttributes) break;
    if (!ATTRIBUTE_KEY.test(key)) continue;
    if (classifyKey(key) !== 'none') {
      attributes[key] = REDACTED;
      count += 1;
      continue;
    }
    const value = toAttributeValue(input[key], scrubber, resolved);
    if (value === undefined) continue;
    attributes[key] = value;
    count += 1;
  }
  return attributes;
}
