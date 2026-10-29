import type { KnowledgeAction } from '@caseguard/schemas';
import { riskLevelOf } from '../engine/forks';
import type { Checkpoint, SuggestedStep } from './types';

export function toSuggestedStep(action: KnowledgeAction): SuggestedStep {
  return {
    actionKey: action.id,
    label: action.label,
    kind: action.kind,
    timeMinutes: action.timeMinutes.typical,
    customerEffort: action.customerEffort,
    operationalRisk: action.operationalRisk,
    tokenEstimate: action.tokenEstimate,
  };
}

/** One sentence with the step and its estimated cost, effort and risk (all from the knowledge pack). */
export function describeStep(step: SuggestedStep, lead = ''): string {
  const effort = step.customerEffort === 'none' ? 'no' : step.customerEffort.replace('_', ' ');
  const cost = `about ${Math.round(step.timeMinutes)} min, ${effort} customer effort, ${riskLevelOf(step.operationalRisk)} risk, ~${step.tokenEstimate} tokens`;
  return `${lead}${step.label} (${cost}; estimates from the knowledge pack).`;
}

export interface StepFilter {
  exclude?: ReadonlySet<string>;
  /** Only steps asking the customer for no more than this effort score (0-1). */
  maxEffortScore?: number;
  /** Prefer steps that test this hypothesis key. */
  target?: string;
}

const allowedFallback = (cp: Checkpoint, action: KnowledgeAction): boolean =>
  !action.destructive &&
  action.operationalRisk < cp.config.riskCeiling &&
  action.valueClass !== 'remediation';

/** Best-ranked safe diagnostic step for the evidence on record now, honouring the filter. */
export function bestNextStep(cp: Checkpoint, filter: StepFilter = {}): SuggestedStep | null {
  const pool = cp.rankNext().filter((c) => {
    if (filter.exclude?.has(c.action.id)) return false;
    if (
      filter.maxEffortScore !== undefined &&
      cp.config.effortScale[c.action.customerEffort] > filter.maxEffortScore
    )
      return false;
    return true;
  });
  const targeted = filter.target
    ? pool.find((c) => c.action.targets.includes(filter.target ?? ''))
    : undefined;
  const pick = targeted ?? pool[0];
  return pick ? toSuggestedStep(pick.action) : null;
}

/** Cheapest safe step in the pack that produces a requirement (used to obtain missing evidence). */
export function producerStep(cp: Checkpoint, requirementId: string): SuggestedStep | null {
  const producers = cp.pack.pack.actions
    .filter((a) => a.produces.includes(requirementId) && allowedFallback(cp, a))
    .sort((a, b) => a.timeMinutes.typical - b.timeMinutes.typical || (a.id < b.id ? -1 : 1));
  const pick = producers[0];
  return pick ? toSuggestedStep(pick) : null;
}

/** The pack's step of a given class (communication, validation), cheapest first. */
export function classStep(
  cp: Checkpoint,
  valueClass: KnowledgeAction['valueClass'],
): SuggestedStep | null {
  const pick = cp.pack.pack.actions
    .filter((a) => a.valueClass === valueClass && allowedFallback(cp, a))
    .sort((a, b) => a.timeMinutes.typical - b.timeMinutes.typical || (a.id < b.id ? -1 : 1))[0];
  return pick ? toSuggestedStep(pick) : null;
}

/**
 * The best safe alternative that was available at the decision time of an event (the decision-time
 * ranking the engine stored), skipping the step actually taken and honouring the filter.
 */
export function decisionAlternative(
  cp: Checkpoint,
  eventId: string,
  filter: StepFilter = {},
): SuggestedStep | null {
  const decision = cp.decision(eventId);
  if (!decision) return null;
  const taken = cp.actionByEvent.get(eventId)?.actionKey ?? null;
  for (const candidate of decision.candidates) {
    if (candidate.actionKey === taken || filter.exclude?.has(candidate.actionKey)) continue;
    const action = cp.pack.actions.get(candidate.actionKey);
    if (!action) continue;
    if (
      filter.maxEffortScore !== undefined &&
      cp.config.effortScale[action.customerEffort] > filter.maxEffortScore
    )
      continue;
    return toSuggestedStep(action);
  }
  return null;
}
