import { createHash } from 'node:crypto';

/** Lower-case hex SHA-256 of a string (hashed as UTF-8) or a byte array. */
export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Deterministic JSON used wherever a hash must be reproducible: object keys are sorted, there is no
 * insignificant whitespace and `undefined` properties are omitted. Values without a stable JSON
 * form (NaN, Infinity, bigint) are rejected instead of being silently coerced.
 */
export function canonicalJson(value: unknown): string {
  const encoded = canonicalize(value);
  if (encoded === undefined) {
    throw new TypeError('canonicalJson: the value has no JSON representation');
  }
  return encoded;
}

function canonicalize(value: unknown): string | undefined {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError('canonicalJson: non-finite numbers cannot be hashed');
      }
      return JSON.stringify(value);
    case 'bigint':
      throw new TypeError('canonicalJson: bigint values cannot be hashed');
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
    default:
      break;
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item) ?? 'null').join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.toJSON === 'function') {
    return canonicalize((record.toJSON as () => unknown).call(record));
  }
  const parts: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const encoded = canonicalize(record[key]);
    if (encoded !== undefined) parts.push(`${JSON.stringify(key)}:${encoded}`);
  }
  return `{${parts.join(',')}}`;
}
