import {
  DEFAULT_EFFORT_MINUTES,
  type ActionValueConfig,
  type CounterfactualStrategy,
  type EffortLevel,
  type KnowledgeAction,
  type Range,
  type SkillContent,
} from '@caseguard/schemas';
import {
  outcomeDistributionFor,
  predictOutcomes,
  rankActions,
  type ActionEvaluation,
} from '../engine/action-value';
import { beliefToVector, topHypotheses } from '../engine/belief';
import { strategyProfile } from '../engine/counterfactual';
import { signalRequirementLinks } from '../engine/requirements';
import type { CompiledPack } from '../knowledge/compile';
import { rangeOf, round } from '../util/math';
import { createRng } from '../util/rng';
import { planFromState, type PlanStatus } from './plan';
import { advanceState, diagnosisStatus, toRankingState, type KnowledgeState } from './state';

export interface ReplayStep {
  stepId: string;
  stage: number;
  role: 'skill_step' | 'stage_alternative';
  actionKey: string;
  label: string;
  outcomeId: string;
  outcomeLabel: string;
  /** Probability of the chosen outcome under the oracle (recorded cause) or the decision-time belief. */
  outcomeProbability: number;
  simulated: true;
  timeMinutes: Range;
  customerEffort: EffortLevel;
  customerEffortMinutes: number;
  customerFacing: boolean;
  tokenEstimate: number;
  operationalRisk: number;
  safe: boolean;
}

export interface ReplayMetrics {
  timeToDiagnosisMinutes: Range;
  customerEffortMinutes: number;
  customerInteractions: number;
  actionCount: number;
  tokenEstimate: number;
  operationalRisk: number;
  unsafeSteps: number;
  /** Share of the skill's minimum-evidence requirements satisfied when the replay ends. */
  evidenceCompleteness: number;
}

export interface SkillReplayResult {
  steps: ReplayStep[];
  terminal: PlanStatus | 'exhausted' | 'no_step';
  reachedDiagnosis: boolean;
  leader: { key: string; confidence: number } | null;
  /** True when the replay ends confident in a cause other than the recorded one. */
  falseDiagnosis: boolean;
  metrics: ReplayMetrics;
  /** Where step outcomes came from: the recorded root cause (hindsight) or the decision-time belief. */
  oracle: 'recorded_resolution' | 'decision_time_modal';
  usedFinalResolution: boolean;
  notes: string[];
}

const isCustomerExecutor = (a: KnowledgeAction): boolean => a.executor.startsWith('customer');

export const isSafeAction = (a: KnowledgeAction, ceiling: number): boolean =>
  !a.destructive &&
  !a.requiresApproval &&
  a.valueClass !== 'remediation' &&
  a.operationalRisk < ceiling;

/** Same representative-path time model as the counterfactual engine (so figures stay comparable). */
export function stepTimeRange(a: KnowledgeAction): Range {
  const { min, typical, max } = a.timeMinutes;
  return {
    low: min + 0.25 * (typical - min),
    mid: typical,
    high: typical + 0.75 * (max - typical),
  };
}

const argmax = (values: readonly number[]): number => {
  let best = 0;
  values.forEach((v, i) => {
    if (v > (values[best] ?? -1)) best = i;
  });
  return best;
};

export function evidenceCompleteness(
  satisfied: ReadonlySet<string>,
  minimumEvidence: readonly string[],
): number {
  if (minimumEvidence.length === 0) return 1;
  return minimumEvidence.filter((r) => satisfied.has(r)).length / minimumEvidence.length;
}

/**
 * Replays a skill from a decision point. The skill chooses each next step from the plan logic using
 * only the starting evidence plus the outcomes of the steps it ran itself. Those outcomes come from an
 * oracle: the recorded root cause when known (hindsight, labelled), else the decision-time belief.
 */
