import type {
  ActionOutcome,
  ActionValueConfig,
  DecisionStep,
  KnowledgeAction,
  QueryTemplate,
  SkillContent,
} from '@caseguard/schemas';
import { evaluateAction, predictOutcomes } from '../engine/action-value';
import type { CompiledPack } from '../knowledge/compile';
import { round } from '../util/math';
import { revealedOutcome, toRankingState, type ExecutedAction, type KnowledgeState } from './state';
import { isTemplateOf, templatesOfAction } from './templates';
import { actionSlug, clip } from './util';

export type StepAvailability =
  'ready' | 'blocked' | 'unavailable' | 'completed' | 'not_needed' | 'later';

export interface PlanTemplate extends QueryTemplate {
  /** `knowledge_pack` templates are looked up for alternatives the skill lists but does not yet own. */
  source: 'skill' | 'knowledge_pack';
}

export interface PlanExpectedOutcome {
  outcomeId: string;
  label: string;
  probability: number | null;
  next: string;
  nextLabel: string;
  rationale: string;
}

type CandidateAction = SkillContent['candidateActions'][number];

export interface Entry {
  id: string;
  stage: number;
  role: 'skill_step' | 'stage_alternative';
  step: DecisionStep | null;
  candidate: CandidateAction | null;
  action: KnowledgeAction | null;
  order: number;
}

export interface EntryEval {
  exec: ExecutedAction | null;
  moot: boolean;
  outcome: ActionOutcome | null;
  value: number | null;
  availability: StepAvailability;
  blockedBy: string[];
  unsafeReasons: string[];
  manual: boolean;
}

const STAGE_ALTERNATIVE_PREFIX = 'alt-';

/**
 * Stage entries: each decision step, plus any candidate action the skill lists that answers the same
 * question as a step (it produces one of the requirements that step's action produces).
 */
export function buildEntries(content: SkillContent, pack: CompiledPack): Entry[] {
  const entries: Entry[] = content.decisionSequence.map((step, order) => ({
    id: step.id,
    stage: step.order,
    role: 'skill_step',
    step,
    candidate: null,
    action: step.actionKey ? (pack.actions.get(step.actionKey) ?? null) : null,
    order,
  }));
  const stepKeys = new Set(content.decisionSequence.map((s) => s.actionKey));
  const stages = [...new Set(entries.map((e) => e.stage))].sort((a, b) => a - b);
  content.candidateActions.forEach((candidate, index) => {
    if (stepKeys.has(candidate.actionKey)) return;
    const action = pack.actions.get(candidate.actionKey);
    if (!action || action.produces.length === 0) return;
    const host = stages.find((stage) =>
      entries.some(
        (e) =>
          e.stage === stage &&
          e.role === 'skill_step' &&
          e.action?.produces.some((r) => action.produces.includes(r)),
      ),
    );
    if (host === undefined) return;
    entries.push({
      id: `${STAGE_ALTERNATIVE_PREFIX}${actionSlug(candidate.actionKey)}`,
      stage: host,
      role: 'stage_alternative',
      step: null,
      candidate,
      action,
      order: 1000 + index,
    });
  });
  return entries.sort((a, b) => a.stage - b.stage || a.order - b.order);
}

function unsafeReasonsOf(action: KnowledgeAction, config: ActionValueConfig): string[] {
  const reasons: string[] = [];
  if (action.destructive) reasons.push('Destructive action: never recommended automatically.');
  if (action.operationalRisk >= config.riskCeiling) {
    reasons.push(
      `Operational risk ${round(action.operationalRisk, 2)} is at or above the ceiling of ${config.riskCeiling}.`,
    );
  }
  if (action.valueClass === 'remediation') {
    reasons.push(
      'Remediation is not a diagnostic step: it needs a confirmed diagnosis, approval and change control.',
    );
  }
  if (action.requiresApproval) reasons.push('Requires approval before it can be run.');
  return reasons;
}

