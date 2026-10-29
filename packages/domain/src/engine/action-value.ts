import type {
  ActionValueBreakdown,
  ActionValueConfig,
  KnowledgeAction,
  KnowledgeSignal,
} from '@caseguard/schemas';
import type { CompiledPack } from '../knowledge/compile';
import { clamp, entropyBits, normalize, round } from '../util/math';
import { type Belief, beliefToVector, likelihoodOf, observationWeight } from './belief';

export interface RankingState {
  belief: Belief;
  /** Signals already observed in the view (an action whose outcome is already known is redundant). */
  observedSignals: ReadonlySet<string>;
  /** Requirement ids satisfied at the decision time. */
  satisfied: ReadonlySet<string>;
}

export interface OutcomeProbability {
  id: string;
  label: string;
  emitsSignals: string[];
  probability: number;
  simulatedResult: string;
}

export interface ActionEvaluation {
  action: KnowledgeAction;
  /** Information gain of the action's own outcomes, in bits. */
  ownEigBits: number;
  /** Information value credited to this action (own value or the value of the actions it unlocks). */
  eigBits: number;
  enabledActionId: string | null;
  outcomes: OutcomeProbability[];
  redundant: boolean;
  redundantReason: string | null;
  relevance: number;
  confidence: number;
  normalized: {
    information: number;
    relevance: number;
    confidence: number;
    time: number;
    token: number;
    customer: number;
    risk: number;
  };
  numerator: number;
  denominator: number;
  score: number;
  allowed: boolean;
  blockedReasons: string[];
  requiresFirst: string[];
}

export interface RankOptions {
  /** Cost-weight overrides used by counterfactual strategies and the sensitivity analysis. */
  weights?: Partial<ActionValueConfig['weights']>;
  /** Restrict candidates (e.g. strategy excludes high customer effort). */
  filter?: (action: KnowledgeAction) => boolean;
  /** Treat diagnosis as reached so remediation/validation actions become eligible. */
  includeRemediation?: boolean;
  /**
   * Expected-information-gain results for ONE belief, shared by the evaluations of a ranking (an
   * action's value can include the value of the actions it unlocks, which are evaluated themselves).
   * Ranking creates one when omitted; never reuse a cache across different beliefs.
   */
  eigCache?: Map<string, { bits: number; outcomes: OutcomeProbability[] }>;
}

const clampProb = (p: number): number => clamp(p, 0.01, 0.99);

/** Signals an action can reveal across all of its outcomes. */
function vocabulary(action: KnowledgeAction): string[] {
  return [...new Set(action.outcomes.flatMap((o) => o.emitsSignals))];
}

// The vocabulary only depends on the action, so the internal helpers below take it as an argument
// and evaluating one action builds it once instead of once per hypothesis and outcome.

function distributionOver(
  pack: CompiledPack,
  action: KnowledgeAction,
  vocab: readonly string[],
  hypothesisId: string,
): number[] {
  const weights = action.outcomes.map((outcome) => {
    let w = 1;
    for (const s of vocab) {
      const l = clampProb(likelihoodOf(pack, s, hypothesisId));
      w *= outcome.emitsSignals.includes(s) ? l : 1 - l;
    }
    return w;
  });
  return normalize(weights);
}

function updateLikelihoodFor(
  pack: CompiledPack,
  action: KnowledgeAction,
  vocab: readonly string[],
  outcomeIndex: number,
  hypothesisId: string,
): number {
  const outcome = action.outcomes[outcomeIndex];
  if (!outcome) return 1;
  if (outcome.emitsSignals.length > 0) {
    let l = 1;
    for (const s of outcome.emitsSignals) {
      l *= clampProb(likelihoodOf(pack, s, hypothesisId)) ** observationWeight(pack, s, 0);
    }
    return l;
  }
  // "None of the signals appeared" is itself weak evidence.
  let l = 1;
  for (const s of vocab)
    l *= (1 - clampProb(likelihoodOf(pack, s, hypothesisId))) ** observationWeight(pack, s, 0);
  return l;
}

