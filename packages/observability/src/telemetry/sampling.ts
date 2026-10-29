/**
 * Deterministic sampling. A key (a trace id, a request id) maps to the same point of [0, 1) for a
 * given seed, so every process and replay makes the same decision and sampled data stays consistent
 * across services; no random source is involved.
 */

/** Seeded uniform random numbers in [0, 1) (mulberry32). Inject into code that needs a sampler stream. */
export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

/** Maps `key` and `seed` to a stable, well-spread point in [0, 1) (murmur3-style 32-bit mix). */
export function hashToUnitInterval(key: string, seed = 0): number {
  let hash = (seed ^ 0x9e3779b9) >>> 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = Math.imul(hash ^ key.charCodeAt(i), 0x85ebca6b);
    hash ^= hash >>> 13;
    hash = Math.imul(hash, 0xc2b2ae35);
    hash ^= hash >>> 16;
  }
  hash ^= key.length;
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 2 ** 32;
}

/** Clamps a ratio into [0, 1]; NaN means "sample nothing". */
export function clampRatio(ratio: number): number {
  if (Number.isNaN(ratio)) return 0;
  return Math.min(1, Math.max(0, ratio));
}

/** True for roughly `ratio` of all keys, always the same ones for the same `seed`. */
export function shouldSample(key: string, ratio: number, seed = 0): boolean {
  const clamped = clampRatio(ratio);
  if (clamped >= 1) return true;
  if (clamped <= 0) return false;
  return hashToUnitInterval(key, seed) < clamped;
}

/** Options for `createSampler`. */
export interface SamplerOptions {
  readonly ratio: number;
  readonly seed?: number;
}

/** Sampler bound to a ratio (for example `OTEL_SAMPLING_RATIO`) and seed. */
export function createSampler(options: SamplerOptions): (key: string) => boolean {
  const ratio = clampRatio(options.ratio);
  const seed = options.seed ?? 0;
  return (key) => shouldSample(key, ratio, seed);
}
