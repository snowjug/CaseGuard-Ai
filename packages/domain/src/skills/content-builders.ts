import type {
  ActionExecutor,
  DecisionStep,
  KnowledgeAction,
  KnowledgeSignal,
  Level,
  SkillCondition,
  SkillContent,
} from '@caseguard/schemas';
import {
  expectedInformationGain,
  outcomeDistributionFor,
  predictOutcomes,
} from '../engine/action-value';
import type { Belief } from '../engine/belief';
import type { CompiledPack } from '../knowledge/compile';
import { round } from '../util/math';
import { likelihoodOf } from './ladder';
import { actionSlug, clip, pct, slugify } from './util';

export type StepRole = 'enabling' | 'guard' | 'terminal';

export const EXECUTOR_LABELS: Record<ActionExecutor, string> = {
  engineer: 'the support engineer',
  customer_admin: 'the customer administrator',
  customer_network_admin: 'the customer network administrator',
  customer_end_user: 'an end user',
  system: 'the system',
};

export interface BranchContext {
  pack: CompiledPack;
  /** The belief at the decision time: the basis of every decision-time probability. */
  belief0: Belief;
  /** The recorded cause, when hindsight is in play (extraction and mutation, never matching). */
  truth: string | null;
  exclusionSignals: ReadonlySet<string>;
}

export const stepIdFor = (order: number, actionKey: string): string =>
  `step-${order}-${actionSlug(actionKey)}`;

export const requirementKey = (requirementId: string): string =>
  requirementId.replace(/^req\./, '');

const signalLabels = (pack: CompiledPack, ids: readonly string[]): string =>
  ids.map((id) => pack.signals.get(id)?.label ?? id).join('; ');

const riskLevelOf = (risk: number): Level => (risk < 0.25 ? 'low' : risk < 0.5 ? 'medium' : 'high');

function instructionOf(action: KnowledgeAction, pack: CompiledPack): string {
  const needs = action.requires.map((r) => pack.requirements.get(r)?.label ?? r);
  return clip(
    `${action.description} Run by ${EXECUTOR_LABELS[action.executor]}; customer effort ${action.customerEffort.replace('_', ' ')}; typically about ${action.timeMinutes.typical} minutes (estimate).${needs.length > 0 ? ` Needs first: ${needs.join('; ')}.` : ''}`,
    1200,
  );
}

/**
 * One decision step with a branch for EVERY outcome the pack defines for the action, so the skill is
 * explicit about what it does not cover. Probabilities are model estimates: `probability` from the
 * decision-time belief, `hindsightProbability` given the recorded cause (labelled as hindsight).
 */
export function buildDecisionStep(args: {
  action: KnowledgeAction;
  order: number;
  nextStepId: string | null;
  role: StepRole;
  ctx: BranchContext;
}): DecisionStep {
  const { action, order, nextStepId, role, ctx } = args;
  const { pack, belief0, truth } = ctx;
  const predicted = predictOutcomes(pack, action, belief0);
  const conditioned = truth ? outcomeDistributionFor(pack, action, truth) : null;
  const branches = action.outcomes.map((outcome, i) => {
    const emitted = outcome.emitsSignals;
    const breaksPremise = emitted.some((s) => ctx.exclusionSignals.has(s));
    const confirms =
      truth !== null &&
      emitted.length > 0 &&
      emitted.every((s) => {
        const signal = pack.signals.get(s);
        return signal ? likelihoodOf(signal, truth) >= 0.8 : false;
      });
    const next = breaksPremise
      ? 'stop'
      : role === 'terminal'
        ? confirms
          ? 'success'
          : 'stop'
        : (nextStepId ?? 'stop');
    const probability = round(predicted[i]?.probability ?? 0, 3);
    const hindsight = conditioned ? round(conditioned[i] ?? 0, 3) : undefined;
    const inference = pack.pack.inferences.find((inf) => emitted.includes(inf.signalId));
    const estimate = `Estimated ${pct(probability)} at the decision time${hindsight !== undefined ? `; ${pct(hindsight)} given the recorded cause (hindsight)` : ''}.`;
    const why = breaksPremise
      ? `This result contradicts the skill's premise (${signalLabels(pack, emitted)}), so it does not apply: stop and follow the investigation the evidence supports.`
      : role === 'terminal'
        ? confirms
          ? `Root cause isolated at this hop (${signalLabels(pack, emitted)}): separate workaround and permanent fix, get approval and validate before and after.`
          : 'This hop is not the cause here. Another check at this stage may still apply; otherwise stop and review manually (the skill has no validated branch for this result yet).'
        : `${inference ? `${inference.text} ` : ''}Continue with the next stage.`;
    return {
      condition: clip(outcome.label, 300),
      outcomeId: outcome.id,
      next,
      rationale: clip(`${why} ${estimate}`, 400),
      probability,
      ...(hindsight !== undefined ? { hindsightProbability: hindsight } : {}),
    };
  });
  return {
    id: stepIdFor(order, action.id),
    order,
    title: clip(action.label, 200),
    instruction: instructionOf(action, pack),
    actionKey: action.id,
    expectedInformationGainBits: round(expectedInformationGain(pack, action, belief0).bits, 3),
    requiresInputs: action.requires.map(requirementKey),
    branches,
  };
}

