import { HYPOTHESIS_NOTICE } from '@caseguard/domain';
import type { DiagnosticAction, Hypothesis, HypothesesResponse } from '@caseguard/schemas';
import type { QueryOf } from '../../http/route-binder';
import type { RequestContext } from '../../http/request-context';
import { computationFor, type ViewDeps } from './computation';
import { compareText } from './instants';
import { decisionTimeAction } from './overlay';
import { loadCaseRun, loadViewState } from './state';

/** Most confident first (a model estimate at the view's own instant); the key breaks ties stably. */
export function rankHypotheses(items: readonly Hypothesis[]): Hypothesis[] {
  return [...items].sort(
    (a, b) => b.currentConfidence - a.currentConfidence || compareText(a.key, b.key),
  );
}

/**
 * Every name a hypothesis goes by. The API names a hypothesis by its record id, but claims relate to
 * the knowledge-pack key, so a filter by either form has to match the same hypothesis.
 */
export function hypothesisAliases(
  hypotheses: readonly Pick<Hypothesis, 'id' | 'key'>[],
  id: string,
): ReadonlySet<string> {
  const known = hypotheses.find((item) => item.id === id || item.key === id);
  return new Set(known === undefined ? [id] : [known.id, known.key]);
}

/**
 * Competing hypotheses with their time-indexed confidence. Without `asOf` they are the stored
 * artefacts; with it the engine analyses only what was known then, so the ranking, every point of
 * the confidence series, the evidence links and the missing-evidence list stop at that instant.
 */
export async function listHypotheses(
  ctx: RequestContext,
  deps: ViewDeps,
  caseId: string,
  query: QueryOf<'hypotheses.list'>,
): Promise<HypothesesResponse> {
  if (query.asOf === undefined) {
    await loadCaseRun(ctx, caseId);
    const [items, links, evidence, missing] = await Promise.all([
      ctx.repos.analysis.listHypotheses(caseId),
      ctx.repos.analysis.listLinks(caseId),
      ctx.repos.analysis.listEvidence(caseId),
      ctx.repos.analysis.listMissing(caseId),
    ]);
    return {
      caseId,
      asOf: null,
      items: rankHypotheses(items),
      links,
      evidence,
      missing,
      notice: HYPOTHESIS_NOTICE,
    };
  }

  const state = await loadViewState(ctx, caseId);
  const analysis = await computationFor(deps, state, query.asOf).analysis();
  return {
    caseId,
    asOf: query.asOf,
    items: rankHypotheses(analysis.hypotheses),
    links: analysis.links,
    evidence: analysis.evidence,
    missing: analysis.missing,
    notice: HYPOTHESIS_NOTICE,
  };
}

/**
 * The diagnostic actions taken in the case. Inside an `asOf` window each action carries only what
 * was knowable then: the information realised so far (never answers that arrived later) and no
 * retrospective "produced little information" judgement.
 */
export async function listActions(
  ctx: RequestContext,
  deps: ViewDeps,
  caseId: string,
  query: QueryOf<'actions.list'>,
): Promise<{ items: DiagnosticAction[] }> {
  if (query.asOf === undefined) {
    await loadCaseRun(ctx, caseId);
    return { items: await ctx.repos.analysis.listActions(caseId) };
  }
  const state = await loadViewState(ctx, caseId);
  const analysis = await computationFor(deps, state, query.asOf).analysis();
  return { items: analysis.actions.map(decisionTimeAction) };
}
