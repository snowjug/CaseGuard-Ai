import type {
  ActionValueConfig,
  EffortLevel,
  Range,
  SkillContent,
  SkillLifecycle,
  SkillMatchStep,
} from '@caseguard/schemas';
import type { CompiledPack } from '../knowledge/compile';
import { formatUtcStamp } from '../util/time';
import {
  awaitsDecisiveResult,
  buildEntries,
  evaluateEntry,
  expectedOutcomesOf,
  templatesFor,
  type Entry,
  type EntryEval,
  type PlanExpectedOutcome,
  type PlanTemplate,
  type StepAvailability,
} from './plan-entries';
import { diagnosisStatus, type KnowledgeState } from './state';
import { clip } from './util';

export type { PlanExpectedOutcome, PlanTemplate, StepAvailability } from './plan-entries';

export type PlanStatus = 'in_progress' | 'success' | 'stopped' | 'escalate';

export interface GuidedPlanStep {
  stepId: string;
  /** Steps that share a stage answer the same question; the plan ranks them by action value. */
  stage: number;
  role: 'skill_step' | 'stage_alternative';
  title: string;
  instruction: string;
  actionKey: string | null;
  status: SkillMatchStep['status'];
  availability: StepAvailability;
  rationale: string;
  /** Model-estimated action value at this moment (null once the step is done). */
  actionValue: number | null;
  /** Rank among the steps that are ready now (1 is the recommendation). */
  rank: number | null;
  blockedBy: string[];
  executedAt: string | null;
  executedEventId: string | null;
  observedOutcome: { outcomeId: string; label: string } | null;
  expectedOutcomes: PlanExpectedOutcome[];
  templates: PlanTemplate[];
  safetyNotes: string[];
  customerEffort: EffortLevel | null;
  operationalRisk: number | null;
  requiresApproval: boolean;
  estimatedMinutes: Range | null;
}

export interface GuidedPlan {
  skillId: string;
  versionId: string;
  skillName: string;
  skillVersion: string;
  lifecycle: SkillLifecycle;
  caseId: string;
  asOf: string;
  status: PlanStatus;
  summary: string;
  /** Every step and stage alternative in stage order. */
  steps: GuidedPlanStep[];
  /** Steps that can start now, ranked by action value (best first). */
  nextSteps: GuidedPlanStep[];
  waitingOn: string[];
  minimumEvidence: { requirementId: string; label: string; satisfied: boolean }[];
  stopConditions: string[];
  escalationConditions: string[];
  safetyConstraints: string[];
  labels: { modelEstimate: true; estimated: true };
  notices: string[];
}

export interface PlanCore {
  status: PlanStatus;
  steps: GuidedPlanStep[];
  nextSteps: GuidedPlanStep[];
  waitingOn: string[];
  currentStage: number | null;
  stageCount: number;
  endNote: string | null;
}

/**
 * The guided plan for a skill given what is known now. Stages follow the skill's order; steps inside a
 * stage are alternatives ranked by action value. A `stop` branch ends the path unless the stage still
 * has an alternative check that has not run, in which case that alternative is recommended instead.
 */
