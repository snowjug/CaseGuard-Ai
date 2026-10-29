import type { CounterfactualScenario, DecisionFork } from '@caseguard/schemas';

/**
 * The refusals that follow from the stored records alone, so a request can be refused with the
 * engine's own wording before a job is queued. This mirrors the domain's `forkRefusals` and
 * `scenarioRefusals` with `requireAcceptedReview` on, in the same order and words (a test compares
 * both against the domain function); inside the job the domain remains the authority and may add
 * reasons that need the whole analysis (for example a resolution that was never validated).
 */
export function extractionPreflight(input: {
  readonly caseId: string;
  readonly scenario: CounterfactualScenario;
  readonly fork: DecisionFork | null;
}): string[] {
  const { caseId, scenario, fork } = input;
  const reasons: string[] = [];
  if (fork === null) {
    return ['The decision fork of this scenario no longer exists in the stored analysis.'];
  }
  if (fork.caseId !== caseId) reasons.push('The fork belongs to a different case.');
  if (!fork.eligibility.eligible) {
    reasons.push(
      `The decision fork is not eligible for counterfactual simulation: ${fork.eligibility.reasons.join(' ') || 'an eligibility check failed.'}`,
    );
  }
  if (fork.reviewState === 'rejected') reasons.push('A reviewer rejected this decision fork.');

  if (scenario.forkId !== fork.id) reasons.push('The scenario was generated for a different fork.');
  if (scenario.status !== 'completed') {
    reasons.push(`The scenario status is ${scenario.status}, not completed.`);
  }
  if (!scenario.validity.valid) {
    reasons.push('The scenario failed the counterfactual validity checks.');
  }
  const leak = scenario.boundary.leakCheck;
  if (!leak.passed || leak.futureReferencesFound > 0 || !leak.resolutionExcluded) {
    reasons.push('The scenario did not pass the temporal leak check.');
  }
  if (scenario.reviewState === 'rejected') reasons.push('A reviewer rejected this scenario.');
  if (scenario.reviewState !== 'confirmed' && scenario.reviewState !== 'corrected') {
    reasons.push('The scenario has not been accepted by a reviewer yet.');
  }
  return reasons;
}

/** Scenarios a reviewer accepted: the only ones skill extraction may use. */
export const isAccepted = (scenario: Pick<CounterfactualScenario, 'reviewState'>): boolean =>
  scenario.reviewState === 'confirmed' || scenario.reviewState === 'corrected';
