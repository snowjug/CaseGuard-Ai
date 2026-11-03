import {
  DEFAULT_EFFORT_MINUTES,
  STRATEGY_LABELS,
  type ActionValueConfig,
  type CaseEvent,
  type CounterfactualScenario,
  type CounterfactualStep,
  type CounterfactualStrategy,
  type DecisionFork,
  type EligibilityCheck,
  type Evidence,
  type KnowledgeAction,
  type Level,
  type PathMetrics,
  type Range,
  type StepFeasibility,
} from '@caseguard/schemas';
import type { CompiledPack } from '../knowledge/compile';
import { hypothesisRecordId, stableId } from '../util/ids';
import { clamp, entropyBits, mean, rangeOf, round } from '../util/math';
import { createRng } from '../util/rng';
import { addMinutes, compareIso, formatDuration, formatUtcStamp } from '../util/time';
import {
  type ActionEvaluation,
  applyOutcome,
  outcomeDistributionFor,
  type OutcomeProbability,
  predictOutcomes,
  type RankingState,
  rankActions,
  type RankOptions,
} from './action-value';
import { type Belief, beliefToVector, informationGain, topHypotheses } from './belief';
import { type EngineContext, metaOf } from './context';
import { assessScenarioQuality, stepFeasibility } from './counterfactual-quality';
import { scanForLeaks } from './leak-check';
import { signalRequirementLinks } from './requirements';
import { analyzeView } from './state';
import {
  assertPreResolution,
  createTemporalViewBeforeEvent,
  type PreResolutionView,
} from './temporal';

/** Realized information (bits) at which a step counts as having produced "useful evidence". */
export const USEFUL_EVIDENCE_BITS = 0.25;

export const COUNTERFACTUAL_ASSUMPTIONS: readonly string[] = [
  'Outcome probabilities come from knowledge-pack likelihoods, not from the real environment.',
  'Customer-executed steps complete within the knowledge-pack time estimates (response prior applies).',
  'Only actions defined in the knowledge pack are considered; nothing is executed.',
  'Every value shown is a simulated estimate, labelled as such wherever it appears.',
];

export interface StrategyProfile {
  label: string;
  description: string;
  weights: Partial<ActionValueConfig['weights']>;
  filter: ((action: KnowledgeAction) => boolean) | null;
}

export function strategyProfile(
  strategy: CounterfactualStrategy,
  config: ActionValueConfig,
): StrategyProfile {
  switch (strategy) {
    case 'balanced':
      return {
        label: STRATEGY_LABELS.balanced,
        description: 'Ranks next steps with the configured cost weights.',
        weights: {},
        filter: null,
      };
    case 'lowest_customer_effort':
      return {
        label: STRATEGY_LABELS.lowest_customer_effort,
        description: 'Weights customer effort most heavily and excludes high-effort requests.',
        weights: { customer: 0.6, time: 0.15, token: 0.05, risk: 0.2 },
        filter: (a) => config.effortScale[a.customerEffort] <= config.effortScale.medium,
      };
    case 'fastest_diagnosis':
      return {
        label: STRATEGY_LABELS.fastest_diagnosis,
        description: 'Weights elapsed time most heavily to reach a diagnosis quickly.',
        weights: { time: 0.6, customer: 0.1, token: 0.05, risk: 0.25 },
        filter: null,
      };
  }
}

// ---------------------------------------------------------------------------------------------
// Policy tree: the state after a sequence of (action, outcome) pairs is fully determined, so every
// node is computed once and shared by all rollouts.

interface PolicyNode {
  key: string;
  depth: number;
  state: RankingState;
  executed: ReadonlySet<string>;
  evaluation: ActionEvaluation | null;
  diagnosed: boolean;
  leader: string;
  gainFromParent: number;
  children: Map<number, PolicyNode>;
}

class PolicyTree {
  private readonly links: Map<string, Set<string>>;
  readonly root: PolicyNode;

  constructor(
    private readonly pack: CompiledPack,
    private readonly config: ActionValueConfig,
    private readonly profile: StrategyProfile,
    private readonly maxSteps: number,
    rootState: RankingState,
  ) {
    this.links = signalRequirementLinks(pack);
    this.root = this.makeNode('root', 0, rootState, new Set(), 0);
  }

