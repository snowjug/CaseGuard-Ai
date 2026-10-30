/** Time helpers for the temporal views. All instants are UTC ISO-8601 strings, compared as instants. */

/**
 * The instant just before a decision: what was known when it was taken. The decision event itself is stamped at the
 * decision time, so a window that includes it already contains the decision; one second earlier does not.
 */
export function instantBefore(timestamp: string): string {
  const ms = Date.parse(timestamp);
  if (!Number.isFinite(ms)) return timestamp;
  return new Date(ms - 1000).toISOString().replace('.000Z', 'Z');
}

/** `timestamp` plus `minutes`, as an ISO string. */
export function addMinutes(timestamp: string, minutes: number): string {
  return new Date(Date.parse(timestamp) + minutes * 60_000).toISOString();
}

/** Minutes from `from` to `to` (negative when `to` is earlier). */
export function minutesBetween(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / 60_000;
}

/** True when the instant `a` is strictly later than `b`. */
export function isAfter(a: string, b: string): boolean {
  return Date.parse(a) > Date.parse(b);
}
