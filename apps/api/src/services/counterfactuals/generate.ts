import {
  generateCounterfactuals,
  type CounterfactualResult,
  type DeterministicAnalysis,
  type EngineContext,
} from '@caseguard/domain';
import {
  COUNTERFACTUAL_STRATEGIES,
  type CounterfactualScenario,
  type CounterfactualStrategy,
  type DecisionFork,
} from '@caseguard/schemas';
import { canonicalJson } from '@caseguard/security';
import type { AnalysisInputs } from '../analysis';

/** Same bound as the analysis pipeline: simulating every fork of a pathological case is wasted work. */
export const MAX_DEFAULT_FORKS = 12;

/** The earliest meaningful fork gets every strategy; the other eligible forks the balanced path only. */
const SECONDARY_STRATEGIES: readonly CounterfactualStrategy[] = ['balanced'];

export interface ScenarioPlanItem {
  readonly fork: DecisionFork;
  readonly strategies: readonly CounterfactualStrategy[];
}

/**
 * Which scenarios a case should have by default. Mirrors what the analysis pipeline generates
 * (`services/analysis/compute.ts`): eligible forks only, the earliest meaningful one first.
 */
export function defaultScenarioPlan(forks: readonly DecisionFork[]): ScenarioPlanItem[] {
  const eligible = forks.filter((fork) => fork.eligibility.eligible);
  return [
    ...eligible.filter((fork) => fork.isEarliestMeaningful),
    ...eligible.filter((fork) => !fork.isEarliestMeaningful),
  ]
    .slice(0, MAX_DEFAULT_FORKS)
    .map((fork) => ({
      fork,
      strategies: fork.isEarliestMeaningful ? COUNTERFACTUAL_STRATEGIES : SECONDARY_STRATEGIES,
    }));
}

/** Unique strategies in their canonical order, so equal requests produce equal job keys. */
export function orderStrategies(
  strategies: readonly CounterfactualStrategy[],
): CounterfactualStrategy[] {
  const wanted = new Set(strategies);
  return COUNTERFACTUAL_STRATEGIES.filter((strategy) => wanted.has(strategy));
}

/** What generation reads: the full analysis and record, and the engine identity of the stored run. */
export interface GenerationSource {
  readonly analysis: DeterministicAnalysis;
  readonly engineCtx: EngineContext;
  readonly inputs: Pick<AnalysisInputs, 'events' | 'resolution' | 'pack' | 'actionConfig'>;
}

/**
 * Runs the engine's counterfactual generator. Generation sees only the decision-moment view of
 * `fork` (strictly before its event, never the resolution): the engine builds that view itself from
 * the full event list, runs the leak check and the validity checks, and decides each scenario's
 * status. The hindsight checks it returns are computed afterwards from the full record and are kept
 * apart: nothing here feeds them back into generation.
 */
export function generateForFork(
  source: GenerationSource,
  fork: DecisionFork,
  strategies: readonly CounterfactualStrategy[],
): CounterfactualResult {
  const { analysis, inputs, engineCtx } = source;
  return generateCounterfactuals({
    analysis,
    fork,
    strategies,
    events: inputs.events,
    resolution: inputs.resolution,
    pack: inputs.pack,
    config: inputs.actionConfig,
    ctx: engineCtx,
  });
}

/**
 * The part of a scenario that describes the simulation itself: everything a reviewer judged. The
 * run that produced it, the model execution that validated it, the review decision and the record
 * bookkeeping are left out.
 */
function simulationOf(scenario: CounterfactualScenario): string {
  return canonicalJson({
    ...scenario,
    analysisRunId: undefined,
    modelExecutionId: undefined,
    reviewState: undefined,
    reviewReason: undefined,
    reviewedBy: undefined,
    reviewedAt: undefined,
    version: undefined,
    createdAt: undefined,
    updatedAt: undefined,
    createdBy: undefined,
    boundary: {
      ...scenario.boundary,
      leakCheck: { ...scenario.boundary.leakCheck, checkedAt: undefined },
    },
  });
}

/** True when two scenarios describe exactly the same simulated path, boundary and checks. */
export function sameSimulation(a: CounterfactualScenario, b: CounterfactualScenario): boolean {
  return simulationOf(a) === simulationOf(b);
}

/**
 * A regenerated scenario that reproduces a stored one keeps the reviewer's decision: the reviewer
 * judged this exact simulation, and only its provenance (the run or model execution) changed.
 * Anything else starts as pending again.
 */
export function carryReview(
  stored: CounterfactualScenario,
  generated: CounterfactualScenario,
): CounterfactualScenario {
  if (!sameSimulation(stored, generated)) return generated;
  return {
    ...generated,
    reviewState: stored.reviewState,
    reviewReason: stored.reviewReason,
    reviewedBy: stored.reviewedBy,
    reviewedAt: stored.reviewedAt,
  };
}