  diagnosisStatus(state: RankingState): { done: boolean; leader: string; unmet: string[] } {
    const top = topHypotheses(state.belief, 1)[0];
    const leader = top?.id ?? 'hyp.other';
    const required = this.pack.hypotheses.get(leader)?.confirmationRequirementIds ?? [];
    const unmet = required.filter((r) => !state.satisfied.has(r));
    const confident =
      (top?.p ?? 0) >= this.pack.pack.policies.diagnosisThreshold && leader !== 'hyp.other';
    return { done: confident && unmet.length === 0, leader, unmet };
  }

  private canSatisfy(action: KnowledgeAction, unmet: readonly string[]): boolean {
    if (action.produces.some((r) => unmet.includes(r))) return true;
    return action.outcomes.some((o) =>
      o.emitsSignals.some((s) => [...(this.links.get(s) ?? [])].some((r) => unmet.includes(r))),
    );
  }

  private choose(
    state: RankingState,
    executed: ReadonlySet<string>,
    unmet: readonly string[],
  ): ActionEvaluation | null {
    const options: RankOptions = {
      weights: this.profile.weights,
      filter: (a) => !executed.has(a.id) && (this.profile.filter ? this.profile.filter(a) : true),
    };
    const ranked = rankActions(this.pack, this.config, state, options).candidates;
    const top = topHypotheses(state.belief, 1)[0];
    if (unmet.length > 0 && (top?.p ?? 0) >= this.pack.pack.policies.diagnosisThreshold) {
      const validating = ranked.find((e) => this.canSatisfy(e.action, unmet));
      if (validating) return validating;
    }
    return ranked[0] ?? null;
  }

  private makeNode(
    key: string,
    depth: number,
    state: RankingState,
    executed: ReadonlySet<string>,
    gainFromParent: number,
  ): PolicyNode {
    const status = this.diagnosisStatus(state);
    const evaluation =
      status.done || depth >= this.maxSteps ? null : this.choose(state, executed, status.unmet);
    return {
      key,
      depth,
      state,
      executed,
      evaluation,
      diagnosed: status.done,
      leader: status.leader,
      gainFromParent,
      children: new Map(),
    };
  }

  child(node: PolicyNode, outcomeIndex: number): PolicyNode {
    const cached = node.children.get(outcomeIndex);
    if (cached) return cached;
    const action = node.evaluation?.action;
    if (!action) throw new Error('Cannot advance a terminal policy node');
    const belief = applyOutcome(this.pack, action, outcomeIndex, node.state.belief);
    const emitted = action.outcomes[outcomeIndex]?.emitsSignals ?? [];
    const observed = new Set([...node.state.observedSignals, ...emitted]);
    const satisfied = new Set([...node.state.satisfied, ...action.produces]);
    for (const s of emitted) for (const r of this.links.get(s) ?? []) satisfied.add(r);
    const executed = new Set([...node.executed, action.id]);
    const next = this.makeNode(
      `${node.key}>${action.id}:${outcomeIndex}`,
      node.depth + 1,
      { belief, observedSignals: observed, satisfied },
      executed,
      informationGain(this.pack, node.state.belief, belief),
    );
    node.children.set(outcomeIndex, next);
    return next;
  }
}

// ---------------------------------------------------------------------------------------------
// Simulation

export interface SimulatedStep {
  index: number;
  action: KnowledgeAction;
  evaluation: ActionEvaluation;
  beliefBefore: Belief;
  beliefAfter: Belief;
  outcome: OutcomeProbability;
  alternatives: OutcomeProbability[];
  realizedGainBits: number;
  offset: { low: number; mid: number; high: number };
  prior: string[];
}

export interface BranchNote {
  afterStepIndex: number;
  condition: string;
  thenAction: string;
  probability: number;
}

export interface RolloutSummary {
  count: number;
  seed: string;
  metrics: PathMetrics;
  diagnosisReachedShare: number;
  modalPathShare: number;
  modalPathKey: string;
  /** Mean final posterior per hypothesis across rollouts. */
  meanFinalBelief: Record<string, number>;
  /** Share of rollouts whose final leading hypothesis was each key. */
  finalLeaderShare: Record<string, number>;
  samples: {
    actionCount: number[];
    customerInteractions: number[];
    timeToUseful: number[];
    timeToDiagnosis: number[];
    volume: number[];
    tokens: number[];
    customerMinutes: number[];
    info: number[];
  };
}

export interface SimulationResult {
  strategy: CounterfactualStrategy;
  steps: SimulatedStep[];
  branchNotes: BranchNote[];
  reachedDiagnosis: boolean;
  finalBelief: Belief;
  rollouts: RolloutSummary;
  initialBelief: Belief;
  /** Pack actions the path used; every one is, by construction, defined in the knowledge pack. */
  supported: true;
}

