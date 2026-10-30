import type { DecisionFork, ForkListResponse } from '@caseguard/schemas';
import { NotFoundError } from '../../errors';
import type { QueryOf } from '../../http/route-binder';
import type { RequestContext } from '../../http/request-context';
import { computationFor, type ViewDeps } from './computation';
import { overlayFork, withoutHindsight } from './overlay';
import { loadCaseRun, loadViewState } from './state';

/** The hindsight view of a fork (what the actual step eventually produced) is for reviewers, like the hindsight check. */
const entitledToHindsight = (ctx: RequestContext): boolean =>
  ctx.auth.permissions.includes('quality:review');

/** Forks as the caller may see them: decision-time fields for everyone, hindsight only when entitled. */
const forCaller =
  (ctx: RequestContext) =>
  (fork: DecisionFork): DecisionFork =>
    entitledToHindsight(ctx) ? fork : withoutHindsight(fork);

/**
 * Decision forks. Every field is decision-time except `retrospective`, which is hindsight: it is
 * labelled as such and only returned to callers entitled to it. Inside an `asOf` window the engine
 * analyses only what was known then, forks of later decisions do not exist yet, and there is never a
 * hindsight view, whoever asks.
 */
export async function listForks(
  ctx: RequestContext,
  deps: ViewDeps,
  caseId: string,
  query: QueryOf<'forks.list'>,
): Promise<ForkListResponse> {
  if (query.asOf === undefined) {
    await loadCaseRun(ctx, caseId);
    const forks = await ctx.repos.analysis.listForks(caseId);
    return {
      items: forks.map(forCaller(ctx)),
      earliestMeaningfulForkId: forks.find((fork) => fork.isEarliestMeaningful)?.id ?? null,
    };
  }

  const state = await loadViewState(ctx, caseId);
  const [analysis, stored] = await Promise.all([
    computationFor(ctx, deps, state, query.asOf).analysis(),
    ctx.repos.analysis.listForks(caseId),
  ]);
  const storedById = new Map(stored.map((fork) => [fork.id, fork]));
  return {
    items: analysis.forks.map((fork) =>
      withoutHindsight(overlayFork(fork, storedById.get(fork.id), query.asOf)),
    ),
    earliestMeaningfulForkId: analysis.earliestMeaningfulForkId,
  };
}

export async function getFork(
  ctx: RequestContext,
  deps: ViewDeps,
  caseId: string,
  forkId: string,
  query: QueryOf<'forks.get'>,
): Promise<DecisionFork> {
  if (query.asOf === undefined) {
    await loadCaseRun(ctx, caseId);
    const fork = await ctx.repos.analysis.getFork(caseId, forkId);
    if (fork === null) throw new NotFoundError('Decision fork', forkId);
    return forCaller(ctx)(fork);
  }

  const state = await loadViewState(ctx, caseId);
  const analysis = await computationFor(ctx, deps, state, query.asOf).analysis();
  const fork = analysis.forks.find((candidate) => candidate.id === forkId);
  if (fork === undefined) throw new NotFoundError('Decision fork', forkId);
  return withoutHindsight(
    overlayFork(fork, (await ctx.repos.analysis.getFork(caseId, forkId)) ?? undefined, query.asOf),
  );
}
