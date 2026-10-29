/**
 * Seeded pseudo-random number generation. Every stochastic computation (uncertainty bands,
 * counterfactual rollouts) takes one of these so results are reproducible and testable.
 */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Integer in [0, max). */
  int(max: number): number;
  /** Standard normal via Box-Muller. */
  normal(): number;
  /** Triangular distribution between min and max with the given mode. */
  triangular(min: number, mode: number, max: number): number;
  /** Index drawn proportionally to non-negative weights. */
  weighted(weights: readonly number[]): number;
}

/** FNV-1a hash of a string to an unsigned 32-bit seed. */
export function seedFromString(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function createRng(seed: string | number): Rng {
  let state = (typeof seed === 'string' ? seedFromString(seed) : seed >>> 0) || 0x9e3779b9;
  const next = (): number => {
    // mulberry32
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (max) => Math.floor(next() * Math.max(1, max)),
    normal: () => {
      const u = Math.max(next(), 1e-12);
      const v = next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    triangular: (min, mode, max) => {
      if (max <= min) return min;
      const u = next();
      const c = (mode - min) / (max - min);
      return u < c
        ? min + Math.sqrt(u * (max - min) * (mode - min))
        : max - Math.sqrt((1 - u) * (max - min) * (max - mode));
    },
    weighted: (weights) => {
      const total = weights.reduce((s, w) => s + Math.max(0, w), 0);
      if (total <= 0) return Math.floor(next() * weights.length);
      let r = next() * total;
      for (let i = 0; i < weights.length; i++) {
        r -= Math.max(0, weights[i] ?? 0);
        if (r <= 0) return i;
      }
      return weights.length - 1;
    },
  };
}
