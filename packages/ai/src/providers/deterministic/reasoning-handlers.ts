import type { CaseCriticOutput, CaseReasonerOutput } from '../../agents/outputs';
import type { CaseCriticTaskInput, CaseReasonerTaskInput } from '../../agents/tasks';

/** Said in the output itself, so a result that nothing proposed cannot be mistaken for a review that found nothing. */
export const MODEL_ASSISTANCE_NOT_USED = 'Model assistance not used.';

const NOT_USED = {
  level: 'high' as const,
  note: `${MODEL_ASSISTANCE_NOT_USED} The deterministic provider proposes no findings; only a configured model can.`,
};

/**
 * The deterministic provider proposes nothing. It returns an empty, valid reply with a note that says so, which is what
 * makes the result source `deterministic`: the layer is optional and the engine stays the source of truth.
 */
export function runCaseReasoner(_input: CaseReasonerTaskInput): CaseReasonerOutput {
  return {
    signals: [],
    contradictions: [],
    missingEvidence: [],
    missedSteps: [],
    counterfactuals: [],
    recommendations: [],
    synthesis: null,
    uncertainty: { ...NOT_USED },
  };
}

/** Nothing to critique: no result, and the same note. */
export function runCaseCritic(_input: CaseCriticTaskInput): CaseCriticOutput {
  return { result: null, uncertainty: { ...NOT_USED } };
}
