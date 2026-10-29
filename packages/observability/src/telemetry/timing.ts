import { elapsedMs, systemMonotonicClock, type MonotonicClock } from '../clock';

/** A result paired with how long it took. */
export interface Timed<T> {
  readonly result: T;
  readonly durationMs: number;
}

/** Outcome and duration reported by `measure`. */
export interface Measurement {
  readonly durationMs: number;
  readonly ok: boolean;
  /** The thrown value when `ok` is false. */
  readonly error?: unknown;
}

/** Runs `fn` and returns its result with the elapsed milliseconds. Errors propagate unchanged. */
export async function timed<T>(
  fn: () => T | Promise<T>,
  clock: MonotonicClock = systemMonotonicClock,
): Promise<Timed<T>> {
  const start = clock();
  const result = await fn();
  return { result, durationMs: elapsedMs(start, clock()) };
}

/** Synchronous variant of `timed`. */
export function timedSync<T>(fn: () => T, clock: MonotonicClock = systemMonotonicClock): Timed<T> {
  const start = clock();
  const result = fn();
  return { result, durationMs: elapsedMs(start, clock()) };
}

/**
 * Runs `fn` and always reports duration and outcome to `onComplete`, then returns the result or
 * rethrows the original error. A throwing `onComplete` surfaces to the caller (on a failed run it
 * replaces the original error), so pass recorders that cannot throw, such as the product metrics helpers.
 */
export async function measure<T>(
  fn: () => T | Promise<T>,
  onComplete: (measurement: Measurement) => void,
  clock: MonotonicClock = systemMonotonicClock,
): Promise<T> {
  const start = clock();
  let result: T;
  try {
    result = await fn();
  } catch (error) {
    onComplete({ durationMs: elapsedMs(start, clock()), ok: false, error });
    throw error;
  }
  onComplete({ durationMs: elapsedMs(start, clock()), ok: true });
  return result;
}

/** Reads elapsed time on demand. */
export interface Stopwatch {
  /** Milliseconds since the stopwatch started. */
  elapsedMs(): number;
}

/** Creates a stopwatch that reports milliseconds elapsed since this call. */
export function createStopwatch(clock: MonotonicClock = systemMonotonicClock): Stopwatch {
  const start = clock();
  return { elapsedMs: () => elapsedMs(start, clock()) };
}