export function buildCandidateAction(
  action: KnowledgeAction,
  whenToUse: string,
): SkillContent['candidateActions'][number] {
  return {
    actionKey: action.id,
    label: clip(action.label, 160),
    whenToUse: clip(whenToUse, 300),
    risk: riskLevelOf(action.operationalRisk),
    customerEffort: action.customerEffort,
    requiresApproval: action.requiresApproval,
  };
}

export function buildCondition(
  signal: KnowledgeSignal,
  prefix: 'trg' | 'exc',
  weight: number,
  required: boolean,
): SkillCondition {
  return {
    id: `${prefix}-${slugify(signal.id.replace(/^sig\./, ''))}`,
    description: clip(signal.label, 400),
    kind: 'signal',
    signalId: signal.id,
    weight,
    required,
  };
}

export function buildRequiredInputs(
  pack: CompiledPack,
  actions: readonly KnowledgeAction[],
): SkillContent['requiredInputs'] {
  const ids = [...new Set(actions.flatMap((a) => a.requires))].sort();
  return ids.map((id) => ({
    key: requirementKey(id),
    label: clip(pack.requirements.get(id)?.label ?? id, 120),
    description: clip(pack.requirements.get(id)?.description ?? '', 300),
    required: true,
  }));
}

export function buildMinimumEvidence(pack: CompiledPack): SkillContent['minimumEvidence'] {
  return pack.pack.policies.minimumEvidenceForEscalation.map((id) => ({
    requirementId: id,
    label: clip(pack.requirements.get(id)?.label ?? id, 160),
    description: clip(pack.requirements.get(id)?.description ?? '', 300),
  }));
}

/** The success condition an action's confirming outcome implies for the recorded cause. */
export function successConditionOf(
  pack: CompiledPack,
  action: KnowledgeAction,
  truth: string,
): string | null {
  const outcome = action.outcomes.find(
    (o) =>
      o.emitsSignals.length > 0 &&
      o.emitsSignals.every((s) => {
        const signal = pack.signals.get(s);
        return signal ? likelihoodOf(signal, truth) >= 0.8 : false;
      }),
  );
  if (!outcome) return null;
  return clip(
    `${action.label}: ${signalLabels(pack, outcome.emitsSignals)} (consistent with “${pack.hypotheses.get(truth)?.name ?? truth}”). Then separate the workaround from the permanent fix, obtain approval and validate before and after.`,
    300,
  );
}

/** Stop and escalation conditions derived from the exclusions and the pack's escalation policy. */
export function buildStopAndEscalation(
  pack: CompiledPack,
  exclusionIds: readonly string[],
): { stopConditions: string[]; escalationConditions: string[] } {
  const stops = exclusionIds
    .map((id) => pack.signals.get(id))
    .filter((s): s is KnowledgeSignal => s !== undefined)
    .map((s) => clip(`Stop if: ${s.label}. ${s.description}`, 300));
  const minimum = pack.pack.policies.minimumEvidenceForEscalation.map(
    (id) => pack.requirements.get(id)?.label ?? id,
  );
  return {
    stopConditions: [
      ...stops,
      'Stop and review manually if the same diagnostic has already produced the same result (do not repeat it).',
    ],
    escalationConditions: [
      clip(
        `Escalate only with the minimum evidence attached (${minimum.join('; ')}) and when no supported branch of this skill remains.`,
        300,
      ),
    ],
  };
}

export function buildSafetyConstraints(actions: readonly KnowledgeAction[]): string[] {
  const fromPack = [
    ...new Set(actions.map((a) => a.safetyNotes).filter((n): n is string => Boolean(n))),
  ];
  return [
    'Never run a remediation, destructive or approval-required step before the cause is confirmed; this skill only recommends read-only diagnostic checks.',
    'Ask the customer for the minimum data first and avoid heavy requests such as full traces until cheaper checks have been exhausted.',
    ...fromPack.map((n) => clip(n, 300)),
  ].slice(0, 12);
}
