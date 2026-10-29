import type { CounterfactualScenario } from '@caseguard/schemas';
import { generateCounterfactuals } from '@caseguard/domain';
import type { CounterfactualProposal } from '../../agents/outputs';
import type { CounterfactualTaskInput } from '../../agents/tasks';
import { AiTaskError } from '../../errors';
import { clip, percent, uncertainty } from './shared';

/**
 * Projects a domain scenario onto the compact proposal contract. Every number and step comes from
 * the engine; only the wording is assembled here.
 */
export function projectScenario(
  scenario: CounterfactualScenario,
  input: Pick<CounterfactualTaskInput, 'fork' | 'strategy' | 'pack'>,
): CounterfactualProposal {
  const { fork, strategy, pack } = input;
  return {
    forkEventId: fork.eventId,
    strategy,
    steps: scenario.steps.slice(0, 12).map((s) => {
      const action = pack.actions.get(s.actionKey);
      const outcomeId = action?.outcomes.some((o) => o.id === s.predictedOutcome.outcomeId)
        ? s.predictedOutcome.outcomeId
        : null;
      return {
        order: s.index + 1,
        actionKey: s.actionKey,
        rationale: clip(`${s.label}. ${s.rationale}`, 600),
        evidenceUsedIds: s.evidenceUsedIds.slice(0, 10),
        expectedOutcome: clip(
          `Simulated outcome: ${s.predictedOutcome.label} (about ${percent(s.predictedOutcome.probability)}). ${s.predictedOutcome.simulatedResult}`,
          300,
        ),
        expectedOutcomeId: outcomeId,
        assumptions: s.assumptions.slice(0, 6).map((a) => clip(a, 300)),
      };
    }),
    assumptions: scenario.assumptions.slice(0, 8).map((a) => clip(a, 300)),
    labels: { simulated: true, estimated: true },
    uncertainty: uncertainty(
      scenario.comparisonConfidence.level,
      scenario.comparisonConfidence.rationale,
    ),
  };
}

/** Runs the domain counterfactual generator for one strategy and projects the scenario. */
export function runCounterfactualSimulator(input: CounterfactualTaskInput): CounterfactualProposal {
  const { analysis, fork, strategy, events, resolution, pack, config, ctx, rolloutCount } = input;
  const result = generateCounterfactuals({
    analysis,
    fork,
    strategies: [strategy],
    events,
    resolution,
    pack,
    config,
    ctx,
    ...(rolloutCount !== undefined ? { rolloutCount } : {}),
  });
  const scenario = result.scenarios[0];
  if (!scenario) {
    throw new AiTaskError('internal_validation_failure', 'The domain engine produced no scenario.');
  }
  return projectScenario(scenario, input);
}