export function planFromState(args: {
  content: SkillContent;
  pack: CompiledPack;
  config: ActionValueConfig;
  state: KnowledgeState;
}): PlanCore {
  const { content, pack, config, state } = args;
  const entries = buildEntries(content, pack);
  const evals = new Map(entries.map((e) => [e.id, evaluateEntry(e, pack, config, state)]));
  const evalOf = (entry: Entry): EntryEval => {
    const found = evals.get(entry.id);
    if (!found) throw new Error(`Plan entry ${entry.id} has no evaluation`);
    return found;
  };
  const stages = [...new Set(entries.map((e) => e.stage))].sort((a, b) => a - b);

  let status: PlanStatus = 'in_progress';
  let endNote: string | null = null;
  let ended = false;
  let currentStage: number | null = null;
  const awaiting: string[] = [];
  const branchOf = (entry: Entry) => {
    const outcome = evalOf(entry).outcome;
    return outcome ? entry.step?.branches.find((b) => b.outcomeId === outcome.id) : undefined;
  };
  for (const stage of stages) {
    if (ended) break;
    const gating = entries.filter((e) => e.stage === stage && !evalOf(e).manual);
    if (gating.length === 0) continue;
    const ran = gating.filter((e) => evalOf(e).exec !== null);
    const completing = ran.length > 0 ? ran : gating.filter((e) => evalOf(e).moot);
    if (completing.length === 0) {
      currentStage ??= stage;
      continue;
    }
    const pending = ran.some((e) => evalOf(e).outcome !== null)
      ? []
      : ran.filter((e) => awaitsDecisiveResult(e, evalOf(e)));
    if (pending.length > 0) {
      currentStage ??= stage;
      awaiting.push(...pending.map((e) => e.step?.title ?? e.action?.label ?? e.id));
      break;
    }
    const success = completing.map(branchOf).find((b) => b?.next === 'success');
    const confirmedByAlternative =
      completing.some((e) => e.role === 'stage_alternative' && evalOf(e).exec !== null) &&
      diagnosisStatus(pack, state).done;
    if (success || confirmedByAlternative) {
      status = 'success';
      endNote = success?.rationale ?? 'An alternative check at this stage confirmed the diagnosis.';
      ended = true;
      continue;
    }
    const stopping = completing
      .map(branchOf)
      .find((b) => b?.next === 'escalate' || b?.next === 'stop');
    if (!stopping) continue;
    const spare = gating.filter(
      (e) =>
        !completing.includes(e) &&
        evalOf(e).exec === null &&
        !evalOf(e).moot &&
        evalOf(e).availability !== 'unavailable',
    );
    if (spare.length > 0) {
      currentStage ??= stage;
      continue;
    }
    status = stopping.next === 'stop' ? 'stopped' : 'escalate';
    endNote = stopping.rationale;
    ended = true;
  }
  if (!ended && currentStage === null && stages.length > 0) {
    const diagnosed = diagnosisStatus(pack, state).done;
    status = diagnosed ? 'success' : 'stopped';
    endNote = diagnosed
      ? 'Every stage of the skill is complete and the confirmed diagnosis criteria are met.'
      : 'Every stage of the skill is complete without a confirmed diagnosis: review manually or escalate with the minimum evidence.';
  }

  const readyOf = (stage: number): Entry[] =>
    entries
      .filter(
        (e) =>
          e.stage === stage &&
          !evalOf(e).manual &&
          evalOf(e).exec === null &&
          !evalOf(e).moot &&
          evalOf(e).availability === 'ready',
      )
      .sort((a, b) => (evalOf(b).value ?? 0) - (evalOf(a).value ?? 0) || a.order - b.order);

  let ranked: Entry[] = [];
  const waitingOn: string[] = [];
  if (status === 'in_progress' && currentStage !== null) {
    ranked = awaiting.length > 0 ? [] : readyOf(currentStage);
    if (awaiting.length > 0) {
      waitingOn.push(...awaiting.map((title) => `The recorded result of “${title}”`));
    } else if (ranked.length === 0) {
      for (const entry of entries.filter((e) => e.stage === currentStage)) {
        for (const reason of evalOf(entry).blockedBy) {
          const text = reason.replace(/^Needs first: /, '');
          if (!waitingOn.includes(text)) waitingOn.push(text);
        }
      }
    }
  }
  const rankOf = new Map(ranked.map((e, i) => [e.id, i + 1]));

  const steps: GuidedPlanStep[] = entries.map((entry) => {
    const ev = evalOf(entry);
    const action = entry.action;
    const rank = rankOf.get(entry.id) ?? null;
    const answeredBy = entries.find(
      (e) => e.stage === entry.stage && e.id !== entry.id && evalOf(e).exec !== null,
    );
    let stepStatus: SkillMatchStep['status'] = 'pending';
    let rationale: string;
    if (ev.exec) {
      stepStatus = 'done';
      rationale = `Done${ev.exec.at ? ` at ${formatUtcStamp(ev.exec.at)}` : ' in the simulated replay'}; ${ev.outcome ? `result: ${ev.outcome.label}` : 'its result has not been recorded yet'}.`;
    } else if (ev.moot) {
      stepStatus = 'skipped';
      rationale = answeredBy
        ? `Not needed: another check at this stage (${answeredBy.step?.title ?? answeredBy.action?.label ?? 'completed'}) already answered the question.`
        : `Not needed: the evidence this step would collect is already available${ev.outcome ? ` (${ev.outcome.label})` : ''}.`;
    } else if (ended) {
      rationale = 'Not needed: the path ended at an earlier stage.';
    } else if (rank === 1) {
      stepStatus = 'recommended_next';
      rationale =
        ranked.length > 1
          ? `Recommended next: ranked first of ${ranked.length} alternative checks at stage ${entry.stage} by estimated action value (${ev.value ?? 0}).`
          : `Recommended next: the next stage of the skill (stage ${entry.stage} of ${stages.length}); estimated action value ${ev.value ?? 0}.`;
    } else if (rank !== null) {
      rationale = `Ready: ranked ${rank} of ${ranked.length} at this stage by estimated action value (${ev.value ?? 0}).`;
    } else if (ev.availability === 'unavailable') {
      rationale = ev.unsafeReasons.join(' ');
    } else if (ev.availability === 'blocked') {
      rationale = `Waiting: ${ev.blockedBy.map((b) => b.replace(/^Needs first: /, '')).join('; ')}.`;
    } else if (awaiting.length > 0 && entry.stage === currentStage) {
      rationale = `Hold: the recorded result of “${awaiting.join('; ')}” is still to come and decides what to do next.`;
    } else if (currentStage !== null && entry.stage > currentStage) {
      rationale = `Comes after stage ${currentStage}.`;
    } else {
      rationale = 'Waiting for the earlier stage to complete.';
    }
    const availability: StepAvailability =
      ev.availability === 'ready' && rank === null && !ev.exec && !ev.moot
        ? 'later'
        : ev.availability;
    return {
      stepId: entry.id,
      stage: entry.stage,
      role: entry.role,
      title: entry.step?.title ?? entry.action?.label ?? entry.candidate?.label ?? entry.id,
      instruction:
        entry.step?.instruction ??
        clip(`${entry.candidate?.whenToUse ?? ''} ${action?.description ?? ''}`.trim(), 1200),
      actionKey: action?.id ?? entry.step?.actionKey ?? null,
      status: stepStatus,
      availability,
      rationale,
      actionValue: ev.value,
      rank,
      blockedBy: ev.blockedBy,
      executedAt: ev.exec?.at ?? null,
      executedEventId: ev.exec?.eventId ?? null,
      observedOutcome: ev.outcome ? { outcomeId: ev.outcome.id, label: ev.outcome.label } : null,
      expectedOutcomes: expectedOutcomesOf(entry, content, pack, state),
      templates: templatesFor(content, action),
      safetyNotes: action?.safetyNotes ? [action.safetyNotes] : [],
      customerEffort: action?.customerEffort ?? null,
      operationalRisk: action?.operationalRisk ?? null,
      requiresApproval: action?.requiresApproval ?? false,
      estimatedMinutes: action
        ? {
            low: action.timeMinutes.min,
            mid: action.timeMinutes.typical,
            high: action.timeMinutes.max,
          }
        : null,
    };
  });
  const byId = new Map(steps.map((s) => [s.stepId, s]));
  const nextSteps = ranked
    .map((e) => byId.get(e.id))
    .filter((s): s is GuidedPlanStep => s !== undefined);
  return {
    status,
    steps,
    nextSteps,
    waitingOn,
    currentStage,
    stageCount: stages.length,
    endNote,
  };
}

