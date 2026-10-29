import type { CompiledPack } from '../knowledge/compile';
import { type Belief, posteriorFrom } from './belief';
import type { RankingState } from './action-value';
import { computeRequirementStates, satisfiedSetAt, type RequirementState } from './requirements';
import { detectObservations, type Observation } from './signals';
import { createTemporalPrefixView, type TemporalView } from './temporal';

export interface ViewAnalysis {
  view: TemporalView;
  observations: Observation[];
  requirementStates: RequirementState[];
  belief: Belief;
  rankingState: RankingState;
}

function rankingStateFor(
  pack: CompiledPack,
  observations: readonly Observation[],
  requirementStates: readonly RequirementState[],
  lastIndex: number,
): { belief: Belief; rankingState: RankingState } {
  const belief = posteriorFrom(pack, observations);
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

  constructor(
    private readonly full: TemporalView,
    private readonly pack: CompiledPack,
    caseId: string,
    precomputed?: {
      observations: readonly Observation[];
      requirementStates: readonly RequirementState[];
    },
  ) {
    this.observations = precomputed?.observations ?? detectObservations(full, pack, caseId);
    this.requirementStates =
      precomputed?.requirementStates ??
      computeRequirementStates(full, pack, [...this.observations]);
  }

  /** Analysis of the events strictly before the event at `eventIndex` (its decision moment). */
  at(eventIndex: number): ViewAnalysis {
    const observations = this.observations.filter((o) => o.eventIndex < eventIndex);
    const requirementStates = restrictRequirementStates(this.requirementStates, eventIndex);
    const { belief, rankingState } = rankingStateFor(
      this.pack,
      observations,
      requirementStates,
      eventIndex - 1,
    );
    return {
      view: createTemporalPrefixView(this.full, eventIndex),
      observations,
      requirementStates,
      belief,
      rankingState,
    };
  }
}