function updatedBelief(
  pack: CompiledPack,
  action: KnowledgeAction,
  vocab: readonly string[],
  outcomeIndex: number,
  belief: Belief,
): Belief {
  const ids = pack.hypothesisIds;
  const raw = ids.map(
    (id) => (belief[id] ?? 0) * updateLikelihoodFor(pack, action, vocab, outcomeIndex, id),
  );
  const floor = pack.pack.policies.posteriorFloor;
  const probs = normalize(normalize(raw).map((p) => Math.max(p, floor)));
  return Object.fromEntries(ids.map((id, i) => [id, probs[i] ?? 0]));
}

function predictedOutcomes(
  pack: CompiledPack,
  action: KnowledgeAction,
  vocab: readonly string[],
  belief: Belief,
): OutcomeProbability[] {
  const ids = pack.hypothesisIds;
  const perHyp = ids.map((id) => distributionOver(pack, action, vocab, id));
  return action.outcomes.map((outcome, o) => {
    let p = 0;
    ids.forEach((id, h) => {
      p += (belief[id] ?? 0) * (perHyp[h]?.[o] ?? 0);
    });
    return {
      id: outcome.id,
      label: outcome.label,
      emitsSignals: outcome.emitsSignals,
      probability: p,
      simulatedResult: outcome.simulatedResult,
    };
  });
}

/**
 * P(outcome | hypothesis): each outcome's weight is the probability of exactly its signals appearing
 * and the others not appearing (independent Bernoulli), normalised across the defined outcomes.
 */
export function outcomeDistributionFor(
  pack: CompiledPack,
  action: KnowledgeAction,
  hypothesisId: string,
): number[] {
  return distributionOver(pack, action, vocabulary(action), hypothesisId);
}

/** Likelihood used to update beliefs when an outcome is observed (same dampening as real evidence). */
export function outcomeUpdateLikelihood(
  pack: CompiledPack,
  action: KnowledgeAction,
  outcomeIndex: number,
  hypothesisId: string,
): number {
  return updateLikelihoodFor(pack, action, vocabulary(action), outcomeIndex, hypothesisId);
}

export function applyOutcome(
  pack: CompiledPack,
  action: KnowledgeAction,
  outcomeIndex: number,
  belief: Belief,
): Belief {
  return updatedBelief(pack, action, vocabulary(action), outcomeIndex, belief);
}

/** Predictive distribution over an action's outcomes under the current belief. */
export function predictOutcomes(
  pack: CompiledPack,
  action: KnowledgeAction,
  belief: Belief,
): OutcomeProbability[] {
  return predictedOutcomes(pack, action, vocabulary(action), belief);
}

/** Expected information gain (bits) of an action: H(prior) - E[H(posterior | outcome)]. */
export function expectedInformationGain(
  pack: CompiledPack,
  action: KnowledgeAction,
  belief: Belief,
): { bits: number; outcomes: OutcomeProbability[] } {
  if (action.outcomes.length === 0) return { bits: 0, outcomes: [] };
  const vocab = vocabulary(action);
  const outcomes = predictedOutcomes(pack, action, vocab, belief);
  const prior = beliefToVector(pack, belief);
  const hPrior = entropyBits(prior);
  let expected = 0;
  action.outcomes.forEach((_o, i) => {
    const probability = outcomes[i]?.probability ?? 0;
    if (probability <= 0) return;
    const post = updatedBelief(pack, action, vocab, i, belief);
    expected += probability * entropyBits(beliefToVector(pack, post));
  });
  return { bits: Math.max(0, hPrior - expected), outcomes };
}

function revealedOutcome(
  pack: CompiledPack,
  action: KnowledgeAction,
  observed: ReadonlySet<string>,
): { revealed: boolean; label: string | null } {
  for (const outcome of action.outcomes) {
    if (outcome.emitsSignals.length > 0 && outcome.emitsSignals.every((s) => observed.has(s))) {
      const sig: KnowledgeSignal | undefined = pack.signals.get(outcome.emitsSignals[0] ?? '');
      return { revealed: true, label: sig?.label ?? outcome.label };
    }
  }
  return { revealed: false, label: null };
}

function relevanceOf(pack: CompiledPack, action: KnowledgeAction, belief: Belief): number {
  if (action.targets.length === 0) {
    return action.valueClass === 'enabling'
      ? 0.6
      : action.valueClass === 'communication'
        ? 0.5
        : 0.3;
  }
  const mass = action.targets.reduce((s, id) => s + (belief[id] ?? 0), 0);
  return clamp(2 * mass, 0, 1);
}