export function replaySkillPath(input: {
  content: SkillContent;
  pack: CompiledPack;
  config: ActionValueConfig;
  state0: KnowledgeState;
  truthHypothesis: string | null;
  minimumEvidence: readonly string[];
  maxSteps?: number;
}): SkillReplayResult {
  const { content, pack, config, truthHypothesis, minimumEvidence } = input;
  const maxSteps = input.maxSteps ?? pack.pack.policies.maxCounterfactualSteps;
  let state = input.state0;
  const steps: ReplayStep[] = [];
  const notes: string[] = [];
  let core = planFromState({ content, pack, config, state });
  let terminal: SkillReplayResult['terminal'] = core.status;
  while (
    core.status === 'in_progress' &&
    steps.length < maxSteps &&
    !diagnosisStatus(pack, state).done
  ) {
    const next = core.nextSteps[0];
    const action = next?.actionKey ? pack.actions.get(next.actionKey) : undefined;
    if (!next || !action) {
      terminal = 'no_step';
      break;
    }
    const predicted = predictOutcomes(pack, action, state.belief);
    const distribution = truthHypothesis
      ? outcomeDistributionFor(pack, action, truthHypothesis)
      : predicted.map((o) => o.probability);
    const chosen = argmax(distribution);
    const outcome = action.outcomes[chosen];
    if (!outcome) {
      terminal = 'no_step';
      break;
    }
    steps.push({
      stepId: next.stepId,
      stage: next.stage,
      role: next.role,
      actionKey: action.id,
      label: action.label,
      outcomeId: outcome.id,
      outcomeLabel: outcome.label,
      outcomeProbability: round(distribution[chosen] ?? 0, 3),
      simulated: true,
      timeMinutes: stepTimeRange(action),
      customerEffort: action.customerEffort,
      customerEffortMinutes: DEFAULT_EFFORT_MINUTES[action.customerEffort],
      customerFacing: isCustomerExecutor(action),
      tokenEstimate: action.tokenEstimate,
      operationalRisk: action.operationalRisk,
      safe: isSafeAction(action, config.riskCeiling),
    });
    state = advanceState(pack, state, action, chosen);
    core = planFromState({ content, pack, config, state });
    terminal = core.status;
  }
  const diagnosis = diagnosisStatus(pack, state);
  if (terminal === 'in_progress') {
    terminal = diagnosis.done ? 'success' : steps.length >= maxSteps ? 'exhausted' : 'no_step';
  }
  if (core.status === 'success' && !diagnosis.done) {
    notes.push(
      'The skill reached its success branch but the confirmed-diagnosis criteria of the knowledge pack are not met.',
    );
  }
  const total = (pick: (s: ReplayStep) => number): number => steps.reduce((s, x) => s + pick(x), 0);
  return {
    steps,
    terminal,
    reachedDiagnosis: diagnosis.done,
    leader: { key: diagnosis.leader, confidence: round(diagnosis.confidence, 3) },
    falseDiagnosis:
      diagnosis.done && truthHypothesis !== null && diagnosis.leader !== truthHypothesis,
    metrics: {
      timeToDiagnosisMinutes: {
        low: round(
          total((s) => s.timeMinutes.low),
          1,
        ),
        mid: round(
          total((s) => s.timeMinutes.mid),
          1,
        ),
        high: round(
          total((s) => s.timeMinutes.high),
          1,
        ),
      },
      customerEffortMinutes: total((s) => s.customerEffortMinutes),
      customerInteractions: steps.filter((s) => s.customerFacing).length,
      actionCount: steps.length,
      tokenEstimate: total((s) => s.tokenEstimate),
      operationalRisk: steps.length === 0 ? 0 : Math.max(...steps.map((s) => s.operationalRisk)),
      unsafeSteps: steps.filter((s) => !s.safe).length,
      evidenceCompleteness: round(evidenceCompleteness(state.satisfied, minimumEvidence), 3),
    },
    oracle: truthHypothesis ? 'recorded_resolution' : 'decision_time_modal',
    usedFinalResolution: truthHypothesis !== null,
    notes,
  };
}

// ---------------------------------------------------------------------------------------------
// Baseline: the action-value policy without the skill

export interface BaselineMetrics {
  timeToDiagnosisMinutes: Range;
  customerEffortMinutes: Range;
  customerInteractions: Range;
  actionCount: Range;
  tokenEstimate: Range;
  evidenceCompleteness: Range;
}

export interface BaselineResult {
  strategy: CounterfactualStrategy;
  count: number;
  seed: string;
  diagnosisReachedShare: number;
  /** Share of rollouts that had every minimum-evidence requirement when they ended. */
  evidenceCompleteShare: number;
  metrics: BaselineMetrics;
  modalPath: string[];
  modalPathShare: number;
}

interface PolicyNode {
  state: KnowledgeState;
  evaluation: ActionEvaluation | null;
  diagnosed: boolean;
  depth: number;
  children: Map<number, PolicyNode>;
}

/**
 * Seeded Monte-Carlo rollouts of the knowledge-pack action-value policy (the engine's counterfactual
 * policy) from a decision moment, with the true cause sampled from the decision-time belief. It is the
 * "without the skill" reference: everything it knows was available at the starting moment.
 */
