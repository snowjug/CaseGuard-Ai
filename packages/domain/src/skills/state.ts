import type { ActionOutcome, KnowledgeAction } from '@caseguard/schemas';
import { applyOutcome, type RankingState } from '../engine/action-value';
import { resolveActionKey } from '../engine/actions';
import { type Belief, topHypotheses } from '../engine/belief';
import { signalRequirementLinks } from '../engine/requirements';
import { analyzeView, type ViewAnalysis } from '../engine/state';
import type { TemporalView } from '../engine/temporal';
import type { CompiledPack } from '../knowledge/compile';

export interface ExecutedAction {
  actionKey: string;
  /** Null when the execution is simulated (replays and baselines). */
  eventId: string | null;
  at: string | null;
  outcomeId: string | null;
}

/**
 * What a guided investigation knows at one moment: the belief, the signals seen, the requirements
 * satisfied and which pack actions were already run. Built from a temporal view or advanced by a
 * simulated outcome, so live plans and replays share exactly the same logic.
 */
export interface KnowledgeState {
  belief: Belief;
  observedSignals: ReadonlySet<string>;
  satisfied: ReadonlySet<string>;
  executed: ReadonlyMap<string, ExecutedAction>;
}

export const toRankingState = (state: KnowledgeState): RankingState => ({
  belief: state.belief,
  observedSignals: state.observedSignals,
  satisfied: state.satisfied,
});

/**
 * The outcome of an action that the observed signals already reveal. When several outcomes are fully
 * observed, the one that became visible first at or after `notBefore` wins, so a later validation
 * result does not overwrite the diagnostic answer.
 */
export function revealedOutcome(
  action: KnowledgeAction,
  observed: ReadonlySet<string>,
  firstSeen: ReadonlyMap<string, string> = new Map(),
  notBefore: string | null = null,
): ActionOutcome | null {
  const full = action.outcomes.filter(
    (o) => o.emitsSignals.length > 0 && o.emitsSignals.every((s) => observed.has(s)),
  );
  if (full.length === 0) return null;
  const seenAt = (o: ActionOutcome): string =>
    o.emitsSignals.map((s) => firstSeen.get(s) ?? '').reduce((a, b) => (a > b ? a : b), '');
  const sorted = [...full].sort((a, b) => {
    const [sa, sb] = [seenAt(a), seenAt(b)];
    return sa < sb ? -1 : sa > sb ? 1 : b.emitsSignals.length - a.emitsSignals.length;
  });
  const after = notBefore === null ? [] : sorted.filter((o) => seenAt(o) >= notBefore);
  return after[0] ?? sorted[0] ?? null;
}

/** Knowledge state derived ONLY from the events inside the view (strict temporal integrity). */
export function knowledgeStateFromView(
  view: TemporalView,
  pack: CompiledPack,
  caseId: string,
): { state: KnowledgeState; analysis: ViewAnalysis } {
  const analysis = analyzeView(view, pack, caseId);
  const firstSeen = new Map<string, string>();
  for (const obs of analysis.observations) {
    const previous = firstSeen.get(obs.signalId);
    if (previous === undefined || obs.timestamp < previous)
      firstSeen.set(obs.signalId, obs.timestamp);
  }
  const { belief, observedSignals, satisfied } = analysis.rankingState;
  const executed = new Map<string, ExecutedAction>();
  for (const event of view.events) {
    const key = resolveActionKey(event, pack);
    if (!key || executed.has(key)) continue;
    const action = pack.actions.get(key);
    if (!action) continue;
    const outcome = revealedOutcome(action, observedSignals, firstSeen, event.timestamp);
    executed.set(key, {
      actionKey: key,
      eventId: event.id,
      at: event.timestamp,
      outcomeId: outcome?.id ?? null,
    });
  }
  return { state: { belief, observedSignals, satisfied, executed }, analysis };
}

/** State after a (simulated) action produced the outcome at `outcomeIndex`. */
export function advanceState(
  pack: CompiledPack,
  state: KnowledgeState,
  action: KnowledgeAction,
  outcomeIndex: number,
): KnowledgeState {
  const outcome = action.outcomes[outcomeIndex];
  const emitted = outcome?.emitsSignals ?? [];
  const links = signalRequirementLinks(pack);
  const satisfied = new Set([...state.satisfied, ...action.produces]);
  for (const signal of emitted) for (const req of links.get(signal) ?? []) satisfied.add(req);
  const executed = new Map(state.executed);
  executed.set(action.id, {
    actionKey: action.id,
    eventId: null,
    at: null,
    outcomeId: outcome?.id ?? null,
  });
  return {
    belief: applyOutcome(pack, action, outcomeIndex, state.belief),
    observedSignals: new Set([...state.observedSignals, ...emitted]),
    satisfied,
    executed,
  };
}

/** Same criterion as the counterfactual engine: a confident leader whose confirmation evidence exists. */
export function diagnosisStatus(
  pack: CompiledPack,
  state: Pick<KnowledgeState, 'belief' | 'satisfied'>,
): { done: boolean; leader: string; confidence: number; unmet: string[] } {
  const top = topHypotheses(state.belief, 1)[0];
  const leader = top?.id ?? 'hyp.other';
  const required = pack.hypotheses.get(leader)?.confirmationRequirementIds ?? [];
  const unmet = required.filter((r) => !state.satisfied.has(r));
  const confident =
    (top?.p ?? 0) >= pack.pack.policies.diagnosisThreshold && leader !== 'hyp.other';
  return { done: confident && unmet.length === 0, leader, confidence: top?.p ?? 0, unmet };
}