export interface SimulateInput {
  preView: PreResolutionView;
  fork: DecisionFork;
  strategy: CounterfactualStrategy;
  pack: CompiledPack;
  config: ActionValueConfig;
  ctx: EngineContext;
  rolloutCount?: number;
  /** Used by hindsight-conditioned skill extraction only; scenario generation never sets this. */
  conditionOnHypothesis?: string;
}

const pct = (p: number): string => `${Math.round(p * 100)}%`;
const isCustomerExecutor = (a: KnowledgeAction): boolean => a.executor.startsWith('customer');

/** Simulates alternative futures from the decision instant using ONLY the pre-resolution view. */
export function simulateAlternativePath(input: SimulateInput): SimulationResult {
  const { preView, pack, config, strategy, fork, ctx } = input;
  assertPreResolution(preView);
  const policies = pack.pack.policies;
  const profile = strategyProfile(strategy, config);
  const analysis = analyzeView(preView, pack, ctx.caseId);
  const tree = new PolicyTree(
    pack,
    config,
    profile,
    policies.maxCounterfactualSteps,
    analysis.rankingState,
  );
  const root = tree.root;
  const initialBelief = root.state.belief;

  // Monte-Carlo rollouts: the source of every metric range and of the representative path.
  const count = input.rolloutCount ?? policies.rolloutCount;
  // The stream is named by where the decision sits in the case (events before it, its instant) and
  // never by the fork id, which derives from the generated case id: the same case content must draw
  // the same numbers in any database.
  const decision = `fork:${preView.events.length}@${fork.timestamp}`;
  const seed = `${ctx.seed}|${decision}|${strategy}${input.conditionOnHypothesis ? `|truth:${input.conditionOnHypothesis}` : ''}`;
  const rng = createRng(seed);
  const rootVector = beliefToVector(pack, initialBelief);
  const samples: RolloutSummary['samples'] = {
    actionCount: [],
    customerInteractions: [],
    timeToUseful: [],
    timeToDiagnosis: [],
    volume: [],
    tokens: [],
    customerMinutes: [],
    info: [],
  };
  let reached = 0;
  const pathCounts = new Map<string, number>();
  const visits = new Map<string, number[]>();
  const finalBeliefSum: Record<string, number> = Object.fromEntries(
    pack.hypothesisIds.map((h) => [h, 0]),
  );
  const finalLeaders: Record<string, number> = {};
  for (let r = 0; r < count; r++) {
    const trueIdx = input.conditionOnHypothesis
      ? Math.max(0, pack.hypothesisIds.indexOf(input.conditionOnHypothesis))
      : rng.weighted(rootVector);
    const trueHyp = pack.hypothesisIds[trueIdx] ?? 'hyp.other';
    let current = root;
    let elapsed = 0;
    let useful: number | null = null;
    let diagnosedAt: number | null = root.diagnosed ? 0 : null;
    let interactions = 0;
    let volume = 0;
    let tokens = 0;
    let customerMinutes = 0;
    let info = 0;
    const keys: string[] = [];
    while (current.evaluation && diagnosedAt === null) {
      const action = current.evaluation.action;
      const dist = outcomeDistributionFor(pack, action, trueHyp);
      const outcomeIndex = rng.weighted(dist);
      const seen = visits.get(current.key) ?? new Array<number>(action.outcomes.length).fill(0);
      seen[outcomeIndex] = (seen[outcomeIndex] ?? 0) + 1;
      visits.set(current.key, seen);
      elapsed += rng.triangular(
        action.timeMinutes.min,
        action.timeMinutes.typical,
        action.timeMinutes.max,
      );
      interactions += isCustomerExecutor(action) ? 1 : 0;
      volume += action.computeUnits;
      tokens += action.tokenEstimate;
      customerMinutes += DEFAULT_EFFORT_MINUTES[action.customerEffort];
      keys.push(action.id);
      current = tree.child(current, outcomeIndex);
      info += current.gainFromParent;
      if (useful === null && current.gainFromParent >= USEFUL_EVIDENCE_BITS) useful = elapsed;
      if (current.diagnosed) diagnosedAt = elapsed;
    }
    if (diagnosedAt !== null) reached++;
    const key = keys.join('>');
    pathCounts.set(key, (pathCounts.get(key) ?? 0) + 1);
    for (const h of pack.hypothesisIds)
      finalBeliefSum[h] = (finalBeliefSum[h] ?? 0) + (current.state.belief[h] ?? 0);
    finalLeaders[current.leader] = (finalLeaders[current.leader] ?? 0) + 1;
    samples.actionCount.push(keys.length);
    samples.customerInteractions.push(interactions);
    samples.timeToDiagnosis.push(diagnosedAt ?? elapsed);
    samples.timeToUseful.push(useful ?? diagnosedAt ?? elapsed);
    samples.volume.push(volume);
    samples.tokens.push(tokens);
    samples.customerMinutes.push(customerMinutes);
    samples.info.push(info);
  }

  // Representative path: at each node follow the outcome most often seen across the rollouts, so the
  // displayed path is a coherent realisation (one underlying cause) rather than a step-wise average.
  const steps: SimulatedStep[] = [];
  const branchNotes: BranchNote[] = [];
  let node = root;
  let low = 0;
  let mid = 0;
  let high = 0;
  while (node.evaluation) {
    const action = node.evaluation.action;
    const predicted = predictOutcomes(pack, action, node.state.belief);
    const seen = visits.get(node.key);
    const total = seen ? seen.reduce((s, x) => s + x, 0) : 0;
    const share = (i: number): number =>
      total > 0 ? (seen?.[i] ?? 0) / total : (predicted[i]?.probability ?? 0);
    const order = predicted
      .map((o, i) => ({ o: { ...o, probability: share(i) }, i }))
      .sort((a, b) => b.o.probability - a.o.probability || a.i - b.i);
    const chosen = order[0];
    if (!chosen) break;
    const next = tree.child(node, chosen.i);
    low += action.timeMinutes.min + 0.25 * (action.timeMinutes.typical - action.timeMinutes.min);
    mid += action.timeMinutes.typical;
    high +=
      action.timeMinutes.typical + 0.75 * (action.timeMinutes.max - action.timeMinutes.typical);
    steps.push({
      index: steps.length,
      action,
      evaluation: node.evaluation,
      beliefBefore: node.state.belief,
      beliefAfter: next.state.belief,
      outcome: chosen.o,
      alternatives: order.slice(1, 5).map((x) => x.o),
      realizedGainBits: next.gainFromParent,
      offset: { low, mid, high },
      prior: steps.slice(-2).map((s) => s.action.id),
    });
    const second = order[1];
    if (
      chosen.o.probability < 0.85 &&
      second &&
      second.o.probability >= 0.1 &&
      branchNotes.length < 4
    ) {
      const alt = tree.child(node, second.i);
      branchNotes.push({
        afterStepIndex: steps.length - 1,
        condition: `If the result is “${second.o.label}” (${pct(second.o.probability)}) instead of “${chosen.o.label}”`,
        thenAction: alt.evaluation
          ? `Next: ${alt.evaluation.action.label}`
          : alt.diagnosed
            ? 'Diagnosis would already be established'
            : 'No further supported step; review manually',
        probability: round(second.o.probability, 3),
      });
    }
    node = next;
  }
  const reachedDiagnosis = node.diagnosed;
  const mapKey = steps.map((s) => s.action.id).join('>');
  const maxRisk = steps.length === 0 ? 0 : Math.max(...steps.map((s) => s.action.operationalRisk));
  const modalPathShare = count === 0 ? 0 : (pathCounts.get(mapKey) ?? 0) / count;
  const metrics: PathMetrics = {
    actionCount: rangeOf(samples.actionCount),
    customerInteractions: rangeOf(samples.customerInteractions),
    timeToUsefulEvidenceMinutes: rangeOf(samples.timeToUseful),
    timeToDiagnosisMinutes: rangeOf(samples.timeToDiagnosis),
    diagnosticVolume: rangeOf(samples.volume),
    tokenEstimate: rangeOf(samples.tokens),
    customerEffortMinutes: rangeOf(samples.customerMinutes),
    operationalRisk: round(maxRisk, 3),
    informationGainBits: rangeOf(samples.info),
    unsupportedBranches: 0,
  };
  return {
    strategy,
    steps,
    branchNotes,
    reachedDiagnosis,
    finalBelief: node.state.belief,
    rollouts: {
      count,
      seed,
      metrics,
      diagnosisReachedShare: count === 0 ? 0 : round(reached / count, 3),
      modalPathShare: round(modalPathShare, 3),
      modalPathKey: mapKey,
      meanFinalBelief: Object.fromEntries(
        pack.hypothesisIds.map((h) => [h, count === 0 ? 0 : (finalBeliefSum[h] ?? 0) / count]),
      ),
      finalLeaderShare: Object.fromEntries(
        Object.entries(finalLeaders).map(([h, n]) => [h, count === 0 ? 0 : n / count]),
      ),
      samples,
    },
    initialBelief,
    supported: true,
  };
}

