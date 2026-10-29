import type { CompiledPack } from '../knowledge/compile';
import { type Belief, posteriorFrom } from './belief';
import type { RankingState } from './action-value';
import { computeRequirementStates, satisfiedSetAt, type RequirementState } from './requirements';
import { detectObservations, type Observation } from './signals';
import type { TemporalView } from './temporal';

export interface ViewAnalysis {
  view: TemporalView;
  observations: Observation[];
  requirementStates: RequirementState[];
  belief: Belief;
  rankingState: RankingState;
}

/**
 * Everything the decision-support functions need to know "as of" a temporal view: detected
 * observations, requirement satisfaction and the posterior. Derived ONLY from the view's events.
 */
export function analyzeView(view: TemporalView, pack: CompiledPack, caseId: string): ViewAnalysis {
  const observations = detectObservations(view, pack, caseId);
  const requirementStates = computeRequirementStates(view, pack, observations);
  const belief = posteriorFrom(pack, observations);
  const lastIndex = view.events.length - 1;
  return {
    view,
    observations,
    requirementStates,
    belief,
    rankingState: {
      belief,
      observedSignals: new Set(observations.map((o) => o.signalId)),
      satisfied: lastIndex >= 0 ? satisfiedSetAt(requirementStates, lastIndex) : new Set<string>(),
    },
  };
}
