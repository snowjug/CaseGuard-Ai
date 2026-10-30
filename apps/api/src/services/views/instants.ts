import { ValidationFailedError } from '../../errors';

/** "Known at" is always an instant comparison: ISO strings of different precision do not sort like instants. */
export function knownBy(asOf: string | null): (iso: string) => boolean {
  if (asOf === null) return () => true;
  const limit = Date.parse(asOf);
  return (iso) => Date.parse(iso) <= limit;
}

/** Millisecond-precision UTC form of an ISO timestamp (the form cursors, review keys and caches use). */
export function canonicalInstant(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new ValidationFailedError('Expected a UTC ISO-8601 timestamp', [
      { path: 'asOf', message: 'Not a valid instant' },
    ]);
  }
  return new Date(ms).toISOString();
}

const CANONICAL_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** The time (ms) of text written exactly the way `canonicalInstant` writes an instant; null for any other text. */
export function parseCanonicalInstant(text: string): number | null {
  if (!CANONICAL_INSTANT.test(text)) return null;
  const ms = Date.parse(text);
  // The round trip refuses dates the parser would silently roll over, such as February 30th.
  return !Number.isNaN(ms) && new Date(ms).toISOString() === text ? ms : null;
}

/** Orders two ISO timestamps as instants. */
export function compareInstants(a: string, b: string): number {
  return Date.parse(a) - Date.parse(b);
}

/** Orders strings by code unit, the same way on every machine (unlike locale collation). */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