// ---------------------------------------------------------------------------------------------
// Leak check (implemented in ./leak-check; re-exported here for the public API)

export { futureOnlyTokens, packStaticTokens, scanForLeaks } from './leak-check';

// ---------------------------------------------------------------------------------------------
// Assembly

export interface AssembleInput {
  sim: SimulationResult;
  preView: PreResolutionView;
  fork: DecisionFork;
  pack: CompiledPack;
  config: ActionValueConfig;
  ctx: EngineContext;
  evidence: readonly Evidence[];
  actualMetrics: PathMetrics;
  futureTokens: ReadonlySet<string>;
}

const SIGNED_METRICS: { key: string; get: (m: PathMetrics) => number; lowerIsBetter: boolean }[] = [
  { key: 'actionCount', get: (m) => m.actionCount.mid, lowerIsBetter: true },
  { key: 'customerInteractions', get: (m) => m.customerInteractions.mid, lowerIsBetter: true },
  {
    key: 'timeToUsefulEvidenceMinutes',
    get: (m) => m.timeToUsefulEvidenceMinutes.mid,
    lowerIsBetter: true,
  },
  { key: 'timeToDiagnosisMinutes', get: (m) => m.timeToDiagnosisMinutes.mid, lowerIsBetter: true },
  { key: 'diagnosticVolume', get: (m) => m.diagnosticVolume.mid, lowerIsBetter: true },
  { key: 'tokenEstimate', get: (m) => m.tokenEstimate.mid, lowerIsBetter: true },
  { key: 'customerEffortMinutes', get: (m) => m.customerEffortMinutes.mid, lowerIsBetter: true },
  { key: 'operationalRisk', get: (m) => m.operationalRisk, lowerIsBetter: true },
  { key: 'informationGainBits', get: (m) => m.informationGainBits.mid, lowerIsBetter: false },
];

