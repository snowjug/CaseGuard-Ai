import { describe, expect, it } from 'vitest';
import { arcPath, bandPath, linePath, markerPath, polar } from './paths';
import {
  bandScale,
  estimateTextWidth,
  extent,
  linearScale,
  niceDomain,
  niceTicks,
  truncateToWidth,
} from './scales';

describe('linearScale', () => {
  it('maps the domain onto the range and back', () => {
    const scale = linearScale([0, 10], [100, 300]);
    expect(scale(0)).toBe(100);
    expect(scale(5)).toBe(200);
    expect(scale(10)).toBe(300);
    expect(scale.invert(200)).toBe(5);
    expect(scale.invert(9999)).toBe(10);
  });

  it('supports inverted ranges (SVG y axes grow downwards)', () => {
    const scale = linearScale([0, 100], [200, 0]);
    expect(scale(0)).toBe(200);
    expect(scale(100)).toBe(0);
    expect(scale(25)).toBe(150);
  });

  it('centres a degenerate domain instead of dividing by zero (single-point charts)', () => {
    const scale = linearScale([7, 7], [0, 100]);
    expect(scale(7)).toBe(50);
    expect(Number.isFinite(scale(123))).toBe(true);
  });
});

describe('ticks and domains', () => {
  it('produces nice 1-2-5 ticks that cover the data', () => {
    expect(niceTicks(0, 100, 5)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(0, 1, 6)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    const ticks = niceTicks(3.2, 97.5, 5);
    expect(ticks[0]).toBeLessThanOrEqual(3.2);
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(97.5);
  });

  it('keeps floating point noise out of tick values', () => {
    for (const tick of niceTicks(0, 0.7, 8)) {
      expect(String(tick).length).toBeLessThan(6);
    }
  });

  it('handles degenerate and invalid input', () => {
    expect(niceTicks(5, 5)).toEqual([5]);
    expect(niceTicks(Number.NaN, 5)).toEqual([]);
    expect(niceDomain(5, 5)).toEqual([4.5, 5.5]);
    expect(niceDomain(0, 0)).toEqual([-1, 1]);
    expect(niceDomain(0, 87)).toEqual([0, 100]);
  });

  it('computes extents while ignoring non-finite values', () => {
    expect(extent([3, 1, Number.NaN, 7])).toEqual([1, 7]);
    expect(extent([])).toBeNull();
  });
});

describe('bandScale', () => {
  it('lays out evenly spaced non-overlapping bands', () => {
    const bands = bandScale(4, [0, 400], 0.2);
    expect(bands).toHaveLength(4);
    for (let i = 1; i < bands.length; i++) {
      const previous = bands[i - 1];
      const current = bands[i];
      expect(previous && current && previous.start + previous.size <= current.start).toBe(true);
    }
    expect(bands[0]?.center).toBeCloseTo(50, 5);
  });

  it('returns nothing for an empty category list', () => {
    expect(bandScale(0, [0, 100])).toEqual([]);
  });
});

describe('text measurement', () => {
  it('measures narrow glyphs as narrower than wide ones', () => {
    expect(estimateTextWidth('iiii', 12)).toBeLessThan(estimateTextWidth('mmmm', 12));
  });

  it('truncates with an ellipsis so the result fits the width', () => {
    const text = 'Collect the full proxy configuration before escalating';
    const truncated = truncateToWidth(text, 120, 12);
    expect(truncated.endsWith('…')).toBe(true);
    expect(estimateTextWidth(truncated, 12)).toBeLessThanOrEqual(120);
    expect(truncateToWidth('short', 120, 12)).toBe('short');
    expect(truncateToWidth('anything', 0, 12)).toBe('');
  });
});

describe('path builders', () => {
  it('builds a polyline and breaks it on gaps', () => {
    expect(
      linePath([
        [0, 0],
        [10, 5],
        [20, 0],
      ]),
    ).toBe('M0 0L10 5L20 0');
    expect(linePath([[0, 0], null, [20, 0], [30, 5]])).toBe('M0 0 M20 0L30 5');
    expect(linePath([])).toBe('');
  });

  it('builds a closed band polygon from two edges', () => {
    const d = bandPath(
      [
        [0, 0],
        [10, 0],
      ],
      [
        [0, 5],
        [10, 5],
      ],
    );
    expect(d).toBe('M0 0L10 0L10 5L0 5Z');
    expect(bandPath([], [])).toBe('');
    expect(bandPath([[0, 0]], [])).toBe('');
  });

  it("computes polar points and arcs clockwise from 12 o'clock", () => {
    const top = polar(50, 50, 40, 0);
    expect(top[0]).toBeCloseTo(50, 5);
    expect(top[1]).toBeCloseTo(10, 5);
    const right = polar(50, 50, 40, 90);
    expect(right[0]).toBeCloseTo(90, 5);
    expect(arcPath(50, 50, 40, 0, 90)).toMatch(/^M50 10A40 40 0 0 1 90 50$/);
    expect(arcPath(50, 50, 40, 0, 270)).toContain(' 0 1 1 ');
    expect(arcPath(50, 50, 40, 0, 0)).toBe('');
    expect(arcPath(50, 50, 40, 0, 360)).not.toBe('');
  });

  it('draws each marker shape as a closed path', () => {
    for (const shape of ['circle', 'square', 'triangle', 'diamond'] as const) {
      expect(markerPath(shape, 10, 10, 4).endsWith('Z')).toBe(true);
    }
  });
});
