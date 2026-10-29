/** "Known at" is always an instant comparison: ISO strings of different precision do not sort like instants. */
export function knownBy(asOf: string | null): (iso: string) => boolean {
  if (asOf === null) return () => true;
  const limit = Date.parse(asOf);
  return (iso) => Date.parse(iso) <= limit;
}

/** Millisecond-precision UTC form of an ISO timestamp (the form cursors and review keys use). */
export function canonicalInstant(iso: string): string {
  return new Date(iso).toISOString();
}

/** Orders two ISO timestamps as instants. */
export function compareInstants(a: string, b: string): number {
  return Date.parse(a) - Date.parse(b);
}

/** Orders strings by code unit, the same way on every machine (unlike locale collation). */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
