import { describe, expect, it } from 'vitest';
import { CASE_ONE, CASE_TWO } from '../../../../test/review-fixtures';
import { deriveChronology } from './chronology';
import { STRIP, layoutStrip, staggerLevels } from './strip';

describe('[REV-STRIP-01] laying out the chronology strip', () => {
  it('puts markers that would touch on different levels, and keeps far ones on the first', () => {
    expect(staggerLevels([10, 14, 18, 60], 16, 3)).toEqual([0, 1, 2, 0]);
    expect(staggerLevels([0, 50, 100], 16, 3)).toEqual([0, 0, 0]);
    // When every level is taken, the one whose last marker is furthest away is used.
    expect(staggerLevels([0, 1, 2, 3], 16, 3)).toEqual([0, 1, 2, 0]);
    expect(staggerLevels([], 16, 3)).toEqual([]);
  });

  const one = layoutStrip(
    deriveChronology(
      CASE_ONE.timeline.events,
      CASE_ONE.forks,
      CASE_ONE.detail.resolution?.resolvedAt,
    ),
  );

  it('draws every decision point as a numbered diamond and every key event in the lane of its side', () => {
    const decisions = one.markers.filter((marker) => marker.kind === 'decision');
    expect(decisions.map((marker) => marker.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(decisions.every((marker) => marker.shape === 'diamond')).toBe(true);
    const events = one.markers.filter((marker) => marker.kind === 'event');
    expect(events).toHaveLength(14);
    expect(new Set(events.map((marker) => `${marker.lane}:${marker.shape}`))).toEqual(
      new Set(['customer:circle', 'engineer:square', 'system:triangle']),
    );
  });

  it('never lets two markers of a row sit on top of each other', () => {
    for (const row of ['decisions', 'customer', 'engineer', 'system'] as const) {
      const inRow = one.markers.filter((marker) => marker.lane === row);
      for (const [i, a] of inRow.entries())
        for (const b of inRow.slice(i + 1))
          expect(Math.hypot(a.x - b.x, a.y - b.y), `${a.id} and ${b.id}`).toBeGreaterThanOrEqual(
            12,
          );
    }
  });

  it('keeps everything inside the plot, and the rows inside the picture', () => {
    for (const marker of one.markers) {
      expect(marker.x).toBeGreaterThanOrEqual(one.plot.x1);
      expect(marker.x).toBeLessThanOrEqual(one.plot.x2);
      expect(marker.y).toBeGreaterThan(0);
      expect(marker.y).toBeLessThan(one.height);
    }
    expect(one.rows.map((row) => row.label)).toEqual([
      'Decision points',
      'Customer',
      'Engineer',
      'System',
    ]);
    expect(one.width).toBe(STRIP.width);
  });

  it('shades each wait and names its length only where there is room for the words', () => {
    expect(one.waits).toHaveLength(4);
    for (const wait of one.waits) {
      expect(wait.width).toBeGreaterThan(0);
      if (wait.label !== null) expect(wait.width).toBeGreaterThanOrEqual(78);
    }
    expect(one.waits.find((wait) => wait.id === 'e14-e15')?.label).toBe('15 h 10 min');
    expect(one.waits.some((wait) => wait.label === null)).toBe(true);
  });

  it('marks where each day begins, without crowding the axis', () => {
    expect(one.axis.days.map((day) => day.label)).toEqual(['9 Mar', '10 Mar', '11 Mar', '12 Mar']);
  });

  it('has an empty decision row for a case without decision points', () => {
    const two = layoutStrip(deriveChronology(CASE_TWO.timeline.events, CASE_TWO.forks));
    expect(two.markers.filter((marker) => marker.kind === 'decision')).toEqual([]);
    expect(two.waits).toEqual([]);
    expect(two.markers.length).toBeGreaterThan(0);
  });
});
