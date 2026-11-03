import type { CounterfactualScenario } from '@caseguard/schemas';
import { canonicalJson } from '@caseguard/security';
import type { TenantRepositories } from '../../db';
import type { RequestContext } from '../../http/request-context';

/*
 * Whether a reviewer's decision survives a regeneration of the same scenario. Shared by the analysis
 * pipeline (every re-run regenerates the default scenarios) and by `counterfactuals.run`: both ask
 * the same question and must give the same answer.
 */

/**
 * The part of a scenario that describes the simulation itself: its fork and strategy, the boundary
 * and the checks, the steps (ids, actions, outcomes and numbers) and the comparison with the
 * recorded path. Left out: the run that produced it, the model execution that validated it, the
 * wording of the steps (a validated model proposal may reword a step but never change it), the
 * annotations derived from it (whether each step was feasible, how far to trust the path), the
 * review decision and the record bookkeeping.
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
    steps: scenario.steps.map((step) => ({
      ...step,
      rationale: undefined,
      feasibility: undefined,
    })),
    // How far to trust the path is derived from the simulation and the pack, and its skill part from the skill library:
    // neither is what a reviewer judged, so neither may reset a decision.
    quality: undefined,
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

/** A reviewer has accepted, rejected or corrected the scenario (anything but still waiting). */
export function isDecided(scenario: CounterfactualScenario): boolean {
  return scenario.reviewState !== 'pending';
}

/**
 * A regenerated scenario that reproduces a stored one keeps the reviewer's decision: the reviewer
 * judged this exact simulation, and only its provenance (the run or the model execution) changed.
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

export interface ReviewCarryPlan {
  /** What to persist, in the order of the regenerated scenarios. */
  readonly scenarios: CounterfactualScenario[];
  /** Stored scenarios whose decision (accepted, rejected or corrected) was kept. */
  readonly carried: readonly CounterfactualScenario[];
  /** Stored scenarios whose decision was dropped because the regenerated simulation differs. */
  readonly reset: readonly CounterfactualScenario[];
}

/**
 * Decides, for every regenerated scenario, what happens to the decision on the scenario with the
 * same id: it is kept when the simulation is the same and dropped (back to pending) when it is not.
 * Scenarios nobody had decided on are simply replaced. Stored scenarios that were not regenerated are
 * not part of the plan and stay untouched.
 */
export function planReviewCarry(
  stored: readonly CounterfactualScenario[],
  generated: readonly CounterfactualScenario[],
): ReviewCarryPlan {
  const before = new Map(stored.map((scenario) => [scenario.id, scenario]));
  const scenarios: CounterfactualScenario[] = [];
  const carried: CounterfactualScenario[] = [];
  const reset: CounterfactualScenario[] = [];
  for (const next of generated) {
    const previous = before.get(next.id);
    if (previous === undefined || !isDecided(previous)) {
      scenarios.push(next);
    } else if (sameSimulation(previous, next)) {
      scenarios.push(carryReview(previous, next));
      carried.push(previous);
    } else {
      scenarios.push(next);
      reset.push(previous);
    }
  }
  return { scenarios, carried, reset };
}

/**
 * Records, in the caller's transaction, that a reviewer's decision was reset because the engine or its
 * inputs changed the simulation. Ids, enums and counters only: the reviewer's reason never goes here.
 */
export async function recordReviewResets(
  ctx: RequestContext,
  tx: TenantRepositories,
  args: {
    readonly caseId: string;
    readonly analysisRunId: string;
    readonly reset: readonly CounterfactualScenario[];
  },
): Promise<void> {
  for (const before of args.reset) {
    await ctx.audit(
      {
        action: 'counterfactual.review_reset',
        targetType: 'counterfactual',
        targetId: before.id,
        caseId: args.caseId,
        outcome: 'success',
        details: {
          forkId: before.forkId,
          strategy: before.strategy,
          previousState: before.reviewState,
          previousVersion: before.version,
          previousAnalysisRunId: before.analysisRunId,
          analysisRunId: args.analysisRunId,
          cause: 'simulation_changed',
        },
      },
      tx,
    );
  }
}
