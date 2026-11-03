import {
  type CounterfactualBasis,
  type CounterfactualQuality,
  type CounterfactualStep,
  type CounterfactualStrategy,
  type EligibilityCheck,
  type FeasibilityLevel,
  type KnowledgeAction,
  type Level,
  type ScenarioSkillApplicability,
  type StepFeasibility,
} from '@caseguard/schemas';

/**
 * How far to trust a counterfactual path (wave 2). The simulator already says what the path is; this says what it rests on,
 * whether it could have been followed, what limits it and what a reviewer must confirm before relying on it. Everything here
 * is a pure function of the simulated path and the knowledge pack, so it adds no number and moves none: a figure of the path
 * is never made more certain by being described.
 */

const pct = (p: number): string => `${Math.round(p * 100)}%`;
const RANK: Readonly<Record<FeasibilityLevel, number>> = {
  feasible: 0,
  feasible_with_conditions: 1,
  not_feasible: 2,
};

/** A step that gives a usable result in fewer attempts than this is flagged. */
export const RELIABILITY_FLOOR = 0.7;
/** Share of the simulated runs that must reach a diagnosis for the path to support a comparison. */
export const MIN_DIAGNOSIS_SHARE = 0.5;

const isCustomerExecutor = (action: KnowledgeAction): boolean =>
  action.executor.startsWith('customer');

export interface FeasibilityInput {
  /** The risk at or above which a step is never suggested (the configured ceiling). */
  readonly riskCeiling: number;
  /** Prerequisites that held at the decision moment. */
  readonly availableAtBoundary: ReadonlySet<string>;
  /** Prerequisites an earlier step of the path produces, with the label of that step. */
  readonly producedEarlier: ReadonlyMap<string, string>;
  readonly requirementLabel: (id: string) => string;
}

/** Whether one step could have been taken at the decision moment, and what had to hold for it. */
export function stepFeasibility(action: KnowledgeAction, input: FeasibilityInput): StepFeasibility {
  const conditions: string[] = [];
  let level: FeasibilityLevel = 'feasible';
  const raise = (to: FeasibilityLevel): void => {
    if (RANK[to] > RANK[level]) level = to;
  };

  if (action.destructive) {
    raise('not_feasible');
    conditions.push(
      'It changes or removes something, which a diagnostic path must not do without a decision.',
    );
  } else if (action.operationalRisk >= input.riskCeiling) {
    raise('not_feasible');
    conditions.push(
      `Its risk (about ${pct(action.operationalRisk)}) is at or above the ceiling for a suggested step.`,
    );
  }

  for (const required of action.requires) {
    if (input.availableAtBoundary.has(required)) continue;
    const label = input.requirementLabel(required);
    const from = input.producedEarlier.get(required);
    if (from === undefined) {
      raise('not_feasible');
      conditions.push(
        `It needs ${label}, which did not exist yet and which no earlier step of the path produces.`,
      );
    } else {
      raise('feasible_with_conditions');
      conditions.push(`It needs ${label}, which comes from “${from}” earlier in the path.`);
    }
  }

  if (isCustomerExecutor(action)) {
    raise('feasible_with_conditions');
    const { min, typical, max } = action.timeMinutes;
    conditions.push(
      `The customer has to do it; the estimate assumes about ${typical} minutes (between ${min} and ${max}).`,
    );
  }
  if (action.requiresApproval) {
    raise('feasible_with_conditions');
    conditions.push('Someone has to approve it before it is run.');
  }
  if (
    !action.destructive &&
    action.operationalRisk > 0 &&
    action.operationalRisk < input.riskCeiling
  ) {
    raise('feasible_with_conditions');
    conditions.push(
      `It is not read-only (risk about ${pct(action.operationalRisk)}), so it needs review before it is run.`,
    );
  }
  if (action.reliability < RELIABILITY_FLOOR) {
    raise('feasible_with_conditions');
    conditions.push(`It gives a usable result in about ${pct(action.reliability)} of attempts.`);
  }
  return { level, conditions: conditions.slice(0, 8) };
}

export const NOT_ASSESSED_SKILLS: ScenarioSkillApplicability = {
  status: 'not_assessed',
  skills: [],
  note: 'Skills are matched when the case is analysed; none had been checked against this path.',
};

export interface ScenarioQualityInput {
  readonly strategy: CounterfactualStrategy;
  readonly steps: readonly CounterfactualStep[];
  /** The pack action behind each step, in the same order. */
  readonly actions: readonly KnowledgeAction[];
  readonly validity: { readonly valid: boolean; readonly checks: readonly EligibilityCheck[] };
  readonly comparison: { readonly level: Level; readonly score: number };
  readonly rollouts: {
    readonly count: number;
    readonly seed: string;
    readonly diagnosisReachedShare: number;
  };
  readonly eventCount: number;
}

/** Why a path cannot support a comparison, or null when it can. */
export function illustrativeReason(
  input: Pick<ScenarioQualityInput, 'steps' | 'validity' | 'rollouts'>,
): string | null {
  if (input.steps.length === 0) return 'no supported next step could be ranked at that moment';
  if (!input.validity.valid) {
    const failed = input.validity.checks.filter((check) => !check.passed).map((check) => check.id);
    return `a validity check failed (${failed.join(', ')})`;
  }
  if (input.rollouts.diagnosisReachedShare < MIN_DIAGNOSIS_SHARE) {
    return `it reached a diagnosis in only ${pct(input.rollouts.diagnosisReachedShare)} of ${input.rollouts.count} simulated runs`;
  }
  return null;
}

