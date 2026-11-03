import { describe, expect, it } from 'vitest';
import {
  CaseBundleSchema,
  DEFAULT_QUALITY_CONFIG,
  PENALTY_KEYS,
  QUALITY_DIMENSIONS,
  type QualityAssessment,
  type QualityConfig,
} from '@caseguard/schemas';
import { computeQualityReview, computeQualityReviewAsOf } from '../src';
import {
  CASE_ONE,
  CASE_TWO,
  CONFIG,
  loadBundle,
  prepareBundle,
  prepareCase,
  type Prepared,
} from './helpers';

/*
 * An audit of the Case Quality Index as a set of executable statements (wave 2). It changes nothing: weights, penalty
 * points, the cap and the bands are the shipped defaults, and every figure below is what they produce today. Where the
 * audit found something a reader should know, the test says so in its name and docs/SCORE_AUDIT.md explains it.
 */

const SAMPLES = [
  ['Case One', CASE_ONE],
  ['Case Two', CASE_TWO],
] as const;

const review = (p: Prepared, config: QualityConfig = DEFAULT_QUALITY_CONFIG): QualityAssessment =>
  computeQualityReview({
    analysis: p.analysis,
    pack: p.pack,
    ctx: p.ctx,
    config,
    actionConfig: CONFIG,
  });

const asOfEvery = (p: Prepared): QualityAssessment[] =>
  p.normalized.events.map((event) =>
    computeQualityReviewAsOf({
      events: p.normalized.events,
      resolution: p.normalized.resolution,
      asOf: event.timestamp,
      pack: p.pack,
      ctx: p.ctx,
      actionConfig: CONFIG,
    }),
  );

const bandIndex = (value: number, bands = DEFAULT_QUALITY_CONFIG.bands): number =>
  value >= bands.strong ? 3 : value >= bands.adequate ? 2 : value >= bands.needsAttention ? 1 : 0;

const prepared = Object.fromEntries(
  SAMPLES.map(([name, file]) => [name, prepareCase(file)]),
) as Record<(typeof SAMPLES)[number][0], Prepared>;

describe('score audit: the configuration', () => {
  const { weights, penaltyPoints, penaltyCap, bands } = DEFAULT_QUALITY_CONFIG;

  it('weights every dimension and sums to one', () => {
    expect(Object.keys(weights).sort()).toEqual([...QUALITY_DIMENSIONS].sort());
    for (const key of QUALITY_DIMENSIONS) expect(weights[key]).toBeGreaterThan(0);
    expect(QUALITY_DIMENSIONS.reduce((sum, key) => sum + (weights[key] ?? 0), 0)).toBeCloseTo(1, 9);
  });

  it('prices every penalty, each below the cap, so no single failure can exhaust it', () => {
    expect(Object.keys(penaltyPoints).sort()).toEqual([...PENALTY_KEYS].sort());
    for (const key of PENALTY_KEYS) {
      expect(penaltyPoints[key], key).toBeGreaterThan(0);
      expect(penaltyPoints[key], key).toBeLessThan(penaltyCap);
    }
  });

  it('orders the bands strictly, inside 0 to 100', () => {
    expect(bands.strong).toBeGreaterThan(bands.adequate);
    expect(bands.adequate).toBeGreaterThan(bands.needsAttention);
    expect(bands.needsAttention).toBeGreaterThan(0);
    expect(bands.strong).toBeLessThanOrEqual(100);
  });
});

describe('score audit: the figure can be rebuilt from what is published', () => {
  for (const [name] of SAMPLES) {
    const result = review(prepared[name]);

    it(`${name}: composite = sum(weight x raw score) - min(cap, penalty points), and the displayed dimension scores add up to it`, () => {
      const weightedRaw = result.dimensions.reduce((sum, d) => sum + d.weight * d.rawScore, 0);
      const deduction = Math.min(DEFAULT_QUALITY_CONFIG.penaltyCap, result.totalPenaltyPoints);
      expect(result.dimensions.reduce((sum, d) => sum + d.weight, 0)).toBeCloseTo(1, 3);
      expect(result.compositeScore).toBeCloseTo(Math.max(0, weightedRaw - deduction), 0);
      const shown = result.dimensions.reduce((sum, d) => sum + d.weight * d.score, 0);
      expect(shown).toBeCloseTo(result.compositeScore, 0);
      expect(result.penalties.reduce((sum, p) => sum + p.points, 0)).toBe(
        result.totalPenaltyPoints,
      );
    });

    it(`${name}: the range contains the score, and the band is the band of the score`, () => {
      expect(result.compositeLow).toBeLessThanOrEqual(result.compositeScore);
      expect(result.compositeHigh).toBeGreaterThanOrEqual(result.compositeScore);
      const bands = ['poor', 'needs_attention', 'adequate', 'strong'] as const;
      expect(result.band).toBe(bands[bandIndex(result.compositeScore)]);
    });

    it(`${name}: the whole range lies inside the band the finished case is given`, () => {
      expect(bandIndex(result.compositeLow)).toBe(bandIndex(result.compositeHigh));
    });
  }
});

