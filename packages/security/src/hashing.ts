import { createHash } from 'node:crypto';

/** Hash recorded as `prevHash` of the first entry in a hash chain. */
export const GENESIS_HASH = '0'.repeat(64);

const MAX_CANONICAL_DEPTH = 200;

/** SHA-256 of a string (hashed as UTF-8) or of raw bytes, as lower-case hex. */
export function sha256Hex(input: string | Uint8Array): string {
  const hash = createHash('sha256');
  if (typeof input === 'string') hash.update(input, 'utf8');
  else hash.update(input);
  return hash.digest('hex');
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasToJson(value: object): value is { toJSON: () => unknown } {
  return typeof (value as { toJSON?: unknown }).toJSON === 'function';
}

function serialize(value: unknown, ancestors: Set<object>, depth: number, path: string): string {
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new RangeError(`canonicalJson: nesting deeper than ${MAX_CANONICAL_DEPTH} at ${path}`);
  }
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(`canonicalJson: NaN and Infinity cannot be serialized (at ${path})`);
      }
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new TypeError(`canonicalJson: ${typeof value} cannot be serialized (at ${path})`);
  }

  if (ancestors.has(value)) throw new TypeError(`canonicalJson: circular reference at ${path}`);
  ancestors.add(value);
  try {
    if (hasToJson(value)) return serialize(value.toJSON(), ancestors, depth + 1, path);
    if (Array.isArray(value)) {
      const items = (value as unknown[]).map((item, index) =>
        item === undefined ? 'null' : serialize(item, ancestors, depth + 1, `${path}[${index}]`),
      );
      return `[${items.join(',')}]`;
    }
    if (!isPlainObject(value)) {
      throw new TypeError(
        `canonicalJson: only plain objects and arrays are supported (at ${path})`,
      );
    }
    const record = value as Record<string, unknown>;
    const members: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const member = record[key];
      if (member === undefined) continue;
      members.push(
        `${JSON.stringify(key)}:${serialize(member, ancestors, depth + 1, `${path}.${key}`)}`,
      );
    }
    return `{${members.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Deterministic JSON: object keys sorted, `undefined` properties dropped, no whitespace. Equal data
 * always yields the same string, which makes it safe to hash. Rejects NaN/Infinity, cycles,
 * bigint/function/symbol values and non-plain objects instead of silently changing them.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) throw new TypeError('canonicalJson: undefined cannot be serialized');
  return serialize(value, new Set<object>(), 0, '$');
}

/** Next link of a tamper-evident chain: `sha256(prevHash + "\n" + canonicalJson(payload))`. */
export function hashChain(prevHash: string, payload: unknown): string {
  return sha256Hex(`${prevHash}\n${canonicalJson(payload)}`);
}