function unmet(action: KnowledgeAction, satisfied: ReadonlySet<string>): string[] {
  return action.requires.filter((r) => !satisfied.has(r));
}

/** Actions that become executable once `action` has produced its requirements. */
function unlockedBy(
  pack: CompiledPack,
  action: KnowledgeAction,
  satisfied: ReadonlySet<string>,
): KnowledgeAction[] {
  if (action.produces.length === 0) return [];
  const after = new Set([...satisfied, ...action.produces]);
  const out: KnowledgeAction[] = [];
  for (const other of pack.pack.actions) {
    if (other.id === action.id || other.valueClass === 'remediation') continue;
    const missingBefore = unmet(other, satisfied);
    if (missingBefore.length === 0) continue;
    if (unmet(other, after).length === 0 && missingBefore.some((r) => action.produces.includes(r)))
      out.push(other);
  }
  return out;
}

function safetyVerdict(
  pack: CompiledPack,
  config: ActionValueConfig,
  action: KnowledgeAction,
  state: RankingState,
  includeRemediation: boolean,
): { allowed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (action.destructive) reasons.push('Destructive action: never recommended automatically.');
  if (action.operationalRisk >= config.riskCeiling) {
    reasons.push(
      `Operational risk ${round(action.operationalRisk, 2)} is at or above the ceiling of ${config.riskCeiling}.`,
    );
  }
  if (action.valueClass === 'remediation' && !includeRemediation) {
    const targetP = Math.max(0, ...action.targets.map((t) => state.belief[t] ?? 0));
    const threshold = pack.pack.policies.destructiveHypothesisThreshold;
    const confirmed = action.targets.every((t) =>
      (pack.hypotheses.get(t)?.confirmationRequirementIds ?? []).every((r) =>
        state.satisfied.has(r),
      ),
    );
    if (targetP < threshold || !confirmed) {
      reasons.push(
        `Remediation, not a diagnostic step: the targeted hypothesis stands at ${Math.round(targetP * 100)}% (needs at least ${Math.round(threshold * 100)}% with confirmation evidence).`,
      );
    }
  }
  if (action.kind === 'escalation') {
    const missing = pack.pack.policies.minimumEvidenceForEscalation.filter(
      (r) => !state.satisfied.has(r),
    );
    if (missing.length > 0) {
      reasons.push(
        `Minimum evidence for escalation is not collected yet: ${missing.map((r) => pack.requirements.get(r)?.label ?? r).join('; ')}.`,
      );
    }
  }
  if (
    !includeRemediation &&
    (action.valueClass === 'validation' || action.valueClass === 'communication')
  ) {
    reasons.push('Not a diagnostic step.');
  }
  return { allowed: reasons.length === 0, reasons };
}

