/**
 * Result normalisation shared by both database drivers, so repositories never see driver
 * differences: timestamptz -> ISO-8601 strings ending in `Z` with millisecond precision,
 * 64-bit integers -> numbers (never BigInt), numeric -> number. jsonb is already parsed to plain
 * objects by both drivers.
 */

/** PostgreSQL type OIDs that need normalising. */
export const PG_OID = {
  int8: 20,
  numeric: 1700,
  timestamptz: 1184,
} as const;

const TIMESTAMP_PATTERN =
  /^(\d{4,})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?\s*(Z|[+-]\d{2}(?::?\d{2}(?::?\d{2})?)?)?$/;

/**
 * Parses PostgreSQL's text form of timestamptz (e.g. `2024-01-02 03:04:05.123456+05:30`, whatever
 * the session time zone is) into a UTC ISO string with millisecond precision. Sub-millisecond
 * digits are truncated. `infinity` and anything unrecognised pass through unchanged.
 */
export function parseTimestamptz(text: string): string {
  const match = TIMESTAMP_PATTERN.exec(text);
  if (!match) return text;
  const [, year, month, day, hour, minute, second, fraction, zone] = match;
  const millis = fraction ? Number(fraction.padEnd(3, '0').slice(0, 3)) : 0;
  const instant = new Date(0);
  instant.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  instant.setUTCHours(Number(hour), Number(minute), Number(second), millis);
  return new Date(instant.getTime() - zoneOffsetMs(zone)).toISOString();
}

function zoneOffsetMs(zone: string | undefined): number {
  if (!zone || zone === 'Z') return 0;
  const sign = zone.startsWith('-') ? -1 : 1;
  const digits = zone.slice(1).replace(/:/g, '');
  const hours = Number(digits.slice(0, 2));
  const minutes = digits.length >= 4 ? Number(digits.slice(2, 4)) : 0;
  const seconds = digits.length >= 6 ? Number(digits.slice(4, 6)) : 0;
  return sign * ((hours * 60 + minutes) * 60 + seconds) * 1000;
}

/** 64-bit integers become numbers; values beyond 2^53 stay strings rather than becoming BigInt. */
export function parseInt8(text: string): number | string {
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : text;
}

export function parseNumeric(text: string): number {
  return Number(text);
}

/** Parsers keyed by OID, in the shape PGlite's `parsers` option expects. */
export const PGLITE_PARSERS: Record<number, (value: string) => unknown> = {
  [PG_OID.timestamptz]: parseTimestamptz,
  [PG_OID.int8]: parseInt8,
  [PG_OID.numeric]: parseNumeric,
};

/** Defence in depth: converts any value a driver still returns in a driver-specific shape. */
export function normalizeValue(value: unknown): unknown {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
  }
  return value;
}

export function normalizeRows<T>(rows: readonly unknown[]): T[] {
  return rows.map((row) => {
    if (row === null || typeof row !== 'object') return row as T;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) out[key] = normalizeValue(value);
    return out as T;
  });
}

/** Bind-parameter rules shared by both drivers (see `toJsonParam` for jsonb). */
export function normalizeParams(params: readonly unknown[] | undefined): unknown[] | undefined {
  if (!params || params.length === 0) return undefined;
  return params.map((param, index) => normalizeParam(param, index));
}

function normalizeParam(param: unknown, index: number): unknown {
  if (param === undefined || param === null) return null;
  if (param instanceof Date) return param.toISOString();
  switch (typeof param) {
    case 'string':
    case 'number':
    case 'boolean':
      return param;
    case 'bigint':
      throw new TypeError(`Bind parameter $${index + 1} is a bigint; use a number or a string`);
    default:
      break;
  }
  if (Array.isArray(param)) {
    const primitives = param.every(
      (item) => item === null || ['string', 'number', 'boolean'].includes(typeof item),
    );
    if (!primitives) {
      throw new TypeError(`Bind parameter $${index + 1} is an array of non-primitive values`);
    }
    return param;
  }
  throw new TypeError(
    `Bind parameter $${index + 1} is an object; pass JSON as a string produced by toJsonParam()`,
  );
}

/** Serialises a value for a jsonb bind parameter (both drivers accept the JSON text unchanged). */
export function toJsonParam(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) throw new TypeError('The value has no JSON representation');
  return text;
}
