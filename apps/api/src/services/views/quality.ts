import type { CoachingReport, MetricEstimate, QualityAssessment } from '@caseguard/schemas';
import { NotFoundError } from '../../errors';
import type { QueryOf } from '../../http/route-binder';
import type { RequestContext } from '../../http/request-context';
import { computationFor, type ViewDeps } from './computation';
import { loadCaseRun, loadViewState } from './state';

/**
 * The Case Quality Index. Without `asOf` it is the stored assessment of the whole record. With it
 * the index is scored on the engine's analysis of only what was known then, labelled with that
 * instant; dimensions that cannot be assessed yet are left out and say so in the uncertainty note.
 */
export async function getQuality(
  ctx: RequestContext,
  deps: ViewDeps,
  caseId: string,
  query: QueryOf<'quality.get'>,
): Promise<QualityAssessment> {
  if (query.asOf === undefined) {
    await loadCaseRun(ctx, caseId);
    const assessment = await ctx.repos.analysis.getQuality(caseId);
    if (assessment === null) throw new NotFoundError('Quality assessment', caseId);
    return assessment;
  }
  const state = await loadViewState(ctx, caseId);
  return computationFor(deps, state, query.asOf).quality();
}

/**
 * Metric estimates (every one labelled an estimate). Without `asOf` they are the stored estimates,
 * including Avoidable Support Effort against the best valid counterfactual. With it they are
 * recomputed on what was known then; a counterfactual compares itself with the whole real path, so
 * none is used inside a window and Avoidable Support Effort says it cannot be estimated there.
 */
export async function getMetrics(
  ctx: RequestContext,
  deps: ViewDeps,
  caseId: string,
  query: QueryOf<'metrics.get'>,
): Promise<{ items: MetricEstimate[] }> {
  if (query.asOf === undefined) {
    await loadCaseRun(ctx, caseId);
    return { items: await ctx.repos.analysis.listMetrics(caseId) };
  }
  const state = await loadViewState(ctx, caseId);
  return { items: await computationFor(deps, state, query.asOf).metrics() };
}

/** The coaching report of the finished case (a retrospective review, so it has no time cursor). */
export async function getCoaching(ctx: RequestContext, caseId: string): Promise<CoachingReport> {
  await loadCaseRun(ctx, caseId);
  const report = await ctx.repos.analysis.getCoaching(caseId);
  if (report === null) throw new NotFoundError('Coaching report', caseId);
  return report;
}