export function evaluateEntry(
  entry: Entry,
  pack: CompiledPack,
  config: ActionValueConfig,
  state: KnowledgeState,
): EntryEval {
  const action = entry.action;
  if (!action) {
    return {
      exec: null,
      moot: false,
      outcome: null,
      value: null,
      availability: 'ready',
      blockedBy: [],
      unsafeReasons: [],
      manual: true,
    };
  }
  const exec = state.executed.get(action.id) ?? null;
  const moot =
    exec === null &&
    (action.produces.length > 0
      ? action.produces.every((r) => state.satisfied.has(r))
      : revealedOutcome(action, state.observedSignals) !== null);
  const outcome = exec
    ? (action.outcomes.find((o) => o.id === exec.outcomeId) ?? null)
    : moot
      ? revealedOutcome(action, state.observedSignals)
      : null;
  const unsafeReasons = unsafeReasonsOf(action, config);
  const blockedBy = action.requires
    .filter((r) => !state.satisfied.has(r))
    .map((r) => `Needs first: ${pack.requirements.get(r)?.label ?? r}`);
  const done = exec !== null || moot;
  const availability: StepAvailability = exec
    ? 'completed'
    : moot
      ? 'not_needed'
      : unsafeReasons.length > 0
        ? 'unavailable'
        : blockedBy.length > 0
          ? 'blocked'
          : 'ready';
  const value = done
    ? null
    : round(evaluateAction(pack, config, action, toRankingState(state)).score, 3);
  return { exec, moot, outcome, value, availability, blockedBy, unsafeReasons, manual: false };
}

/**
 * A step that already ran but whose result has not been seen yet, when that result decides what comes
 * next: a stop, escalate or success branch hangs on it, or it is a stage alternative whose every
 * outcome shows up as evidence. Plain information requests do not hold the path up.
 */
export function awaitsDecisiveResult(entry: Entry, ev: EntryEval): boolean {
  const action = entry.action;
  if (ev.exec === null || ev.outcome !== null || !action) return false;
  const everyOutcomeShowsUp =
    action.outcomes.length > 0 && action.outcomes.every((o) => o.emitsSignals.length > 0);
  const decides =
    entry.step === null ||
    entry.step.branches.some(
      (b) => b.next === 'stop' || b.next === 'escalate' || b.next === 'success',
    );
  return everyOutcomeShowsUp && decides;
}

function nextLabel(next: string, content: SkillContent): string {
  if (next === 'success')
    return 'Root cause isolated: hand over to remediation under change control';
  if (next === 'stop') return 'Stop and review manually';
  if (next === 'escalate') return 'Escalate with the evidence collected';
  const step = content.decisionSequence.find((s) => s.id === next);
  return step ? `Continue with stage ${step.order}: ${step.title}` : next;
}

export function expectedOutcomesOf(
  entry: Entry,
  content: SkillContent,
  pack: CompiledPack,
  state: KnowledgeState,
): PlanExpectedOutcome[] {
  if (entry.step) {
    return entry.step.branches.map((b) => ({
      outcomeId: b.outcomeId ?? '',
      label: b.condition,
      probability: b.probability ?? null,
      next: b.next,
      nextLabel: nextLabel(b.next, content),
      rationale: b.rationale,
    }));
  }
  if (!entry.action) return [];
  return predictOutcomes(pack, entry.action, state.belief).map((o) => ({
    outcomeId: o.id,
    label: o.label,
    probability: round(o.probability, 3),
    next: 'review',
    nextLabel: 'Interpret the result against the branches of the stage it belongs to',
    rationale: clip(o.simulatedResult, 400),
  }));
}

export function templatesFor(
  content: SkillContent,
  action: KnowledgeAction | null,
): PlanTemplate[] {
  if (!action) return [];
  const own: PlanTemplate[] = content.queryTemplates
    .filter((t) => isTemplateOf(t.id, action.id))
    .map((t) => ({ ...t, source: 'skill' }));
  const owned = new Set(own.map((t) => t.language));
  const fromPack: PlanTemplate[] = templatesOfAction(action)
    .filter((t) => !owned.has(t.language))
    .map((t) => ({ ...t, source: 'knowledge_pack' }));
  return [...own, ...fromPack];
}
