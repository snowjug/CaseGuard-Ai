import {
  QUALITY_DIMENSION_LABELS,
  type EvidenceLink,
  type QualityDimension,
  type QualityDimensionKey,
  type SubCheck,
} from '@caseguard/schemas';
import { clamp, round } from '../util/math';
import { truncate, uniqueLinks } from './links';
import type { DimensionDraft } from './types';

/** Neutral placeholder score carried by a check that could not be decided from the view. */
const NEUTRAL = 0.5;

/** Whether a dimension of a finished review had anything to judge, i.e. at least one check was decidable. */
export const isAssessed = (dimension: Pick<QualityDimension, 'subChecks'>): boolean =>
  dimension.subChecks.some((c) => c.determinable && c.weight > 0);

export function makeCheck(input: {
  id: string;
  label: string;
  weight: number;
  /** 0-1; ignored (neutral) when the check is not determinable. */
  score: number;
  note: string;
  /**
   * What the note rests on, so that it can be checked: the offenders when there are any, otherwise the
   * instances that earn the pass. A check that passes only because nothing went wrong has nothing to cite.
   */
  evidence?: readonly EvidenceLink[];
  determinable?: boolean;
}): SubCheck {
  const determinable = input.determinable ?? true;
  return {
    id: input.id,
    label: input.label,
    score: determinable ? round(clamp(input.score, 0, 1), 3) : NEUTRAL,
    weight: input.weight,
    note: truncate(input.note, 600),
    evidence: uniqueLinks(input.evidence ?? [], 8),
    determinable,
  };
}

/** A check the view cannot decide yet; it widens the range instead of guessing. */
export const undecided = (id: string, label: string, weight: number, note: string): SubCheck =>
  makeCheck({ id, label, weight, score: NEUTRAL, note, determinable: false });

/** A check that does not apply to this case (for example, no escalation happened): no weight, no doubt. */
export const notApplicable = (id: string, label: string, note: string): SubCheck =>
  makeCheck({ id, label, weight: 0, score: NEUTRAL, note, determinable: false });

/** Linear score: 1 at `good`, 0 at `bad` (works for either direction), clamped to [0, 1]. */
export function scoreBetween(value: number, good: number, bad: number): number {
  if (bad === good) return value <= good ? 1 : 0;
  return clamp((bad - value) / (bad - good), 0, 1);
}

const percent = (p: number): string => `${Math.round(p * 100)}%`;

/**
 * Combines weighted sub-checks into a dimension score. Undecidable checks are excluded from the
 * score and widen the low-high range (low assumes they fail, high assumes they pass); a dimension
 * with no decidable check is "not assessable" and carries a neutral 50 with the full 0-100 range.
 */
export function makeDimension(
  key: QualityDimensionKey,
  checks: readonly SubCheck[],
  margin: number,
  context: string,
): DimensionDraft {
  const decided = checks.filter((c) => c.determinable);
  const totalWeight = checks.reduce((s, c) => s + c.weight, 0);
  const decidedWeight = decided.reduce((s, c) => s + c.weight, 0);
  const earned = decided.reduce((s, c) => s + c.weight * c.score, 0);
  const label = QUALITY_DIMENSION_LABELS[key];
  if (decidedWeight <= 0) {
    return {
      key,
      label,
      assessable: false,
      subChecks: [...checks],
      rawScore: 50,
      low: 0,
      high: 100,
      rationale: truncate(
        `Not assessable from the information available in this view. ${context}`.trim(),
        800,
      ),
    };
  }
  const raw = (100 * earned) / decidedWeight;
  const lowBase = (100 * earned) / totalWeight;
  const highBase = lowBase + (100 * (totalWeight - decidedWeight)) / totalWeight;
  const undecidedCount = checks.filter((c) => !c.determinable && c.weight > 0).length;
  const ranked = [...decided].sort((a, b) => a.score - b.score || (a.id < b.id ? -1 : 1));
  const weakest = ranked[0];
  const strongest = ranked[ranked.length - 1];
  const parts = [
    weakest && weakest.score < 0.8
      ? `Weakest check: ${weakest.label} (${percent(weakest.score)}).`
      : null,
    strongest && strongest !== weakest && strongest.score >= 0.8
      ? `Strongest check: ${strongest.label} (${percent(strongest.score)}).`
      : null,
    undecidedCount > 0
      ? `${undecidedCount} of ${checks.length} checks could not be decided yet, which widens the range.`
      : null,
    context || null,
  ].filter((p): p is string => p !== null);
  return {
    key,
    label,
    assessable: true,
    subChecks: [...checks],
    rawScore: round(clamp(raw, 0, 100), 1),
    low: round(clamp(lowBase - margin, 0, 100), 1),
    high: round(clamp(highBase + margin, 0, 100), 1),
    rationale: truncate(parts.join(' '), 800),
  };
}
