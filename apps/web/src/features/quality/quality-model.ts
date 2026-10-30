import type { QualityAssessment, QualityBand } from '@caseguard/schemas';
import type { BadgeStatus, ScoreStatus } from '@caseguard/ui';

export const BAND_META: Record<
  QualityBand,
  { label: string; badge: BadgeStatus; ring: ScoreStatus }
> = {
  strong: { label: 'Strong', badge: 'productive', ring: 'good' },
  adequate: { label: 'Adequate', badge: 'neutral', ring: 'watch' },
  needs_attention: { label: 'Needs attention', badge: 'uncertain', ring: 'watch' },
  poor: { label: 'Poor', badge: 'unsupported', ring: 'poor' },
};

/**
 * True when nothing could be assessed from what was known (every dimension has weight 0). The API then reports a neutral
 * 50 with the full 0 to 100 range: a placeholder, not a result, so the page never shows it as a score.
 */
export function isPlaceholderScore(assessment: Pick<QualityAssessment, 'dimensions'>): boolean {
  return assessment.dimensions.every((dimension) => dimension.weight === 0);
}

/** A dimension that was left out of the composite because it could not be assessed yet (weight 0). */
export function isLeftOut(dimension: { weight: number }): boolean {
  return dimension.weight === 0;
}

/** Percentage of the composite a dimension carries, for display. */
export function weightText(weight: number): string {
  return `${Math.round(weight * 1000) / 10}%`;
}
