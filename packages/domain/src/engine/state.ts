import type { CompiledPack } from '../knowledge/compile';
import { type Belief, inEventOrder, posteriorFrom, priorBelief, updateBelief } from './belief';
import type { RankingState } from './action-value';
import { computeRequirementStates, satisfiedSetAt, type RequirementState } from './requirements';
import { detectObservations, type Observation } from './signals';
import { createTemporalPrefixView, type TemporalView } from './temporal';

export interface ViewAnalysis {
  view: TemporalView;
  observations: Observation[];
  requirementStates: RequirementState[];
  /** Exactly the last step of this view's belief timeline (see `updateBelief`). */
  belief: Belief;
  rankingState: RankingState;
}

function rankingStateFor(
  pack: CompiledPack,
  observations: readonly Observation[],
  requirementStates: readonly RequirementState[],
  lastIndex: number,
): { belief: Belief; rankingState: RankingState } {
  const belief = posteriorFrom(pack, inEventOrder(observations));
  return {
    belief,
    rankingState: {
      belief,
      observedSignals: new Set(observations.map((o) => o.signalId)),
      satisfied: lastIndex >= 0 ? satisfiedSetAt(requirementStates, lastIndex) : new Set<string>(),
    },
  };
}

/**
 * Everything the decision-support functions need to know "as of" a temporal view: detected
 * observations, requirement satisfaction and the posterior. Derived ONLY from the view's events.
 */
export function analyzeView(view: TemporalView, pack: CompiledPack, caseId: string): ViewAnalysis {
  const observations = detectObservations(view, pack, caseId);
  const requirementStates = computeRequirementStates(view, pack, observations);
  const { belief, rankingState } = rankingStateFor(
    pack,
    observations,
    requirementStates,
    view.events.length - 1,
  );
  return { view, observations, requirementStates, belief, rankingState };
}

/** Restricts requirement states to what was known within the first `length` events. */
export function restrictRequirementStates(
  states: readonly RequirementState[],
  length: number,
): RequirementState[] {
  return states.map((s) => {
    const satisfied = s.satisfiedAtIndex !== null && s.satisfiedAtIndex < length;
    const relevant = s.firstRelevantIndex !== null && s.firstRelevantIndex < length;
    return {
      requirementId: s.requirementId,
      satisfiedAtIndex: satisfied ? s.satisfiedAtIndex : null,
      satisfiedAt: satisfied ? s.satisfiedAt : null,
      satisfiedByEventId: satisfied ? s.satisfiedByEventId : null,
      firstRelevantAt: relevant ? s.firstRelevantAt : null,
      firstRelevantIndex: relevant ? s.firstRelevantIndex : null,
    };
  });
}

/**
 * Decision-moment analyses for every prefix of one view, without re-scanning the text each time.
 * Signal detection is per event and requirement satisfaction is first-occurrence based, so the prefix
 * analysis is exactly the full analysis restricted to events before the boundary (asserted by the
 * as-of equivalence tests).
 */
export class PrefixAnalyzer {
  private readonly observations: readonly Observation[];
  private readonly requirementStates: readonly RequirementState[];
  /**
   * The belief after the first `count` observations. Decisions are asked for in event order, so each
   * call only applies the new observations with the same one-observation update the timeline uses;
   * asking for an earlier boundary restarts from the prior.
   */
  private run: { count: number; belief: Belief; signals: Set<string> };

  constructor(
    private readonly full: TemporalView,
    private readonly pack: CompiledPack,
    caseId: string,
    precomputed?: {
      observations: readonly Observation[];
      requirementStates: readonly RequirementState[];
    },
  ) {
    this.observations = inEventOrder(
      precomputed?.observations ?? detectObservations(full, pack, caseId),
    );
    this.requirementStates =
      precomputed?.requirementStates ??
      computeRequirementStates(full, pack, [...this.observations]);
    this.run = this.freshRun();
  }

  private freshRun(): { count: number; belief: Belief; signals: Set<string> } {
    return { count: 0, belief: priorBelief(this.pack), signals: new Set<string>() };
  }

  /** Number of observations detected in events before `eventIndex` (binary search; list is ordered). */
  private countBefore(eventIndex: number): number {
    let low = 0;
    let high = this.observations.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if ((this.observations[mid]?.eventIndex ?? 0) < eventIndex) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  /** Analysis of the events strictly before the event at `eventIndex` (its decision moment). */
  at(eventIndex: number): ViewAnalysis {
    const requirementStates = restrictRequirementStates(this.requirementStates, eventIndex);
    const count = this.countBefore(eventIndex);
    if (count < this.run.count) this.run = this.freshRun();
    for (let i = this.run.count; i < count; i++) {
      const obs = this.observations[i];
      if (!obs) continue;
      this.run.belief = updateBelief(this.pack, this.run.belief, obs);
      this.run.signals.add(obs.signalId);
    }
    this.run.count = count;
    const belief = { ...this.run.belief };
    return {
      view: createTemporalPrefixView(this.full, eventIndex),
      observations: this.observations.slice(0, count),
      requirementStates,
      belief,
      rankingState: {
        belief,
        observedSignals: new Set(this.run.signals),
        satisfied:
          eventIndex - 1 >= 0
            ? satisfiedSetAt(requirementStates, eventIndex - 1)
            : new Set<string>(),
      },
    };
  }
}
