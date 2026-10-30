import { buildInvestigationGraph, type GraphInput } from '@caseguard/domain';
import type { InvestigationGraph } from '@caseguard/schemas';
import type { QueryOf } from '../../http/route-binder';
import type { RequestContext } from '../../http/request-context';
import { computationFor, type ViewDeps } from './computation';
import { loadScenario, scenarioForWindow } from './scenarios';
import { loadViewState } from './state';

type GraphSkills = NonNullable<GraphInput['skills']>;

/** A graph shows a handful of skills; the library page is bounded by the data tier. */
const SKILL_LIBRARY_PAGE = 200;
const GRAPH_SKILL_LIMIT = 6;

/** Skills distilled from this case, with the fork each one was extracted for. */
async function loadCaseSkills(ctx: RequestContext, caseId: string): Promise<GraphSkills> {
  const library = await ctx.repos.skills.list({ limit: SKILL_LIBRARY_PAGE });
  const mine = library.items
    .filter((skill) => skill.sourceCaseIds.includes(caseId))
    .slice(0, GRAPH_SKILL_LIMIT);
  return Promise.all(
    mine.map(async (skill) => {
      const version = await ctx.repos.skills.getVersion(skill.id, skill.currentVersionId);
      return {
        id: skill.id,
        name: skill.name,
        forkId: version?.content.provenance?.forkId ?? null,
        summary: skill.description,
      };
    }),
  );
}

/**
 * The investigation graph: problem, evidence, hypotheses, the actual path with its forks, an optional
 * simulated path and the outcome. With `asOf` the engine analyses only what was known then and the
 * builder receives only those events; the skill lane (an extraction happens after the case) is left
 * out. A `scenarioId` overlays one stored counterfactual scenario, simulated nodes labelled as such;
 * inside a window it appears only once its decision instant has been reached.
 */
export async function getGraph(
  ctx: RequestContext,
  deps: ViewDeps,
  caseId: string,
  query: QueryOf<'graph.get'>,
): Promise<InvestigationGraph> {
  const asOf = query.asOf ?? null;
  const state = await loadViewState(ctx, caseId);
  const computation = computationFor(ctx, deps, state, asOf);
  const [analysis, scenario, skills] = await Promise.all([
    computation.analysis(),
    query.scenarioId === undefined ? null : loadScenario(ctx, caseId, query.scenarioId),
    asOf === null ? loadCaseSkills(ctx, caseId) : Promise.resolve<GraphSkills>([]),
  ]);
  return buildInvestigationGraph({
    caseTitle: state.inputs.caseRecord.title,
    caseId,
    events: computation.events,
    analysis,
    asOf,
    now: ctx.now().toISOString(),
    scenario: scenarioForWindow(scenario, asOf),
    skills,
  });
}
