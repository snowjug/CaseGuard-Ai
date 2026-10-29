import type { Case, CaseSummary } from '@caseguard/schemas';
import type { CaseAnalysisSummary, CaseListItem } from '../../db';
import type { RequestContext } from '../../http/request-context';

/** The list projection of a case (everything except the analysis-derived figures). */
export function caseToListItem(record: Case): CaseListItem {
  return {
    id: record.id,
    reference: record.reference,
    title: record.title,
    product: record.product,
    workload: record.workload,
    severity: record.severity,
    status: record.status,
    customerAlias: record.customerAlias,
    openedAt: record.openedAt,
    closedAt: record.closedAt,
    synthetic: record.synthetic,
    eventCount: record.eventCount,
    analysisState: record.analysisState,
    analyzedAt: record.analyzedAt,
    hasResolution: record.hasResolution,
    injectionDetected: record.injectionDetected,
  };
}

const NOT_ANALYZED: Omit<CaseAnalysisSummary, 'caseId'> = {
  qualityIndex: null,
  avoidableEffortPct: null,
  leadingHypothesis: null,
  openWarningCount: 0,
};

/**
 * Adds the figures of each case's latest analysis (composite quality, avoidable support effort, the
 * most confident hypothesis, open warnings; all estimates) to a page of list items. One repository
 * read covers the whole page; a case that has not been analysed has no figures.
 */
export async function summarizeCases(
  ctx: RequestContext,
  items: readonly CaseListItem[],
): Promise<CaseSummary[]> {
  if (items.length === 0) return [];
  const figures = await ctx.repos.analysis.summarize(items.map((item) => item.id));
  const byCase = new Map(figures.map((entry) => [entry.caseId, entry] as const));
  return items.map((item) => {
    const found = byCase.get(item.id) ?? NOT_ANALYZED;
    return {
      ...item,
      qualityIndex: found.qualityIndex,
      avoidableEffortPct: found.avoidableEffortPct,
      leadingHypothesis: found.leadingHypothesis,
      openWarningCount: found.openWarningCount,
    };
  });
}

/** The summary of one case record. */
export async function summarizeCase(ctx: RequestContext, record: Case): Promise<CaseSummary> {
  const [summary] = await summarizeCases(ctx, [caseToListItem(record)]);
  if (summary === undefined) throw new Error('summarizeCases returned nothing for one case');
  return summary;
}
