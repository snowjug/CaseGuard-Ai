import type { AnalyticsOverview } from '@caseguard/schemas';
import type { RequestContext } from '../../http/request-context';
import { ANALYTICS_CASE_LIMIT, aggregateAnalytics } from './overview';

export { ANALYTICS_CASE_LIMIT, aggregateAnalytics, type AnalyticsInputs } from './overview';

/**
 * `analytics.overview`: reads the tenant's bounded analytics source and reviewer statistics through
 * `ctx.repos` (so only this tenant's rows are visible) and aggregates them. Read-only.
 */
export async function getAnalyticsOverview(ctx: RequestContext): Promise<AnalyticsOverview> {
  const [source, review, counts] = await Promise.all([
    ctx.repos.analytics.collect(ANALYTICS_CASE_LIMIT),
    ctx.repos.reviews.stats(),
    ctx.repos.cases.counts(),
  ]);
  return aggregateAnalytics({
    source,
    review,
    totalCases: counts.total,
    now: ctx.now().toISOString(),
  });
}
