import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUALITY_CONFIG,
  PENALTY_KEYS,
  QUALITY_DIMENSIONS,
  type PenaltyKey,
  type QualityBand,
  type QualityConfig,
  type QualityDimensionKey,
} from '@caseguard/schemas';
import {
  composeQualityScore,
  qualityBandFor,
  type DimensionDraft,
  type ScoredPenalty,
} from '../src';

const rowArb = fc.record({
  raw: fc.double({ min: 0, max: 100, noNaN: true }),
  below: fc.double({ min: 0, max: 40, noNaN: true }),
  above: fc.double({ min: 0, max: 40, noNaN: true }),
  assessable: fc.boolean(),
});

const draftsArb = fc
  .array(rowArb, { minLength: QUALITY_DIMENSIONS.length, maxLength: QUALITY_DIMENSIONS.length })
  .map((rows): DimensionDraft[] =>
    QUALITY_DIMENSIONS.map((key, i) => {
      const row = rows[i] ?? { raw: 50, below: 0, above: 0, assessable: true };
      return {
        key,
        label: key,
        assessable: row.assessable,
        subChecks: [],
        rawScore: row.raw,
        low: Math.max(0, row.raw - row.below),
        high: Math.min(100, row.raw + row.above),
        rationale: 'generated',
      };
    }),
  );

const penaltyArb: fc.Arbitrary<ScoredPenalty> = fc.record({
  key: fc.constantFrom<PenaltyKey>(...PENALTY_KEYS),
  dimension: fc.constantFrom<QualityDimensionKey>(...QUALITY_DIMENSIONS),
  points: fc.double({ min: 0, max: 30, noNaN: true }),
});

const weightsOf = (values: readonly number[]): QualityConfig['weights'] =>
  QUALITY_DIMENSIONS.reduce<QualityConfig['weights']>(
    (acc, key, i) => ({ ...acc, [key]: values[i] ?? 0 }),
    DEFAULT_QUALITY_CONFIG.weights,
  );

const configArb: fc.Arbitrary<QualityConfig> = fc
  .record({
    weights: fc.array(fc.double({ min: 0, max: 1, noNaN: true }), {
      minLength: QUALITY_DIMENSIONS.length,
      maxLength: QUALITY_DIMENSIONS.length,
    }),
    penaltyCap: fc.double({ min: 0, max: 100, noNaN: true }),
  })
  .map(({ weights, penaltyCap }) => ({
    ...DEFAULT_QUALITY_CONFIG,
    weights: weightsOf(weights),
    penaltyCap,
  }));

const compose = (
  dimensions: DimensionDraft[],
  penalties: ScoredPenalty[],
  config: QualityConfig = DEFAULT_QUALITY_CONFIG,
) => composeQualityScore({ dimensions, penalties, config });

const BAND_ORDER: QualityBand[] = ['poor', 'needs_attention', 'adequate', 'strong'];

