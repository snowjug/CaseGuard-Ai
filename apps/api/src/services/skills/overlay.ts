import { buildSkillOverlay, chooseDecisionPoint, firstRecommendedStep } from '@caseguard/domain';
import {
  COUNTERFACTUAL_STRATEGIES,
  type DecisionFork,
  type PathMetrics,
  type SkillOverlay,
} from '@caseguard/schemas';
import { NotFoundError } from '../../errors';
import type { RequestContext } from '../../http/request-context';
import type { MatchOptions } from '../ports';
import { listForks, type ViewDeps } from '../views';

/*
 * `skillOverlay.get`: what a matched skill would have changed for one case, set beside what the case
 * recorded. It is assembled from stored data only and it writes nothing: the match is the one the list route
 * returns (same matcher, same cache, same as-of rules), the version of the skill is read as it was matched,
 * the decision points are the engine's (stored for the whole record, recomputed from only what was known for
 * an `asOf`), and the figures for the path the case took are the ones the engine stored with its simulations.
 * All of the arithmetic and the wording are in the domain (`buildSkillOverlay`); a client shows them as
 * they are. No audit event is recorded: a read of a comparison changes nothing, and adopting a plan is the
 * explicit, governed `skillMatches.apply`.
 *
 * COST. Reading the match is the same pass as `skillMatches.list` and is metered the same way. The decision
 * points of an `asOf` come from the views' shared pass, so an instant somebody already looked at costs
 * nothing more; a cold one is metered once more through the same bucket (429 when it is empty).
 */

/**
 * The figures the engine stored for the path the case took from a decision point: the recorded path does
 * not depend on the strategy of a simulation, so the first completed one (in the order the strategies are
 * listed) stands for them all. Null when no simulation of that decision point was stored.
 */
async function recordedMetricsOf(
  ctx: RequestContext,
  caseId: string,
  forkId: string,
): Promise<PathMetrics | null> {
  const completed = (await ctx.repos.counterfactuals.list(caseId, { forkId })).filter(
    (scenario) => scenario.status === 'completed',
  );
  const rank = (strategy: string): number =>
    COUNTERFACTUAL_STRATEGIES.findIndex((candidate) => candidate === strategy);
  completed.sort((a, b) => rank(a.strategy) - rank(b.strategy) || (a.id < b.id ? -1 : 1));
  return completed[0]?.actualMetrics ?? null;
}

/** The decision points of the case as of `asOf` (the whole record without it): decision-time fields only are used. */
async function decisionPointsOf(
  ctx: RequestContext,
  deps: ViewDeps,
  caseId: string,
  asOf: string | undefined,
): Promise<readonly DecisionFork[]> {
  const query = asOf === undefined ? {} : { asOf };
  return (await listForks(ctx, deps, caseId, query)).items;
}

export async function resolveSkillOverlay(
  ctx: RequestContext,
  deps: ViewDeps,
  caseId: string,
  matchId: string,
  options: MatchOptions = {},
): Promise<SkillOverlay> {
  const matches = await ctx.services.skills.matchForCase(ctx, caseId, options);
  const match = matches.find((candidate) => candidate.id === matchId);
  if (match === undefined) throw new NotFoundError('Skill match', matchId);
  const version = await ctx.repos.skills.getVersion(match.skillId, match.versionId);
  if (version === null) throw new NotFoundError('Skill version', match.versionId);

  const forks =
    firstRecommendedStep(match) === null
      ? []
      : await decisionPointsOf(ctx, deps, caseId, options.asOf);
  const decisionPoint = chooseDecisionPoint({ forks, match, content: version.content });

  // The path from a decision point runs through events that may lie after the instant of the match: its
  // figures are only for a record that is whole (the builder withholds them otherwise, whatever it is given).
  const wholeRecord =
    options.asOf === undefined ||
    (await ctx.repos.cases.countEventsAfter(caseId, match.asOf)) === 0;
  const metrics =
    decisionPoint === null || !wholeRecord
      ? null
      : await recordedMetricsOf(ctx, caseId, decisionPoint.id);

  return buildSkillOverlay({
    caseId,
    match,
    content: version.content,
    decisionPoint,
    decisionPointCount: forks.length,
    recorded: { wholeRecord, metrics },
  });
}
