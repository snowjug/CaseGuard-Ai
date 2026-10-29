export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

export const sum = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0);

export const mean = (xs: readonly number[]): number => (xs.length === 0 ? 0 : sum(xs) / xs.length);

export function round(x: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

/** Normalises non-negative weights to sum to 1 (uniform when everything is zero). */
export function normalize(values: readonly number[]): number[] {
  const total = sum(values);
  if (total <= 0 || !Number.isFinite(total))
    return values.map(() => 1 / Math.max(1, values.length));
  return values.map((v) => v / total);
}

/** Shannon entropy in bits of a probability vector. */
export function entropyBits(p: readonly number[]): number {
  let h = 0;
  for (const x of p) if (x > 0) h -= x * Math.log2(x);
  return h;
}

/** KL(p || q) in bits; q is floored so a zero never produces infinity. */
export function klBits(p: readonly number[], q: readonly number[]): number {
  let kl = 0;
  for (let i = 0; i < p.length; i++) {
    const pi = p[i] ?? 0;
    const qi = Math.max(q[i] ?? 0, 1e-9);
    if (pi > 0) kl += pi * Math.log2(pi / qi);
  }
  return Math.max(0, kl);
}

/** Linear-interpolated percentile of a numeric sample (q in [0, 1]). */
export function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = clamp(q, 0, 1) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? a;
  return a + (b - a) * (pos - lo);
}

export function rangeOf(values: readonly number[]): { low: number; mid: number; high: number } {
  return {
    low: percentile(values, 0.1),
    mid: percentile(values, 0.5),
    high: percentile(values, 0.9),
  };
}

export const constantRange = (x: number): { low: number; mid: number; high: number } => ({
  low: x,
  mid: x,
  high: x,
});

/** Jaccard similarity of the word sets of two strings (used for near-duplicate detection). */
export function tokenJaccard(a: string, b: string): number {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (ta.size === 0 && tb.size === 0) return 1;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9._-]+/)
    .filter((t) => t.length > 2);
}

/** Rough token estimate (assumption A-07): ceil(chars / 4). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