export function computeImprovements(
  actual: PathMetrics,
  counterfactual: PathMetrics,
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const metric of SIGNED_METRICS) {
    const a = metric.get(actual);
    const c = metric.get(counterfactual);
    const delta = metric.lowerIsBetter ? a - c : c - a;
    out[metric.key] = round(delta, 3);
    out[`${metric.key}Pct`] = a > 0 ? round(delta / a, 3) : null;
  }
  return out;
}

const uncertaintyOf = (p: number): Level => (p >= 0.75 ? 'low' : p >= 0.5 ? 'medium' : 'high');

/** What a scenario's summary reads: the decision instant and the simulated path, nothing else. */
export interface ScenarioSummarySource {
  readonly label: string;
  readonly boundary: { readonly asOf: string };
  readonly steps: readonly { readonly label: string }[];
  readonly counterfactualMetrics: { readonly timeToDiagnosisMinutes: Range };
  readonly rollouts: { readonly diagnosisReachedShare: number };
}

/**
 * One-sentence summary of a scenario, written ONLY from the pre-decision view (the boundary
 * instant) and the simulated path. Comparing it with the real outcome is hindsight and belongs to the
 * `HindsightCheck`, so this text is safe wherever a view is bounded by `asOf`. It is a pure function
 * of stored scenario fields, so any renderer can rebuild exactly what generation stored.
 */
export function decisionTimeSummary(scenario: ScenarioSummarySource): string {
  const from = formatUtcStamp(scenario.boundary.asOf);
  const count = scenario.steps.length;
  if (count === 0) return `No supported next step could be ranked from ${from}.`;
  const names = scenario.steps.slice(0, 3).map((step) => step.label);
  const time = scenario.counterfactualMetrics.timeToDiagnosisMinutes;
  // The time shown is the median rollout, which reached a diagnosis exactly when most rollouts did.
  const verb = scenario.rollouts.diagnosisReachedShare >= 0.5 ? 'reach' : 'approach';
  return (
    `From ${from}, the “${scenario.label}” strategy would take ${count} step${count === 1 ? '' : 's'} ` +
    `(${names.join(' → ')}${count > 3 ? ' → …' : ''}) and is simulated to ${verb} a diagnosis in about ` +
    `${formatDuration(time.mid)} (range ${formatDuration(time.low)}–${formatDuration(time.high)}). ` +
    'Simulated estimate, not a measurement.'
  );
}

