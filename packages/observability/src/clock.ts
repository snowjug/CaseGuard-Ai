import { performance } from 'node:perf_hooks';

/** Wall-clock reading in epoch milliseconds. Inject a fixed clock in tests. */
export type Clock = () => number;

/** Monotonic reading in fractional milliseconds, used for durations so clock jumps cannot yield negative latencies. */
export type MonotonicClock = () => number;

/** Wall clock backed by `Date.now()`. */
export const systemClock: Clock = () => Date.now();
/** Monotonic clock backed by `performance.now()`. */
export const systemMonotonicClock: MonotonicClock = () => performance.now();

const MAX_DATE_MS = 8.64e15;

/**
 * ISO-8601 UTC timestamp for a clock reading. An unusable reading (NaN, out of the Date range)
 * degrades to the epoch instead of throwing, because this runs inside logging and health paths.
 */
export function toIsoTimestamp(epochMs: number): string {
  const usable = Number.isFinite(epochMs) && Math.abs(epochMs) <= MAX_DATE_MS ? epochMs : 0;
  return new Date(usable).toISOString();
}

/** Elapsed milliseconds between two monotonic readings, never negative and never NaN. */
export function elapsedMs(startMs: number, endMs: number): number {
  const elapsed = endMs - startMs;
  return Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0;
}