export function simulateBaselinePolicy(input: {
  state0: KnowledgeState;
  pack: CompiledPack;
  config: ActionValueConfig;
  strategy: CounterfactualStrategy;
  seed: string;
  rolloutCount: number;
  maxSteps?: number;
  minimumEvidence: readonly string[];
}): BaselineResult {
  const { state0, pack, config, strategy, seed, rolloutCount, minimumEvidence } = input;
  const maxSteps = input.maxSteps ?? pack.pack.policies.maxCounterfactualSteps;
  const profile = strategyProfile(strategy, config);
  const links = signalRequirementLinks(pack);
  const threshold = pack.pack.policies.diagnosisThreshold;

  const canSatisfy = (action: KnowledgeAction, unmet: readonly string[]): boolean =>
    action.produces.some((r) => unmet.includes(r)) ||
    action.outcomes.some((o) =>
      o.emitsSignals.some((s) => [...(links.get(s) ?? [])].some((r) => unmet.includes(r))),
    );
  const choose = (state: KnowledgeState, unmet: readonly string[]): ActionEvaluation | null => {
    const ranked = rankActions(pack, config, toRankingState(state), {
      weights: profile.weights,
      filter: (a) => !state.executed.has(a.id) && (profile.filter ? profile.filter(a) : true),
    }).candidates;
    const top = topHypotheses(state.belief, 1)[0];
    if (unmet.length > 0 && (top?.p ?? 0) >= threshold) {
      const validating = ranked.find((e) => canSatisfy(e.action, unmet));
      if (validating) return validating;
    }
    return ranked[0] ?? null;
  };
  const makeNode = (state: KnowledgeState, depth: number): PolicyNode => {
    const status = diagnosisStatus(pack, state);
    return {
      state,
      evaluation: status.done || depth >= maxSteps ? null : choose(state, status.unmet),
      diagnosed: status.done,
      depth,
      children: new Map(),
    };
  };
  const child = (node: PolicyNode, outcomeIndex: number): PolicyNode => {
    const cached = node.children.get(outcomeIndex);
    if (cached) return cached;
    const action = node.evaluation?.action;
    if (!action) throw new Error('Cannot advance a terminal policy node');
    const next = makeNode(advanceState(pack, node.state, action, outcomeIndex), node.depth + 1);
    node.children.set(outcomeIndex, next);
    return next;
  };

  const root = makeNode(state0, 0);
  const rng = createRng(`${seed}|baseline|${strategy}`);
  const rootVector = beliefToVector(pack, state0.belief);
  const samples = {
    time: [] as number[],
    effort: [] as number[],
    interactions: [] as number[],
    actions: [] as number[],
    tokens: [] as number[],
    completeness: [] as number[],
  };
  const pathCounts = new Map<string, number>();
  let reached = 0;
  let complete = 0;
  for (let r = 0; r < rolloutCount; r++) {
    const truth = pack.hypothesisIds[rng.weighted(rootVector)] ?? 'hyp.other';
    let node = root;
    let elapsed = 0;
    let effort = 0;
    let interactions = 0;
    let tokens = 0;
    const keys: string[] = [];
    while (node.evaluation && !node.diagnosed) {
      const action = node.evaluation.action;
      const outcomeIndex = rng.weighted(outcomeDistributionFor(pack, action, truth));
      elapsed += rng.triangular(
        action.timeMinutes.min,
        action.timeMinutes.typical,
        action.timeMinutes.max,
      );
      effort += DEFAULT_EFFORT_MINUTES[action.customerEffort];
      interactions += isCustomerExecutor(action) ? 1 : 0;
      tokens += action.tokenEstimate;
      keys.push(action.id);
      node = child(node, outcomeIndex);
    }
    if (node.diagnosed) reached += 1;
    const completeness = evidenceCompleteness(node.state.satisfied, minimumEvidence);
    if (completeness >= 1) complete += 1;
    const path = keys.join('>');
    pathCounts.set(path, (pathCounts.get(path) ?? 0) + 1);
    samples.time.push(elapsed);
    samples.effort.push(effort);
    samples.interactions.push(interactions);
    samples.actions.push(keys.length);
    samples.tokens.push(tokens);
    samples.completeness.push(completeness);
  }
  const rounded = (values: number[], digits: number): Range => {
    const r = rangeOf(values);
    return { low: round(r.low, digits), mid: round(r.mid, digits), high: round(r.high, digits) };
  };
  const [modal, modalCount] = [...pathCounts.entries()].sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
  )[0] ?? ['', 0];
  return {
    strategy,
    count: rolloutCount,
    seed: `${seed}|baseline|${strategy}`,
    diagnosisReachedShare: round(rolloutCount === 0 ? 0 : reached / rolloutCount, 3),
    evidenceCompleteShare: round(rolloutCount === 0 ? 0 : complete / rolloutCount, 3),
    metrics: {
      timeToDiagnosisMinutes: rounded(samples.time, 1),
      customerEffortMinutes: rounded(samples.effort, 1),
      customerInteractions: rounded(samples.interactions, 2),
      actionCount: rounded(samples.actions, 2),
      tokenEstimate: rounded(samples.tokens, 0),
      evidenceCompleteness: rounded(samples.completeness, 3),
    },
    modalPath: modal === '' ? [] : modal.split('>'),
    modalPathShare: round(rolloutCount === 0 ? 0 : modalCount / rolloutCount, 3),
  };
}
