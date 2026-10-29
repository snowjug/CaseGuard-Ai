import type { Hypothesis, HypothesisStatus, Level } from '@caseguard/schemas';

/** Qualitative band for a model-estimated posterior (never presented as a statistical truth). */
export function likelihoodLevel(posterior: number): Level {
  if (posterior >= 0.6) return 'high';
  if (posterior >= 0.25) return 'medium';
  return 'low';
}

/** Qualitative band for a rule-based classification confidence. */
export function confidenceLevel(confidence: number): Level {
  if (confidence >= 0.8) return 'high';
  if (confidence >= 0.55) return 'medium';
  return 'low';
}

export interface HypothesisStanding {
  status: HypothesisStatus;
  confidence: number;
}

/** Standing of a hypothesis using only belief points produced by events inside the view. */
export function hypothesisStandingAsOf(
  hypothesis: Hypothesis,
  eventIds: ReadonlySet<string>,
): HypothesisStanding {
  let latest: HypothesisStanding = { status: 'active', confidence: hypothesis.prior };
  for (const point of hypothesis.timeline) {
    if (eventIds.has(point.eventId))
      latest = { status: point.status, confidence: point.confidence };
  }
  return latest;
}
