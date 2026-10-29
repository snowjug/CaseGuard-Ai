import type { LogDestination, RandomBytes } from '../../src';

/** Settable wall clock for deterministic tests. */
export function createManualClock(startMs = Date.UTC(2026, 0, 1, 12, 0, 0)) {
  let now = startMs;
  return {
    now: (): number => now,
    advance(ms: number): void {
      now += ms;
    },
    set(ms: number): void {
      now = ms;
    },
  };
}

/** Settable monotonic clock (milliseconds). */
export function createManualMonotonic(startMs = 1000) {
  let now = startMs;
  return {
    now: (): number => now,
    advance(ms: number): void {
      now += ms;
    },
  };
}

/** In-memory log destination that also validates every line is a JSON object. */
export function createCapture() {
  const lines: string[] = [];
  const destination: LogDestination = {
    write(chunk: string): void {
      lines.push(chunk);
    },
  };
  return {
    destination,
    lines,
    /** Parsed records; throws if any line is not valid JSON, which is itself a test failure. */
    records(): Record<string, unknown>[] {
      return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    },
    text(): string {
      return lines.join('');
    },
  };
}

/** Deterministic byte source (mulberry32) so ids and trace ids are reproducible. */
export function seededBytes(seed: number): RandomBytes {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
  return (size) => {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) bytes[i] = next() & 0xff;
    return bytes;
  };
}

/** Seeded uniform random numbers in [0, 1). */
export function seededRandom(seed: number): () => number {
  const bytes = seededBytes(seed);
  return () => {
    const view = bytes(4);
    return (
      ((view[0] ?? 0) * 2 ** 24 +
        (view[1] ?? 0) * 2 ** 16 +
        (view[2] ?? 0) * 2 ** 8 +
        (view[3] ?? 0)) /
      2 ** 32
    );
  };
}