export function evaluateAction(
  pack: CompiledPack,
  config: ActionValueConfig,
  action: KnowledgeAction,
  state: RankingState,
  options: RankOptions = {},
): ActionEvaluation {
  const w = { ...config.weights, ...options.weights };
  const eigOf = (candidate: KnowledgeAction): { bits: number; outcomes: OutcomeProbability[] } => {
    const cache = options.eigCache;
    const cached = cache?.get(candidate.id);
    if (cached) return cached;
    const fresh = expectedInformationGain(pack, candidate, state.belief);
    cache?.set(candidate.id, fresh);
    return fresh;
  };
  const own = eigOf(action);
  const revealed = revealedOutcome(pack, action, state.observedSignals);
  const ownEig = revealed.revealed ? 0 : own.bits;

  let eig = ownEig;
  let enabled: string | null = null;
  for (const other of unlockedBy(pack, action, state.satisfied)) {
    const otherEval = eigOf(other);
    const reveal = revealedOutcome(pack, other, state.observedSignals);
    const credit = reveal.revealed ? 0 : otherEval.bits * action.reliability * 0.9;
    if (credit > eig) {
      eig = credit;
      enabled = other.id;
    }
  }

  const relevance = relevanceOf(pack, action, state.belief);
  const confidence = action.reliability;
  const normalized = {
    information: clamp(eig / config.normalization.maxInformationBits, 0, 1),
    relevance,
    confidence,
    time: clamp(action.timeMinutes.typical / config.normalization.maxTimeMinutes, 0, 1),
    token: clamp(action.tokenEstimate / config.normalization.maxTokens, 0, 1),
    customer: config.effortScale[action.customerEffort],
    risk: action.operationalRisk,
  };
  const numerator = normalized.information * relevance * confidence;
  const denominator =
    config.epsilon +
    w.time * normalized.time +
    w.token * normalized.token +
    w.customer * normalized.customer +
    w.risk * normalized.risk;
  const missing = unmet(action, state.satisfied);
  const safety = safetyVerdict(pack, config, action, state, options.includeRemediation ?? false);
  const blockedReasons = [...safety.reasons];
  if (missing.length > 0) {
    blockedReasons.push(
      `Needs first: ${missing.map((r) => pack.requirements.get(r)?.label ?? r).join('; ')}.`,
    );
  }
  return {
    action,
    ownEigBits: ownEig,
    eigBits: eig,
    enabledActionId: enabled,
    outcomes: own.outcomes,
    redundant: revealed.revealed && enabled === null,
    redundantReason: revealed.revealed
      ? `Already known: ${revealed.label ?? 'the outcome'} has been observed.`
      : null,
    relevance,
    confidence,
    normalized,
    numerator,
    denominator,
    score: numerator / denominator,
    allowed: safety.allowed && missing.length === 0 && !(revealed.revealed && enabled === null),
    blockedReasons:
      revealed.revealed && enabled === null
        ? [
            ...blockedReasons,
            `Already known: ${revealed.label ?? 'the outcome'} has been observed.`,
          ]
        : blockedReasons,
    requiresFirst: missing,
  };
}

export interface RankedActions {
  candidates: ActionEvaluation[];
  blocked: ActionEvaluation[];
}

export function rankActions(
  pack: CompiledPack,
  config: ActionValueConfig,
  state: RankingState,
  options: RankOptions = {},
): RankedActions {
  const shared: RankOptions = options.eigCache ? options : { ...options, eigCache: new Map() };
  const evaluations = pack.pack.actions
    .filter((a) => (shared.filter ? shared.filter(a) : true))
    .map((a) => evaluateAction(pack, config, a, state, shared));
  const byScore = (a: ActionEvaluation, b: ActionEvaluation): number =>
    b.score - a.score || (a.action.id < b.action.id ? -1 : 1);
  return {
    candidates: evaluations.filter((e) => e.allowed).sort(byScore),
    blocked: evaluations.filter((e) => !e.allowed).sort(byScore),
  };
}

/**
 * Rank of each candidate under perturbed weights, for the sensitivity display. Which actions are
 * candidates does not depend on the cost weights, so the ranked candidates are only re-scored.
 */
function sensitivity(
  config: ActionValueConfig,
  options: RankOptions,
  candidates: readonly ActionEvaluation[],
): Map<string, { label: string; rank: number; score: number }[]> {
  const delta = config.sensitivityDelta;
  const base = { ...config.weights, ...options.weights };
  const scenarios: { label: string; weights: ActionValueConfig['weights'] }[] = [
    { label: 'Equal weights', weights: { time: 0.25, token: 0.25, customer: 0.25, risk: 0.25 } },
  ];
  for (const key of ['time', 'token', 'customer', 'risk'] as const) {
    scenarios.push({
      label: `${key} weight +${Math.round(delta * 100)}%`,
      weights: { ...base, [key]: base[key] * (1 + delta) },
    });
    scenarios.push({
      label: `${key} weight -${Math.round(delta * 100)}%`,
      weights: { ...base, [key]: base[key] * (1 - delta) },
    });
  }
  const out = new Map<string, { label: string; rank: number; score: number }[]>();
  for (const sc of scenarios) {
    const w = sc.weights;
    const rescored = candidates
      .map((e) => ({
        e,
        score:
          e.numerator /
          (config.epsilon +
            w.time * e.normalized.time +
            w.token * e.normalized.token +
            w.customer * e.normalized.customer +
            w.risk * e.normalized.risk),
      }))
      .sort((a, b) => b.score - a.score || (a.e.action.id < b.e.action.id ? -1 : 1));
    rescored.forEach(({ e, score }, i) => {
      const list = out.get(e.action.id) ?? [];
      list.push({ label: sc.label, rank: i + 1, score: round(score, 3) });
      out.set(e.action.id, list);
    });
  }
  return out;
}