describe('quality score composition (FR-QI-01)', () => {
  it('[FR-QI-01] scores stay within 0-100 and the range brackets the score', () => {
    fc.assert(
      fc.property(draftsArb, fc.array(penaltyArb, { maxLength: 12 }), configArb, (d, p, config) => {
        const result = compose(d, p, config);
        for (const v of [result.composite, result.low, result.high]) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(100);
        }
        expect(result.low).toBeLessThanOrEqual(result.composite);
        expect(result.high).toBeGreaterThanOrEqual(result.composite);
        for (const dim of result.dimensions) {
          expect(dim.score).toBeGreaterThanOrEqual(0);
          expect(dim.score).toBeLessThanOrEqual(100);
          expect(dim.low).toBeLessThanOrEqual(dim.high);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('[FR-QI-01] the deduction never exceeds the penalty cap, however many penalties apply', () => {
    fc.assert(
      fc.property(draftsArb, fc.array(penaltyArb, { maxLength: 12 }), configArb, (d, p, config) => {
        const result = compose(d, p, config);
        const total = p.reduce((s, x) => s + Math.max(0, x.points), 0);
        expect(result.deduction).toBeLessThanOrEqual(config.penaltyCap + 0.05);
        expect(result.deduction).toBeLessThanOrEqual(total + 0.05);
        expect(result.capApplied).toBe(total > config.penaltyCap);
      }),
      { numRuns: 300 },
    );
  });

  it('[FR-QI-01] adding a penalty never raises the score (monotonicity)', () => {
    fc.assert(
      fc.property(
        draftsArb,
        fc.array(penaltyArb, { maxLength: 8 }),
        penaltyArb,
        configArb,
        (d, p, extra, config) => {
          const before = compose(d, p, config);
          const after = compose(d, [...p, extra], config);
          expect(after.composite).toBeLessThanOrEqual(before.composite);
          expect(after.low).toBeLessThanOrEqual(before.low);
          expect(after.high).toBeLessThanOrEqual(before.high);
          // Once the cap binds the capped deduction is shared pro rata, so a single dimension's
          // displayed penalty may shrink as others grow; the headline score still cannot rise.
          if (!after.capApplied) {
            before.dimensions.forEach((dim, i) => {
              expect(after.dimensions[i]?.score ?? 0).toBeLessThanOrEqual(dim.score + 1e-9);
            });
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('[FR-QI-01] when the cap binds the capped deduction is shared pro rata and the composite is unchanged', () => {
    const drafts: DimensionDraft[] = QUALITY_DIMENSIONS.map((key) => ({
      key,
      label: key,
      assessable: true,
      subChecks: [],
      rawScore: 100,
      low: 100,
      high: 100,
      rationale: 'fixed',
    }));
    const config: QualityConfig = { ...DEFAULT_QUALITY_CONFIG, penaltyCap: 10 };
    const evidence: ScoredPenalty = {
      key: 'unsupported_root_cause',
      dimension: 'evidence_integrity',
      points: 10,
    };
    const scoping: ScoredPenalty = {
      key: 'premature_escalation',
      dimension: 'scoping_completeness',
      points: 10,
    };
    const alone = compose(drafts, [evidence], config);
    const both = compose(drafts, [evidence, scoping], config);
    expect(alone.composite).toBe(90);
    expect(both.composite).toBe(90);
    expect(both.capApplied).toBe(true);
    const penaltyOf = (r: typeof alone, key: QualityDimensionKey) =>
      r.dimensions.find((d) => d.key === key)?.penaltyPoints ?? Number.NaN;
    expect(penaltyOf(both, 'evidence_integrity')).toBeLessThan(
      penaltyOf(alone, 'evidence_integrity'),
    );
    expect(penaltyOf(both, 'scoping_completeness')).toBeGreaterThan(0);
  });

  it('[FR-QI-01] raising a dimension score never lowers the composite', () => {
    fc.assert(
      fc.property(
        draftsArb,
        fc.array(penaltyArb, { maxLength: 8 }),
        fc.nat({ max: QUALITY_DIMENSIONS.length - 1 }),
        fc.double({ min: 0, max: 20, noNaN: true }),
        (d, p, which, bump) => {
          const improved = d.map((draft, i) =>
            i === which
              ? {
                  ...draft,
                  rawScore: Math.min(100, draft.rawScore + bump),
                  high: Math.min(100, Math.max(draft.high, draft.rawScore + bump)),
                }
              : draft,
          );
          expect(compose(improved, p).composite).toBeGreaterThanOrEqual(compose(d, p).composite);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('[FR-QI-01] weights are re-normalised over assessable dimensions and sum to one', () => {
    fc.assert(
      fc.property(draftsArb, configArb, (d, config) => {
        const result = compose(d, [], config);
        const assessable = d.filter((x) => x.assessable);
        const total = Object.values(result.weights).reduce((s, w) => s + w, 0);
        if (assessable.length === 0) {
          expect(total).toBe(0);
          expect(result.composite).toBe(50);
          expect(result.low).toBe(0);
          expect(result.high).toBe(100);
        } else {
          expect(total).toBeCloseTo(1, 9);
        }
        for (const draft of d) {
          if (!draft.assessable) expect(result.weights[draft.key]).toBe(0);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('[FR-QI-01] the composite does not depend on dimensions that are not assessable', () => {
    fc.assert(
      fc.property(draftsArb, fc.array(penaltyArb, { maxLength: 6 }), (d, p) => {
        const scrambled = d.map((x) =>
          x.assessable ? x : { ...x, rawScore: 100 - x.rawScore, low: 0, high: 100 },
        );
        expect(compose(scrambled, p).composite).toBe(compose(d, p).composite);
      }),
      { numRuns: 100 },
    );
  });

  it('[FR-QI-01] penalties of zero points change nothing', () => {
    fc.assert(
      fc.property(draftsArb, fc.array(penaltyArb, { maxLength: 6 }), penaltyArb, (d, p, extra) => {
        expect(compose(d, [...p, { ...extra, points: 0 }])).toEqual(compose(d, p));
      }),
      { numRuns: 100 },
    );
  });

  it('[FR-QI-01] bands never improve as the score falls', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 100, noNaN: true }),
        fc.double({ min: 0, max: 100, noNaN: true }),
        (a, b) => {
          const [low, high] = a <= b ? [a, b] : [b, a];
          const rank = (s: number) =>
            BAND_ORDER.indexOf(qualityBandFor(s, DEFAULT_QUALITY_CONFIG.bands));
          expect(rank(low)).toBeLessThanOrEqual(rank(high));
        },
      ),
      { numRuns: 200 },
    );
  });

  it('[FR-QI-01] band boundaries follow the configured thresholds', () => {
    const { bands } = DEFAULT_QUALITY_CONFIG;
    expect(qualityBandFor(bands.strong, bands)).toBe('strong');
    expect(qualityBandFor(bands.strong - 0.1, bands)).toBe('adequate');
    expect(qualityBandFor(bands.adequate, bands)).toBe('adequate');
    expect(qualityBandFor(bands.adequate - 0.1, bands)).toBe('needs_attention');
    expect(qualityBandFor(bands.needsAttention, bands)).toBe('needs_attention');
    expect(qualityBandFor(bands.needsAttention - 0.1, bands)).toBe('poor');
  });

  it('[FR-QI-01] a configuration that gives no assessable dimension any weight falls back to equal weights', () => {
    const zero: QualityConfig = {
      ...DEFAULT_QUALITY_CONFIG,
      weights: weightsOf(QUALITY_DIMENSIONS.map(() => 0)),
    };
    const drafts: DimensionDraft[] = QUALITY_DIMENSIONS.map((key, i) => ({
      key,
      label: key,
      assessable: i < 2,
      subChecks: [],
      rawScore: i === 0 ? 100 : 60,
      low: 50,
      high: 100,
      rationale: 'fixed',
    }));
    const result = compose(drafts, [], zero);
    expect(result.weights[QUALITY_DIMENSIONS[0] ?? 'evidence_integrity']).toBeCloseTo(0.5, 9);
    expect(result.composite).toBe(80);
  });
});