/** Contract projection used by `SkillMatch.recommendedSteps`. */
export const toMatchSteps = (plan: Pick<GuidedPlan, 'steps'>): SkillMatchStep[] =>
  plan.steps.map((s) => ({
    stepId: s.stepId,
    title: s.title,
    instruction: s.instruction,
    actionKey: s.actionKey,
    status: s.status,
    rationale: s.rationale,
    actionValue: s.actionValue,
  }));

export function summarizePlan(core: PlanCore): string {
  const next = core.nextSteps[0];
  if (core.status === 'success') {
    return `The skill's success condition has been reached. ${core.endNote ?? ''}`.trim();
  }
  if (core.status === 'stopped' || core.status === 'escalate') {
    return `${core.status === 'stopped' ? 'A stop condition applies' : 'The skill recommends escalating'}: ${core.endNote ?? 'see the stop conditions'}`;
  }
  if (next) {
    const alternatives = core.nextSteps.length;
    return `Next: ${next.title} (stage ${next.stage} of ${core.stageCount})${alternatives > 1 ? `; ${alternatives} alternative checks at this stage are ranked by estimated action value` : ''}.`;
  }
  return core.waitingOn.length > 0
    ? `Waiting for: ${core.waitingOn.join('; ')}.`
    : 'No step is ready at this moment.';
}

export const planNotices = (asOf: string): string[] => [
  `Uses only evidence available at or before ${formatUtcStamp(asOf)}.`,
  'Action values and outcome probabilities are model estimates from the knowledge pack, not measurements.',
];
