import {
  QUALITY_DIMENSIONS,
  type PenaltyKey,
  type QualityBand,
  type QualityConfig,
  type QualityDimensionKey,
} from '@caseguard/schemas';
import { clamp, round } from '../util/math';
import type { DimensionDraft } from './types';

export interface ScoredPenalty {
  key: PenaltyKey;
  dimension: QualityDimensionKey;
  /** Configured points for the penalty (composite scale). */
  points: number;
}

export interface ComposedDimension {
  key: QualityDimensionKey;
  /** Effective weight: configured weights re-normalised over the assessable dimensions. */
  weight: number;
  rawScore: number;
  /** Dimension-scale points taken by penalties (composite points / weight). */
  penaltyPoints: number;
  score: number;
  low: number;
  high: number;
}

export interface ComposedScore {
  composite: number;
  low: number;
  high: number;
  band: QualityBand;
  weights: Record<QualityDimensionKey, number>;
  weightedRaw: number;
  /** Sum of configured penalty points before the cap. */
  totalPenaltyPoints: number;
  /** min(cap, total): what is actually deducted from the composite. */
  deduction: number;
  capApplied: boolean;
  /** Share of each penalty's points actually deducted (deduction / total). */
  capScale: number;
  dimensions: ComposedDimension[];
}

export function qualityBandFor(score: number, bands: QualityConfig['bands']): QualityBand {
  if (score >= bands.strong) return 'strong';
  if (score >= bands.adequate) return 'adequate';
  if (score >= bands.needsAttention) return 'needs_attention';
  return 'poor';
}

/**
 * CQI = sum(weight x dimension score) - min(penalty cap, sum of applied penalties), clamped to 0-100.
 *
 * Penalties are deducted once, at composite scale, so the cap keeps a single failure from zeroing a
 * case. For display, each dimension also shows the same deduction on its own 0-100 scale
 * (points / weight), which makes sum(weight x displayed score) equal the composite unless a
 * dimension reaches its floor of 0. Pure and deterministic: no clock, no randomness.
 */
export function composeQualityScore(input: {
  dimensions: readonly DimensionDraft[];
  penalties: readonly ScoredPenalty[];
  config: QualityConfig;
}): ComposedScore {
  const { dimensions, penalties, config } = input;
  const nominal = (key: QualityDimensionKey, assessable: boolean): number =>
    assessable ? Math.max(0, config.weights[key] ?? 0) : 0;
  const draftByKey = new Map(dimensions.map((d) => [d.key, d]));
  const nominalWeights = QUALITY_DIMENSIONS.map((key) =>
    nominal(key, draftByKey.get(key)?.assessable ?? false),
  );
  let weightTotal = nominalWeights.reduce((s, w) => s + w, 0);
  const assessableCount = QUALITY_DIMENSIONS.filter((k) => draftByKey.get(k)?.assessable).length;
  // A configuration that gives every assessable dimension zero weight falls back to equal weights.
  const equalFallback = weightTotal <= 0 && assessableCount > 0;
  if (equalFallback) weightTotal = assessableCount;
  const weights = Object.fromEntries(
    QUALITY_DIMENSIONS.map((key, i) => {
      const w = equalFallback
        ? draftByKey.get(key)?.assessable
          ? 1
          : 0
        : (nominalWeights[i] ?? 0);
      return [key, weightTotal > 0 ? w / weightTotal : 0];
    }),
  ) as Record<QualityDimensionKey, number>;

  const applied = penalties.filter((p) => p.points > 0);
  const totalPenaltyPoints = applied.reduce((s, p) => s + p.points, 0);
  const deduction = Math.min(config.penaltyCap, totalPenaltyPoints);
  const capScale = totalPenaltyPoints > 0 ? deduction / totalPenaltyPoints : 0;

  let weightedRaw = 0;
  let weightedLow = 0;
  let weightedHigh = 0;
  const composed: ComposedDimension[] = QUALITY_DIMENSIONS.map((key) => {
    const draft = draftByKey.get(key);
    const weight = weights[key];
    const raw = draft?.rawScore ?? 50;
    const low = draft?.low ?? 0;
    const high = draft?.high ?? 100;
    weightedRaw += weight * raw;
    weightedLow += weight * low;
    weightedHigh += weight * high;
    const absorbed = applied
      .filter((p) => p.dimension === key)
      .reduce((s, p) => s + p.points * capScale, 0);
    const penaltyPoints = weight > 0 ? absorbed / weight : 0;
    return {
      key,
      weight,
      rawScore: raw,
      penaltyPoints,
      score: clamp(raw - penaltyPoints, 0, 100),
      low: clamp(low - penaltyPoints, 0, 100),
      high: clamp(high - penaltyPoints, 0, 100),
    };
  });

  if (weightTotal <= 0) {
    // Nothing is assessable yet: report a neutral, maximally uncertain score instead of inventing one.
    return {
      composite: 50,
      low: 0,
      high: 100,
      band: qualityBandFor(50, config.bands),
      weights,
      weightedRaw: 50,
      totalPenaltyPoints,
      deduction,
      capApplied: totalPenaltyPoints > config.penaltyCap,
      capScale,
      dimensions: composed.map((d) => ({
        ...d,
        rawScore: round(d.rawScore, 1),
        score: round(d.score, 1),
      })),
    };
  }

  const composite = clamp(weightedRaw - deduction, 0, 100);
  return {
    composite: round(composite, 1),
    low: round(clamp(weightedLow - deduction, 0, 100), 1),
    high: round(clamp(weightedHigh - deduction, 0, 100), 1),
    band: qualityBandFor(round(composite, 1), config.bands),
    weights,
    weightedRaw: round(weightedRaw, 2),
    totalPenaltyPoints: round(totalPenaltyPoints, 1),
    deduction: round(deduction, 1),
    capApplied: totalPenaltyPoints > config.penaltyCap,
    capScale,
    dimensions: composed.map((d) => ({
      ...d,
      weight: round(d.weight, 4),
      rawScore: round(d.rawScore, 1),
      penaltyPoints: round(d.penaltyPoints, 1),
      score: round(d.score, 1),
      low: round(d.low, 1),
      high: round(d.high, 1),
    })),
  };
}