/**
 * The basis of a path the engine simulated: a computed estimate when it can support a comparison, an illustration when it
 * cannot. A model's own proposal is `model_estimate` and is never produced here.
 */
export function basisOf(
  input: Pick<ScenarioQualityInput, 'steps' | 'validity' | 'rollouts'>,
): CounterfactualBasis {
  return illustrativeReason(input) === null ? 'deterministic_estimate' : 'illustrative';
}

const STRATEGY_CONSTRAINT: Readonly<Record<CounterfactualStrategy, string | null>> = {
  balanced: null,
  lowest_customer_effort:
    'This strategy leaves out steps that ask a lot of the customer, even when they would teach more.',
  fastest_diagnosis:
    'This strategy favours elapsed time, so it may accept more risk or customer effort than the balanced path.',
};

export function assessScenarioQuality(input: ScenarioQualityInput): CounterfactualQuality {
  const { steps, actions, rollouts } = input;
  const reason = illustrativeReason(input);
  const basis: CounterfactualBasis = reason === null ? 'deterministic_estimate' : 'illustrative';

  const labelled = steps.map((step, index) => ({
    step,
    action: actions[index],
    n: index + 1,
  }));

  const level = steps.reduce<FeasibilityLevel>((worst, step) => {
    const own = step.feasibility?.level ?? 'feasible';
    return RANK[own] > RANK[worst] ? own : worst;
  }, 'feasible');
  const reasons = labelled
    .flatMap(({ step, n }) =>
      (step.feasibility?.conditions ?? []).map(
        (condition) => `Step ${n} (${step.label}): ${condition}`,
      ),
    )
    .slice(0, 12);

  const customerSteps = labelled.filter(
    ({ action }) => action !== undefined && isCustomerExecutor(action),
  );
  const approvalSteps = labelled.filter(({ action }) => action?.requiresApproval === true);
  const engineerSteps = labelled.filter(
    ({ action }) => action !== undefined && !isCustomerExecutor(action),
  );

  const constraints: string[] = [];
  const strategyConstraint = STRATEGY_CONSTRAINT[input.strategy];
  if (strategyConstraint !== null) constraints.push(strategyConstraint);
  constraints.push(
    `Only what was recorded before the decision moment was used (${input.eventCount} event${input.eventCount === 1 ? '' : 's'}); nothing later, and not the final resolution.`,
    'Only steps that exist in the knowledge pack are considered: the path cannot include a step nobody has described.',
    'The simulation does not know the access, permissions or tools the engineer actually had.',
  );
  if (customerSteps.length > 0) {
    constraints.push(
      `${customerSteps.length} step${customerSteps.length === 1 ? '' : 's'} depend${customerSteps.length === 1 ? 's' : ''} on the customer, so the time depends on how quickly they answer.`,
    );
  }
  if (approvalSteps.length > 0) {
    constraints.push(
      `${approvalSteps.length} step${approvalSteps.length === 1 ? ' needs' : 's need'} approval before ${approvalSteps.length === 1 ? 'it' : 'they'} can be run.`,
    );
  }

  const validation: string[] = [];
  if (engineerSteps.length > 0) {
    validation.push(
      'Check that an engineer could have run each engineer step with the access and permissions available at the time.',
    );
  }
  for (const { step, n } of customerSteps) {
    validation.push(
      `Check that the customer could have done step ${n} (${step.label}) in about the time assumed.`,
    );
  }
  for (const { step, n } of approvalSteps) {
    validation.push(
      `Get the approval step ${n} (${step.label}) needs before treating it as possible.`,
    );
  }
  validation.push(
    'Compare each predicted outcome with what the same kind of step returned in this case or in similar ones: the outcomes are probabilities from the knowledge pack, not observations.',
    'Quote times, token counts and any saving as ranges; do not quote a single figure.',
    'The hindsight check, which uses the recorded outcome, is shown apart and never changes this path.',
  );
  if (reason !== null) {
    validation.unshift(`Do not use this path to estimate a saving: ${reason}.`);
  }

  const recordedNote = 'Read from the timestamps and events of this case.';
  const estimateNote = `Simulated ${rollouts.count} times from the knowledge pack with seed ${rollouts.seed}; the pack's probabilities and times are authored, not calibrated on real outcomes.`;
  const parts: CounterfactualQuality['basis']['parts'] = [
    {
      what: 'Recorded path: elapsed time, steps and customer exchanges',
      basis: 'measured',
      note: recordedNote,
    },
    {
      what: 'Recorded path: token and effort figures',
      basis: 'deterministic_estimate',
      note: 'Estimated from the knowledge pack’s figure for each step the engine recognised; nothing was metered.',
    },
    { what: 'Alternative path: the steps and what each would return', basis, note: estimateNote },
    {
      what: 'Alternative path: time, token and effort figures',
      basis,
      note: 'The middle and the range of the simulated runs.',
    },
  ];

  const summary =
    reason === null
      ? `A computed estimate. The engine simulated this path ${rollouts.count} times from the knowledge pack's authored probabilities. It is a range and not a measurement, and the pack has not been calibrated against real outcomes.`
      : `An illustration only: ${reason}. It shows what the engine would try, not what it would save.`;

  return {
    basis: { scenario: basis, summary, parts },
    feasibility: { level, reasons },
    constraints: constraints.slice(0, 12),
    skillApplicability: NOT_ASSESSED_SKILLS,
    validation: validation.slice(0, 12),
    timeSavedClaim: reason === null ? 'estimated_range' : 'none',
  };
}