export function assembleScenario(input: AssembleInput): CounterfactualScenario {
  const { sim, preView, fork, pack, config, ctx, evidence, actualMetrics } = input;
  const scenarioId = stableId('scn', ctx.caseId, fork.id, sim.strategy);
  const profile = strategyProfile(sim.strategy, config);
  const visibleIds = new Set(preView.events.map((e) => e.id));
  const evidenceBefore = evidence.filter((e) => visibleIds.has(e.eventId));
  const evidenceIds = new Set(evidenceBefore.map((e) => e.id));
  const hypName = (id: string): string => pack.hypotheses.get(id)?.name ?? id;
  const initialSatisfied = analyzeView(preView, pack, ctx.caseId).rankingState.satisfied;
  const links = signalRequirementLinks(pack);

  /** Evidence available at the boundary whose signal discriminates in favour of one of the targets. */
  const supportFor = (targets: readonly string[]): string[] => {
    const scored = evidenceBefore
      .map((e) => {
        const signal = pack.signals.get(e.signalId);
        if (!signal) return { id: e.id, score: 0 };
        let best = 0;
        for (const t of targets) {
          const own = signal.likelihoods[t] ?? signal.neutral;
          const others = pack.hypothesisIds
            .filter((h) => h !== t)
            .map((h) => signal.likelihoods[h] ?? signal.neutral);
          const otherMean = mean(others);
          best = Math.max(best, Math.log2(own / Math.max(otherMean, 0.01)));
        }
        return { id: e.id, score: best };
      })
      .filter((x) => x.score >= 0.3)
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, 3).map((x) => x.id);
  };

  /** Whether each step could have been taken then: what held at the boundary and what an earlier step produces. */
  const producedEarlier = new Map<string, string>();
  const feasibility: StepFeasibility[] = sim.steps.map((s) => {
    const result = stepFeasibility(s.action, {
      riskCeiling: config.riskCeiling,
      availableAtBoundary: initialSatisfied,
      producedEarlier,
      requirementLabel: (requirementId) =>
        pack.requirements.get(requirementId)?.label ?? requirementId,
    });
    const produced = [
      ...s.action.produces,
      ...s.outcome.emitsSignals.flatMap((signal) => [...(links.get(signal) ?? [])]),
    ];
    for (const requirementId of produced) {
      if (!initialSatisfied.has(requirementId) && !producedEarlier.has(requirementId)) {
        producedEarlier.set(requirementId, s.action.label);
      }
    }
    return result;
  });

  const steps: CounterfactualStep[] = sim.steps.map((s, position) => {
    const targets = s.action.targets;
    const id = stableId('cfs', scenarioId, s.index);
    const leaderBefore = topHypotheses(s.beliefBefore, 1)[0];
    const rationale = [
      `Rank 1 under “${profile.label}” at this point.`,
      `Expected information ${round(s.evaluation.eigBits, 2)} bits for about ${s.action.timeMinutes.typical} minutes at ${s.action.customerEffort.replace('_', ' ')} customer effort.`,
      targets.length > 0
        ? `Tests ${targets
            .slice(0, 2)
            .map((t) => `“${hypName(t)}” (${pct(s.beliefBefore[t] ?? 0)})`)
            .join(' and ')}.`
        : leaderBefore
          ? `Prepares the next test while “${hypName(leaderBefore.id)}” leads at ${pct(leaderBefore.p)}.`
          : '',
      s.evaluation.enabledActionId
        ? `Chosen mainly because it unlocks “${pack.actions.get(s.evaluation.enabledActionId)?.label ?? s.evaluation.enabledActionId}”.`
        : '',
    ]
      .filter(Boolean)
      .join(' ')
      .slice(0, 880);
    return {
      id,
      scenarioId,
      index: s.index,
      offsetMinutes: {
        low: round(s.offset.low, 1),
        mid: round(s.offset.mid, 1),
        high: round(s.offset.high, 1),
      },
      simulatedAt: addMinutes(fork.timestamp, s.offset.mid),
      actionKey: s.action.id,
      label: s.action.label,
      kind: s.action.kind,
      executor: s.action.executor,
      rationale,
      evidenceUsedIds: supportFor(targets),
      priorStepIds: s.prior.map((_, i) =>
        stableId('cfs', scenarioId, Math.max(0, s.index - (s.prior.length - i))),
      ),
      predictedOutcome: {
        outcomeId: s.outcome.id,
        label: s.outcome.label,
        probability: round(s.outcome.probability, 3),
        simulatedResult: s.outcome.simulatedResult,
        alternatives: s.alternatives.map((a) => ({
          outcomeId: a.id,
          label: a.label,
          probability: round(a.probability, 3),
        })),
      },
      expectedInformationGainBits: round(s.evaluation.eigBits, 3),
      posteriorAfter: topHypotheses(s.beliefAfter, 5).map((t) => ({
        hypothesisId: hypothesisRecordId(ctx.caseId, t.id),
        key: t.id,
        name: hypName(t.id),
        confidence: round(t.p, 3),
      })),
      customerEffort: s.action.customerEffort,
      operationalRisk: s.action.operationalRisk,
      tokenEstimate: s.action.tokenEstimate,
      safe: !s.action.destructive && s.action.operationalRisk < config.riskCeiling,
      safetyNotes: [
        s.action.safetyNotes ??
          (s.action.operationalRisk === 0 ? 'Read-only step.' : 'Review before running.'),
      ],
      assumptions: [
        isCustomerExecutor(s.action)
          ? `The customer completes this within the typical ${s.action.timeMinutes.typical}-minute response time (range ${s.action.timeMinutes.min}–${s.action.timeMinutes.max}).`
          : 'The engineer can run this immediately with existing access.',
        'The predicted outcome is simulated from knowledge-pack likelihoods.',
      ],
      supported: true,
      unsupportedReasons: [],
      uncertainty: uncertaintyOf(s.outcome.probability),
      feasibility: feasibility[position] ?? { level: 'feasible', conditions: [] },
      simulated: true,
    };
  });

  const metrics = sim.rollouts.metrics;
  const improvements = computeImprovements(actualMetrics, metrics);

  const scenarioTexts = [
    ...steps.flatMap((s) => [
      s.label,
      s.rationale,
      s.predictedOutcome.simulatedResult,
      ...s.assumptions,
      ...s.safetyNotes,
    ]),
    ...sim.branchNotes.flatMap((b) => [b.condition, b.thenAction]),
  ];
  const leakedTokens = scanForLeaks(scenarioTexts, input.futureTokens);
  const futureEvidenceRefs = steps
    .flatMap((s) => s.evidenceUsedIds)
    .filter((id) => !evidenceIds.has(id));
  const futureReferences = leakedTokens.length + futureEvidenceRefs.length;
  const leakDetails = [
    `${preView.events.length} events inside the boundary; ${preView.withheldFutureEventCount} later events withheld.`,
    leakedTokens.length === 0
      ? 'No identifier that first appears after the boundary was used.'
      : `Leaked identifiers: ${leakedTokens.join(', ')}.`,
    futureEvidenceRefs.length === 0
      ? 'All cited evidence was observed before the boundary.'
      : 'Some cited evidence was observed after the boundary.',
  ];

  const satisfied = new Set(initialSatisfied);
  let unmetRequirement: SimulatedStep | undefined;
  for (const s of sim.steps) {
    if (!unmetRequirement && s.action.requires.some((r) => !satisfied.has(r))) unmetRequirement = s;
    for (const r of s.action.produces) satisfied.add(r);
    for (const sig of s.outcome.emitsSignals)
      for (const r of links.get(sig) ?? []) satisfied.add(r);
  }
  const checks: EligibilityCheck[] = [
    {
      id: 'boundary-respected',
      passed:
        futureEvidenceRefs.length === 0 &&
        preView.events.every((e) => compareIso(e.timestamp, fork.timestamp) <= 0),
      detail: 'Generation used only events recorded before the decision instant.',
    },
    {
      id: 'resolution-excluded',
      passed: preView.resolution === null,
      detail: 'The final resolution and root cause were not available to generation.',
    },
    {
      id: 'no-future-identifiers',
      passed: leakedTokens.length === 0,
      detail:
        leakedTokens.length === 0
          ? 'No identifier that appears only later in the case was used.'
          : `Used: ${leakedTokens.join(', ')}.`,
    },
    {
      id: 'steps-safe',
      passed: steps.every((s) => s.safe),
      detail: 'No step is destructive or at or above the risk ceiling.',
    },
    {
      id: 'steps-supported',
      passed: steps.every((s) => s.supported),
      detail: 'Every step is an action defined in the knowledge pack.',
    },
    {
      id: 'requirements-respected',
      passed: unmetRequirement === undefined,
      detail: unmetRequirement
        ? `Step “${unmetRequirement.action.label}” starts before its prerequisites exist.`
        : 'Every step starts only after its prerequisites exist.',
    },
    {
      id: 'labelled-simulated',
      passed: steps.every((s) => s.simulated),
      detail: 'Every step and outcome is labelled as simulated.',
    },
    {
      id: 'reproducible',
      passed: sim.rollouts.seed.length > 0,
      detail: `Seed ${sim.rollouts.seed} with ${sim.rollouts.count} rollouts reproduces these numbers.`,
    },
  ];
  const valid = checks.every((c) => c.passed);

  const cfT = metrics.timeToDiagnosisMinutes.mid;
  const spread =
    cfT > 0 ? (metrics.timeToDiagnosisMinutes.high - metrics.timeToDiagnosisMinutes.low) / cfT : 1;
  const entropyShare =
    entropyBits(beliefToVector(pack, sim.initialBelief)) / Math.log2(pack.hypothesisIds.length);
  const confidenceScore = round(
    clamp(
      0.4 * sim.rollouts.diagnosisReachedShare +
        0.3 * (1 - clamp(spread, 0, 1)) +
        0.3 * (1 - clamp(entropyShare, 0, 1)),
      0,
      1,
    ),
    3,
  );
  const confidenceLevel: Level =
    sim.rollouts.diagnosisReachedShare < 0.5
      ? 'low'
      : confidenceScore >= 0.7
        ? 'high'
        : confidenceScore >= 0.45
          ? 'medium'
          : 'low';

  const summary = decisionTimeSummary({
    label: profile.label,
    boundary: { asOf: fork.timestamp },
    steps,
    counterfactualMetrics: metrics,
    rollouts: sim.rollouts,
  });

  const quality = assessScenarioQuality({
    strategy: sim.strategy,
    steps,
    actions: sim.steps.map((s) => s.action),
    validity: { valid, checks },
    comparison: { level: confidenceLevel, score: confidenceScore },
    rollouts: sim.rollouts,
    eventCount: preView.events.length,
  });

  return {
    ...metaOf(ctx),
    id: scenarioId,
    caseId: ctx.caseId,
    forkId: fork.id,
    analysisRunId: ctx.runId,
    modelExecutionId: null,
    status: valid ? 'completed' : 'rejected',
    strategy: sim.strategy,
    label: profile.label,
    summary,
    boundary: {
      asOf: fork.timestamp,
      eventIds: preView.events.map((e) => e.id),
      evidenceIds: evidenceBefore.map((e) => e.id),
      eventCount: preView.events.length,
      leakCheck: {
        passed: futureReferences === 0 && preView.resolution === null,
        checkedAt: ctx.now,
        futureReferencesFound: futureReferences,
        resolutionExcluded: preView.resolution === null,
        details: leakDetails,
      },
    },
    steps,
    branchNotes: sim.branchNotes,
    assumptions: [...COUNTERFACTUAL_ASSUMPTIONS, profile.description],
    rollouts: {
      count: sim.rollouts.count,
      seed: sim.rollouts.seed,
      modalPathShare: sim.rollouts.modalPathShare,
      diagnosisReachedShare: sim.rollouts.diagnosisReachedShare,
    },
    actualMetrics,
    counterfactualMetrics: metrics,
    improvements,
    comparisonConfidence: {
      level: confidenceLevel,
      score: confidenceScore,
      rationale: `Diagnosis reached in ${pct(sim.rollouts.diagnosisReachedShare)} of ${sim.rollouts.count} rollouts; time-to-diagnosis spread ${pct(clamp(spread, 0, 1))} of its median; initial uncertainty ${pct(clamp(entropyShare, 0, 1))} of maximum.`,
    },
    validity: { valid, checks },
    labels: { simulated: true, estimated: true },
    quality,
    reviewState: 'pending',
    reviewReason: null,
    reviewedBy: null,
    reviewedAt: null,
  };
}

/** Builds the pre-resolution boundary view for a fork. */
export function boundaryViewFor(
  events: readonly CaseEvent[],
  fork: DecisionFork,
): PreResolutionView {
  return createTemporalViewBeforeEvent(events, fork.eventId);
}
