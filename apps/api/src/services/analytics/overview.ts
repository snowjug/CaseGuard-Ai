import { buildAnalyticsOverview } from '@caseguard/domain';
import type { AnalyticsOverview } from '@caseguard/schemas';
import type { AnalyticsSource, ReviewStats } from '../../db';

/** The newest cases the overview covers: the data tier's own ceiling for one read. */
export const ANALYTICS_CASE_LIMIT = 500;

export interface AnalyticsInputs {
  /** The bounded read model of the newest cases (see `AnalyticsRepository.collect`). */
  readonly source: AnalyticsSource;
  /** Reviewer decisions on claims, for the disagreement rate. */
  readonly review: Pick<ReviewStats, 'reviewedClaims' | 'correctedClaims'>;
  /** Every case the tenant holds, to say so when the overview covers only the newest ones. */
  readonly totalCases: number;
  readonly now: string;
}

/**
 * Privacy-safe portfolio analytics: the domain's aggregation (`buildAnalyticsOverview`, where the
 * definitions live) over the data tier's read model. Only counts, averages and pack labels come out:
 * no case text, no participant or user identifiers, nothing ranked per person. The text of flagged
 * statements is dropped here, before the domain sees it, so it cannot reach the response by accident.
 *
 * Small cohorts are never hidden (the minimum group size is 1) because the demo has two cases; the
 * cohort note and the privacy notes say so, and say when the newest cases only are covered.
 */
export function aggregateAnalytics(inputs: AnalyticsInputs): AnalyticsOverview {
  const { source, review, totalCases, now } = inputs;
  const overview = buildAnalyticsOverview(
    {
      cases: source.cases,
      quality: source.quality,
      forks: source.forks,
      missing: source.missing,
      metrics: source.metrics,
      assumptionFlags: source.assumptionFlags.map(({ caseId, subject }) => ({ caseId, subject })),
      scenarios: source.scenarios,
      skills: source.skills,
      matches: source.matches,
      reviewStats: {
        reviewedClaims: review.reviewedClaims,
        correctedClaims: review.correctedClaims,
      },
    },
    { now },
  );
  if (totalCases <= source.cases.length) return overview;
  return {
    ...overview,
    cohort: {
      ...overview.cohort,
      note: `${overview.cohort.note} Only the ${source.cases.length} most recent of ${totalCases} cases are included.`,
    },
  };
}