describe('score audit: what happens when data is missing', () => {
  it('with nothing assessable the score is a neutral placeholder over the full range, and says so', () => {
    for (const [name] of SAMPLES) {
      const first = asOfEvery(prepared[name])[0] as QualityAssessment;
      expect(first.dimensions.every((d) => d.weight === 0)).toBe(true);
      expect([first.compositeScore, first.compositeLow, first.compositeHigh]).toEqual([50, 0, 100]);
      expect(first.uncertaintyNote).toMatch(/not a result/);
    }
  });

  it('at every point of the record the figures are finite, the weights add up, and the range holds the score', () => {
    for (const [name] of SAMPLES) {
      for (const view of asOfEvery(prepared[name])) {
        for (const value of [view.compositeScore, view.compositeLow, view.compositeHigh]) {
          expect(Number.isFinite(value)).toBe(true);
        }
        expect(view.compositeLow).toBeLessThanOrEqual(view.compositeScore);
        expect(view.compositeHigh).toBeGreaterThanOrEqual(view.compositeScore);
        const total = view.dimensions.reduce((sum, d) => sum + d.weight, 0);
        expect(total === 0 || Math.abs(total - 1) < 0.001).toBe(true);
      }
    }
  });

  it('the range narrows as the record fills in: the finished range is narrower than it was after two events', () => {
    for (const [name] of SAMPLES) {
      const views = asOfEvery(prepared[name]);
      const width = (v: QualityAssessment) => v.compositeHigh - v.compositeLow;
      expect(width(views[views.length - 1] as QualityAssessment)).toBeLessThan(
        width(views[1] as QualityAssessment),
      );
    }
  });

  it('a score early in a case can name a band its own range does not stay in: such a band is provisional', () => {
    // Known behaviour, kept visible: with two assessable dimensions Case One reads 100 and "strong" with a range from 48.
    const early = asOfEvery(prepared['Case One'])[1] as QualityAssessment;
    expect(early.band).toBe('strong');
    expect(early.compositeLow).toBeLessThan(DEFAULT_QUALITY_CONFIG.bands.needsAttention);
    expect(bandIndex(early.compositeLow)).not.toBe(bandIndex(early.compositeHigh));
  });
});

describe('score audit: stability', () => {
  it('the order the events are listed in does not matter: the record is put in time order first', () => {
    for (const [name, file] of SAMPLES) {
      const bundle = loadBundle(file);
      const shuffled = CaseBundleSchema.parse({ ...bundle, events: [...bundle.events].reverse() });
      const again = review(prepareBundle(shuffled, 'case_test'));
      const original = review(prepared[name]);
      expect(again.compositeScore, name).toBe(original.compositeScore);
      expect(
        again.dimensions.map((d) => d.rawScore),
        name,
      ).toEqual(original.dimensions.map((d) => d.rawScore));
    }
  });

  it('the same record gives the same review, field for field', () => {
    for (const [name] of SAMPLES) {
      expect(JSON.stringify(review(prepared[name]))).toBe(JSON.stringify(review(prepared[name])));
    }
  });
});

describe('score audit: how much the answer depends on the choices that were authored', () => {
  const perturbed = (key: (typeof QUALITY_DIMENSIONS)[number], factor: number): QualityConfig => ({
    ...DEFAULT_QUALITY_CONFIG,
    weights: {
      ...DEFAULT_QUALITY_CONFIG.weights,
      [key]: (DEFAULT_QUALITY_CONFIG.weights[key] ?? 0) * factor,
    },
  });

  it('a quarter more or less weight on any one dimension moves neither sample by more than two points, or out of its band', () => {
    for (const [name] of SAMPLES) {
      const base = review(prepared[name]);
      for (const key of QUALITY_DIMENSIONS) {
        for (const factor of [0.75, 1.25]) {
          const moved = review(prepared[name], perturbed(key, factor));
          expect(
            Math.abs(moved.compositeScore - base.compositeScore),
            `${name} ${key} x${factor}`,
          ).toBeLessThanOrEqual(2);
          expect(moved.band, `${name} ${key} x${factor}`).toBe(base.band);
        }
      }
    }
  });

  it('moving every band edge by up to ten points changes neither sample’s band', () => {
    for (const [name] of SAMPLES) {
      const base = review(prepared[name]);
      for (const shift of [-10, -5, 5, 10]) {
        const bands = {
          strong: DEFAULT_QUALITY_CONFIG.bands.strong + shift,
          adequate: DEFAULT_QUALITY_CONFIG.bands.adequate + shift,
          needsAttention: DEFAULT_QUALITY_CONFIG.bands.needsAttention + shift,
        };
        expect(
          review(prepared[name], { ...DEFAULT_QUALITY_CONFIG, bands }).band,
          `${name} ${shift}`,
        ).toBe(base.band);
      }
    }
  });

  it('Case One’s band rests on its penalties: without them it would read "needs attention", with them "poor"', () => {
    const base = review(prepared['Case One']);
    const without = review(prepared['Case One'], { ...DEFAULT_QUALITY_CONFIG, penaltyCap: 0 });
    expect(base.band).toBe('poor');
    expect(without.band).toBe('needs_attention');
    expect(base.compositeScore).toBeLessThan(DEFAULT_QUALITY_CONFIG.bands.needsAttention);
    expect(without.compositeScore).toBeGreaterThanOrEqual(
      DEFAULT_QUALITY_CONFIG.bands.needsAttention,
    );
  });

  it('the range does not include doubt about the penalties: it is the same with and without them', () => {
    const base = review(prepared['Case One']);
    const without = review(prepared['Case One'], { ...DEFAULT_QUALITY_CONFIG, penaltyCap: 0 });
    expect(base.compositeHigh - base.compositeLow).toBeCloseTo(
      without.compositeHigh - without.compositeLow,
      1,
    );
  });

  it('a failure can be charged twice: the sub-check and the penalty for unsupported claims read the same flagged claims', () => {
    const base = review(prepared['Case One']);
    const check = base.dimensions.flatMap((d) => d.subChecks).find((c) => c.id === 'EI-1');
    expect(check?.determinable).toBe(true);
    expect(check?.score).toBeLessThan(1);
    expect(base.penalties.map((p) => p.key)).toContain('unsupported_root_cause');
  });
});
