/** Pure scale helpers for the dependency-free SVG charts. No DOM, no React. */

export interface LinearScale {
  (value: number): number;
  readonly domain: readonly [number, number];
  readonly range: readonly [number, number];
  /** Maps a pixel position back to a data value (clamped to the range). */
  invert: (pixel: number) => number;
}

/**
 * Linear map from `domain` to `range`. A degenerate domain (min === max, e.g. a single data point) maps every value
 * to the middle of the range so one-point charts stay centred instead of dividing by zero.
 */
export function linearScale(
  domain: readonly [number, number],
  range: readonly [number, number],
): LinearScale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  const scale = ((value: number): number => {
    if (span === 0) return (r0 + r1) / 2;
    return r0 + ((value - d0) / span) * (r1 - r0);
  }) as LinearScale;
  const invert = (pixel: number): number => {
    const rangeSpan = r1 - r0;
    if (rangeSpan === 0 || span === 0) return d0;
    const t = Math.min(1, Math.max(0, (pixel - r0) / rangeSpan));
    return d0 + t * span;
  };
  return Object.assign(scale, { domain, range, invert });
}

/** Extent (min and max) of the finite values, or `null` when there are none. */
export function extent(values: readonly number[]): [number, number] | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return min === Number.POSITIVE_INFINITY ? null : [min, max];
}

function niceNumber(range: number, round: boolean): number {
  const exponent = Math.floor(Math.log10(range));
  const fraction = range / 10 ** exponent;
  let nice: number;
  if (round) nice = fraction < 1.5 ? 1 : fraction < 3 ? 2 : fraction < 7 ? 5 : 10;
  else nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return nice * 10 ** exponent;
}

function decimalsOf(step: number): number {
  if (step >= 1) return 0;
  return Math.min(6, Math.ceil(-Math.log10(step)) + 1);
}

/**
 * "Nice" axis ticks covering [min, max] with roughly `count` ticks (1, 2, 5 x 10^n steps).
 * Returns a single tick for a degenerate range.
 */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  const [lo, hi] = min < max ? [min, max] : [max, min];
  const step = niceNumber(niceNumber(hi - lo, false) / Math.max(1, count - 1), true);
  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;
  const decimals = decimalsOf(step);
  const ticks: number[] = [];
  for (let value = start; value <= end + step / 2; value += step) {
    ticks.push(Number(value.toFixed(decimals)));
  }
  return ticks;
}

/** Domain widened to the outer "nice" ticks. A degenerate domain is padded so the value sits mid-chart. */
export function niceDomain(min: number, max: number, count = 5): [number, number] {
  if (min === max) {
    const pad = min === 0 ? 1 : Math.abs(min) * 0.1;
    return [min - pad, max + pad];
  }
  const ticks = niceTicks(min, max, count);
  const first = ticks[0];
  const last = ticks[ticks.length - 1];
  return first === undefined || last === undefined ? [min, max] : [first, last];
}

/** Prefix sums: `cumulative([2, 3, 4])` is `[0, 2, 5]` (the start offset of each part). Used instead of mutating a running total in render. */
export function cumulative(values: readonly number[]): number[] {
  const starts: number[] = [];
  let total = 0;
  for (const value of values) {
    starts.push(total);
    total += value;
  }
  return starts;
}

export interface Band {
  /** Left (or top) edge of the band. */
  start: number;
  /** Size of the drawn bar inside the step. */
  size: number;
  /** Centre of the band. */
  center: number;
}

/**
 * Evenly spaced bands for categorical axes. `padding` is the fraction of each step left empty (0-0.9).
 * Returns one band per key in order; an empty list yields no bands.
 */
export function bandScale(count: number, range: readonly [number, number], padding = 0.25): Band[] {
  if (count <= 0) return [];
  const [r0, r1] = range;
  const step = (r1 - r0) / count;
  const clamped = Math.min(0.9, Math.max(0, padding));
  const size = step * (1 - clamped);
  return Array.from({ length: count }, (_, index) => {
    const start = r0 + index * step + (step - size) / 2;
    return { start, size, center: start + size / 2 };
  });
}

/**
 * Cheap text-width estimate (px) used to size label gutters and truncate labels without measuring the DOM.
 * Narrow glyphs count less than wide ones; precise enough to prevent overlaps with a small safety margin.
 */
export function estimateTextWidth(text: string, fontSize: number): number {
  let units = 0;
  for (const char of text) {
    if ('iltfjI.,;:|!\'"`'.includes(char)) units += 0.34;
    else if ('mwMW@%'.includes(char)) units += 0.92;
    else if (char >= 'A' && char <= 'Z') units += 0.68;
    else if (char === ' ') units += 0.3;
    else units += 0.55;
  }
  return units * fontSize;
}

/** Truncates `text` with an ellipsis so its estimated width fits `maxWidth`. */
export function truncateToWidth(text: string, maxWidth: number, fontSize: number): string {
  if (maxWidth <= 0) return '';
  if (estimateTextWidth(text, fontSize) <= maxWidth) return text;
  const ellipsis = '…';
  const budget = maxWidth - estimateTextWidth(ellipsis, fontSize);
  if (budget <= 0) return ellipsis;
  let result = '';
  for (const char of text) {
    if (estimateTextWidth(result + char, fontSize) > budget) break;
    result += char;
  }
  return `${result.trimEnd()}${ellipsis}`;
}
