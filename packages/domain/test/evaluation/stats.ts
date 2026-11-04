/**
 * Plain statistics for the evaluation measures. Pure functions, no engine and no file access.
 */

/** A figure with fewer observations than this is marked `tooFew`: it is a count, not an estimate. */
export const TOO_FEW = 20;

export interface Proportion {
  readonly successes: number;
  /** The number of observations the figure rests on. Always shown next to it. */
  readonly n: number;
  readonly value: number | null;
  /** Wilson 95% interval; null when n is 0. */
  readonly low: number | null;
  readonly high: number | null;
  readonly tooFew: boolean;
}

const Z95 = 1.959963984540054;

/** The Wilson score interval of a proportion (95%). It treats observations as independent, which cases are not. */
export function wilson(successes: number, n: number): { low: number; high: number } | null {
  if (n <= 0) return null;
  const p = successes / n;
  const z2 = Z95 * Z95;
  const denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const margin = (Z95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  // At the ends the bound is exact (floating point would leave it a hair off 0 or 1).
  return {
    low: successes === 0 ? 0 : Math.max(0, centre - margin),
    high: successes === n ? 1 : Math.min(1, centre + margin),
  };
}

export function proportion(successes: number, n: number): Proportion {
  const interval = wilson(successes, n);
  return {
    successes,
    n,
    value: n > 0 ? successes / n : null,
    low: interval ? interval.low : null,
    high: interval ? interval.high : null,
    tooFew: n < TOO_FEW,
  };
}

export interface Counts {
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
}

export interface PrecisionRecall extends Counts {
  readonly precision: Proportion;
  readonly recall: Proportion;
  /** The harmonic mean of the two; null when either is undefined. It is a ratio of counts, so it has no interval. */
  readonly f1: number | null;
}

export function f1Of({ tp, fp, fn }: Counts): number | null {
  const denominator = 2 * tp + fp + fn;
  return denominator === 0 ? null : (2 * tp) / denominator;
}

export function precisionRecall(counts: Counts): PrecisionRecall {
  const { tp, fp, fn } = counts;
  return {
    tp,
    fp,
    fn,
    precision: proportion(tp, tp + fp),
    recall: proportion(tp, tp + fn),
    f1: tp + fp > 0 && tp + fn > 0 ? f1Of(counts) : null,
  };
}

export const addCounts = (a: Counts, b: Counts): Counts => ({
  tp: a.tp + b.tp,
  fp: a.fp + b.fp,
  fn: a.fn + b.fn,
});
export const ZERO_COUNTS: Counts = { tp: 0, fp: 0, fn: 0 };

/** Compares two sets of keys: what both hold, what only the engine holds, what only the labels hold. */
export function compareSets(
  expected: ReadonlySet<string>,
  reported: ReadonlySet<string>,
): { tp: string[]; fp: string[]; fn: string[] } {
  const tp: string[] = [];
  const fp: string[] = [];
  const fn: string[] = [];
  for (const item of reported) (expected.has(item) ? tp : fp).push(item);
  for (const item of expected) if (!reported.has(item)) fn.push(item);
  return { tp: tp.sort(), fp: fp.sort(), fn: fn.sort() };
}

// ---------------------------------------------------------------- calibration

export interface CalibrationBin {
  readonly low: number;
  readonly high: number;
  readonly n: number;
  readonly meanPredicted: number | null;
  readonly observedRate: number | null;
}

export interface Calibration {
  /** The number of (prediction, outcome) pairs. Always shown next to the figures. */
  readonly n: number;
  readonly brier: number | null;
  /** Expected calibration error: the bin-size weighted gap between mean prediction and observed rate. */
  readonly ece: number | null;
  readonly bins: readonly CalibrationBin[];
}

/** Reliability bins of equal width over [0, 1], the Brier score and the expected calibration error. */
export function calibrationOf(
  points: readonly { readonly p: number; readonly outcome: boolean }[],
  binCount = 10,
): Calibration {
  const sums = Array.from({ length: binCount }, () => ({ n: 0, predicted: 0, observed: 0 }));
  let squared = 0;
  for (const { p, outcome } of points) {
    const y = outcome ? 1 : 0;
    squared += (p - y) * (p - y);
    const index = Math.min(binCount - 1, Math.max(0, Math.floor(p * binCount)));
    const bin = sums[index];
    if (bin) {
      bin.n += 1;
      bin.predicted += p;
      bin.observed += y;
    }
  }
  const n = points.length;
  const bins: CalibrationBin[] = sums.map((bin, index) => ({
    low: index / binCount,
    high: (index + 1) / binCount,
    n: bin.n,
    meanPredicted: bin.n > 0 ? bin.predicted / bin.n : null,
    observedRate: bin.n > 0 ? bin.observed / bin.n : null,
  }));
  const ece =
    n === 0
      ? null
      : bins.reduce(
          (sum, bin) =>
            bin.n > 0 && bin.meanPredicted !== null && bin.observedRate !== null
              ? sum + (bin.n / n) * Math.abs(bin.meanPredicted - bin.observedRate)
              : sum,
          0,
        );
  return { n, brier: n === 0 ? null : squared / n, ece, bins };
}

// ---------------------------------------------------------------- agreement between two annotators

export interface Agreement {
  readonly n: number;
  /** Fraction of units on which both gave the same value. */
  readonly observed: number | null;
  /** Cohen's kappa; null when it is undefined (no units, or both annotators always gave one and the same value). */
  readonly kappa: number | null;
}

/** Cohen's kappa for two annotators who each gave one nominal value to every unit. */
export function cohenKappa(pairs: readonly (readonly [string, string])[]): Agreement {
  const n = pairs.length;
  if (n === 0) return { n, observed: null, kappa: null };
  let agree = 0;
  const marginA = new Map<string, number>();
  const marginB = new Map<string, number>();
  for (const [a, b] of pairs) {
    if (a === b) agree += 1;
    marginA.set(a, (marginA.get(a) ?? 0) + 1);
    marginB.set(b, (marginB.get(b) ?? 0) + 1);
  }
  const observed = agree / n;
  let expected = 0;
  for (const [value, countA] of marginA) expected += (countA / n) * ((marginB.get(value) ?? 0) / n);
  const kappa = expected >= 1 ? null : (observed - expected) / (1 - expected);
  return { n, observed, kappa };
}

/** The agreement between two annotators on a yes/no label, with the counts it rests on. */
export interface BinaryAgreement extends Agreement {
  readonly bothYes: number;
  readonly onlyA: number;
  readonly onlyB: number;
  readonly bothNo: number;
  /** 2·both / (2·both + only A + only B): agreement on the positive labels alone, which kappa hides when positives are rare. */
  readonly positiveAgreement: number | null;
}

export function binaryAgreement(counts: {
  bothYes: number;
  onlyA: number;
  onlyB: number;
  bothNo: number;
}): BinaryAgreement {
  const { bothYes, onlyA, onlyB, bothNo } = counts;
  const n = bothYes + onlyA + onlyB + bothNo;
  const denominator = 2 * bothYes + onlyA + onlyB;
  const positiveAgreement = denominator === 0 ? null : (2 * bothYes) / denominator;
  if (n === 0) {
    return { n, observed: null, kappa: null, ...counts, positiveAgreement };
  }
  const observed = (bothYes + bothNo) / n;
  const yesA = (bothYes + onlyA) / n;
  const yesB = (bothYes + onlyB) / n;
  const expected = yesA * yesB + (1 - yesA) * (1 - yesB);
  const kappa = expected >= 1 ? null : (observed - expected) / (1 - expected);
  return { n, observed, kappa, ...counts, positiveAgreement };
}
