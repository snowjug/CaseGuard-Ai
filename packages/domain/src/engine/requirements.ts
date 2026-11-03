import { ENGINEER_SIDE_ROLES, type CaseEvent } from '@caseguard/schemas';
import type { CompiledPack } from '../knowledge/compile';
import { compareIso } from '../util/time';
import { eventText, firstDetectorMatch, type Observation } from './signals';
import type { TemporalView } from './temporal';

export interface RequirementState {
  requirementId: string;
  satisfiedAtIndex: number | null;
  satisfiedAt: string | null;
  satisfiedByEventId: string | null;
  /** When the requirement became relevant (null while it is not yet relevant in this view). */
  firstRelevantAt: string | null;
  firstRelevantIndex: number | null;
}

function firstRelevantIndex(
  neededFrom: 'case_open' | 'first_engineer_request' | 'before_escalation' | 'before_closure',
  view: TemporalView,
  pack: CompiledPack,
): number | null {
  const events = view.events;
  switch (neededFrom) {
    case 'case_open':
      return events.length > 0 ? 0 : null;
    case 'first_engineer_request': {
      const idx = events.findIndex(
        (e) =>
          ENGINEER_SIDE_ROLES.includes(e.participantRole) &&
          (e.action !== null || e.type === 'engineer_email'),
      );
      return idx >= 0 ? idx : null;
    }
    case 'before_escalation': {
      const escalationActions = pack.pack.policies.escalationActionIds;
      const idx = events.findIndex(
        (e) =>
          e.type === 'escalation' ||
          (e.action?.actionKey !== undefined && escalationActions.includes(e.action.actionKey)),
      );
      return idx >= 0 ? idx : null;
    }
    case 'before_closure': {
      const idx = events.findIndex(
        (e) =>
          e.type === 'resolution_note' ||
          e.type === 'validation_result' ||
          (e.type === 'status_change' && pack.lexicon.closure.some((re) => re.test(eventText(e)))),
      );
      return idx >= 0 ? idx : null;
    }
  }
}

/** Signal -> requirement ids the signal satisfies (from signal.satisfies and requirement.satisfiedBySignals). */
export function signalRequirementLinks(pack: CompiledPack): Map<string, Set<string>> {
  const links = new Map<string, Set<string>>();
  const link = (signalId: string, requirementId: string): void => {
    const set = links.get(signalId) ?? new Set<string>();
    set.add(requirementId);
    links.set(signalId, set);
  };
  for (const signal of pack.pack.signals) for (const r of signal.satisfies) link(signal.id, r);
  for (const req of pack.pack.requirements) for (const s of req.satisfiedBySignals) link(s, req.id);
  return links;
}

/**
 * Tracks when each pack requirement became relevant and when (if ever) it was satisfied, using only
 * events inside the view (so asOf analyses never see later satisfaction).
 */
export function computeRequirementStates(
  view: TemporalView,
  pack: CompiledPack,
  observations: readonly Observation[],
): RequirementState[] {
  const signalToRequirements = signalRequirementLinks(pack);
  return pack.pack.requirements.map((req) => {
    let best: { index: number; event: CaseEvent } | null = null;
    for (const obs of observations) {
      if (!signalToRequirements.get(obs.signalId)?.has(req.id)) continue;
      const event = view.events[obs.eventIndex];
      if (event && (best === null || obs.eventIndex < best.index))
        best = { index: obs.eventIndex, event };
    }
    const detectors = pack.requirementDetectors.get(req.id);
    if (detectors && detectors.length > 0) {
      view.events.forEach((event, index) => {
        if (best !== null && best.index <= index) return;
        if (firstDetectorMatch(detectors, event, undefined, 'requirement')) best = { index, event };
      });
    }
    const relevant = firstRelevantIndex(req.neededFrom, view, pack);
    return {
      requirementId: req.id,
      satisfiedAtIndex: best?.index ?? null,
      satisfiedAt: best?.event.timestamp ?? null,
      satisfiedByEventId: best?.event.id ?? null,
      firstRelevantAt: relevant === null ? null : (view.events[relevant]?.timestamp ?? null),
      firstRelevantIndex: relevant,
    };
  });
}

/** Whether a requirement was satisfied at or before `eventIndex` (inclusive). */
export const isSatisfiedAt = (state: RequirementState | undefined, eventIndex: number): boolean =>
  state !== undefined && state.satisfiedAtIndex !== null && state.satisfiedAtIndex <= eventIndex;

export function satisfiedSetAt(
  states: readonly RequirementState[],
  eventIndex: number,
): Set<string> {
  return new Set(states.filter((s) => isSatisfiedAt(s, eventIndex)).map((s) => s.requirementId));
}

/** Requirements that are relevant but unsatisfied as of an event index. */
export function missingRequirementsAt(
  states: readonly RequirementState[],
  eventIndex: number,
): RequirementState[] {
  return states.filter(
    (s) =>
      s.firstRelevantIndex !== null &&
      s.firstRelevantIndex <= eventIndex &&
      !isSatisfiedAt(s, eventIndex),
  );
}

export function sortStates(states: readonly RequirementState[]): RequirementState[] {
  return [...states].sort((a, b) =>
    compareIso(a.firstRelevantAt ?? '9999', b.firstRelevantAt ?? '9999'),
  );
}