const FORMULA =
  'Action value = (Expected information gain x Relevance x Confidence) / (epsilon + w_time x Time + w_token x Tokens + w_customer x Customer effort + w_risk x Operational risk). Every term is normalised to [0, 1]. This is a configurable decision-support heuristic, not a scientific law.';

export const ACTION_VALUE_FORMULA = FORMULA;

function explain(
  e: ActionEvaluation,
  rank: number,
  config: ActionValueConfig,
  pack: CompiledPack,
): string {
  const parts: string[] = [];
  if (e.redundantReason) parts.push(e.redundantReason);
  if (e.enabledActionId) {
    const unlocked = pack.actions.get(e.enabledActionId)?.label ?? e.enabledActionId;
    parts.push(
      `Valued mainly for what it unlocks: “${unlocked}” (information value ${round(e.eigBits, 2)} bits, discounted).`,
    );
  } else {
    parts.push(
      `Expected information gain ${round(e.eigBits, 2)} bits (${Math.round(e.normalized.information * 100)}% of the ${config.normalization.maxInformationBits}-bit scale).`,
    );
  }
  parts.push(
    `Relevance ${round(e.relevance, 2)} x confidence ${round(e.confidence, 2)} over cost ${round(e.denominator, 2)} (time ${round(e.normalized.time, 2)}, tokens ${round(e.normalized.token, 2)}, customer ${round(e.normalized.customer, 2)}, risk ${round(e.normalized.risk, 2)}).`,
  );
  if (!e.allowed && e.blockedReasons.length > 0)
    parts.push(`Not recommended now: ${e.blockedReasons.join(' ')}`);
  parts.push(`Rank ${rank}.`);
  return parts.join(' ');
}

export function toBreakdowns(
  pack: CompiledPack,
  config: ActionValueConfig,
  state: RankingState,
  options: RankOptions = {},
): { candidates: ActionValueBreakdown[]; blocked: ActionValueBreakdown[] } {
  const ranked = rankActions(pack, config, state, options);
  const best = ranked.candidates[0]?.score ?? 0;
  const sens = sensitivity(config, options, ranked.candidates);
  const build = (e: ActionEvaluation, rank: number, withSens: boolean): ActionValueBreakdown => {
    const scenarios = withSens ? (sens.get(e.action.id) ?? []) : [];
    const ranks = [rank, ...scenarios.map((s) => s.rank)];
    return {
      actionKey: e.action.id,
      label: e.action.label,
      kind: e.action.kind,
      inputs: {
        expectedInformationGainBits: round(e.eigBits, 3),
        relevance: round(e.relevance, 3),
        confidence: round(e.confidence, 3),
        timeMinutes: e.action.timeMinutes.typical,
        tokens: e.action.tokenEstimate,
        customerEffort: round(e.normalized.customer, 3),
        operationalRisk: round(e.action.operationalRisk, 3),
      },
      normalized: {
        information: round(e.normalized.information, 3),
        relevance: round(e.normalized.relevance, 3),
        confidence: round(e.normalized.confidence, 3),
        time: round(e.normalized.time, 3),
        token: round(e.normalized.token, 3),
        customer: round(e.normalized.customer, 3),
        risk: round(e.normalized.risk, 3),
      },
      numerator: round(e.numerator, 4),
      denominator: round(e.denominator, 4),
      score: round(e.score, 4),
      relativeScore: best > 0 ? round(clamp(e.score / best, 0, 1), 3) : 0,
      rank,
      safety: { allowed: e.allowed, blockedReasons: e.blockedReasons },
      sensitivity: {
        minRank: Math.min(...ranks),
        maxRank: Math.max(...ranks),
        rankStable: Math.max(...ranks) - Math.min(...ranks) <= 1,
        scenarios,
      },
      requiresFirst: e.requiresFirst,
      explanation: explain(e, rank, config, pack),
      override: null,
    };
  };
  return {
    candidates: ranked.candidates.map((e, i) => build(e, i + 1, true)),
    blocked: ranked.blocked.map((e, i) => build(e, i + 1, false)),
  };
}
