import type { ActionValueConfig } from '@caseguard/schemas';
import { rankActions, type ActionEvaluation } from '../engine/action-value';
import { priorBelief } from '../engine/belief';
import type { DeterministicAnalysis } from '../engine/pipeline';
import { satisfiedSetAt, type RequirementState } from '../engine/requirements';
import { eventText } from '../engine/signals';
import type { CompiledPack } from '../knowledge/compile';
import type { Checkpoint, LiveWarningOptions } from './types';

/** Narrows a requirement state to what was known by event `index`: later satisfaction is unknown. */
function restrict(state: RequirementState, index: number): RequirementState {
  const satisfied = state.satisfiedAtIndex !== null && state.satisfiedAtIndex <= index;
  const relevant = state.firstRelevantIndex !== null && state.firstRelevantIndex <= index;
  return {
    requirementId: state.requirementId,
    satisfiedAtIndex: satisfied ? state.satisfiedAtIndex : null,
    satisfiedAt: satisfied ? state.satisfiedAt : null,
    satisfiedByEventId: satisfied ? state.satisfiedByEventId : null,
    firstRelevantIndex: relevant ? state.firstRelevantIndex : null,
    firstRelevantAt: relevant ? state.firstRelevantAt : null,
  };
}

/**
 * Builds the information boundary for one instant. The source analysis may extend beyond `index`
 * (it is built once for efficiency), but every collection handed to the rules is cut at `index`
 * and the engine guarantees that an analysis of a prefix equals the full analysis restricted to it.
 */
export function buildCheckpoint(input: {
  analysis: DeterministicAnalysis;
  pack: CompiledPack;
  config: ActionValueConfig;
  options: LiveWarningOptions;
  index: number;
  now: string;
}): Checkpoint {
  const { analysis, pack, config, options, index } = input;
  const all = analysis.view.events;
  const events = all.slice(0, index + 1);
  const at = events[index]?.timestamp ?? input.now;
  const positions = new Map(all.map((e, i) => [e.id, i]));
  const indexOf = (eventId: string): number => {
    const i = positions.get(eventId);
    return i !== undefined && i <= index ? i : -1;
  };
  const visible = (eventId: string | null): boolean => eventId !== null && indexOf(eventId) >= 0;

  const states = new Map(
    analysis.requirementStates.map((s) => [s.requirementId, restrict(s, index)]),
  );
  const keyById = new Map(analysis.hypotheses.map((h) => [h.id, h.key]));
  const evidenceLabels = new Map(
    analysis.evidence.filter((e) => visible(e.eventId)).map((e) => [e.id, e.label]),
  );
  const actions = analysis.actions.filter((a) => a.sequence <= index);
  const closureIndex = events.findIndex(
    (e) =>
      e.type === 'resolution_note' ||
      (e.type === 'status_change' && pack.lexicon.closure.some((re) => re.test(eventText(e)))),
  );

  let ranked: readonly ActionEvaluation[] | null = null;
  const belief = analysis.timeline.steps[index]?.posterior ?? priorBelief(pack);
  const rankNext = (): readonly ActionEvaluation[] => {
    if (ranked) return ranked;
    const observedSignals = new Set(
      analysis.observations.filter((o) => o.eventIndex <= index).map((o) => o.signalId),
    );
    const satisfied = satisfiedSetAt([...states.values()], index);
    ranked = rankActions(pack, config, { belief, observedSignals, satisfied }).candidates;
    return ranked;
  };

  return {
    index,
    at,
    now: input.now,
    events,
    pack,
    config,
    options,
    actions,
    actionByEvent: new Map(actions.map((a) => [a.eventId, a])),
    claims: analysis.claims.filter((c) => visible(c.eventId)),
    anchors: analysis.anchors.filter((a) => a.eventIndex <= index),
    forks: analysis.forks.filter((f) => visible(f.eventId)),
    belief,
    indexOf,
    requirement: (id) => states.get(id),
    satisfied: (id) => (states.get(id)?.satisfiedAtIndex ?? null) !== null,
    satisfiedBefore: (id, before) => {
      const satisfiedAt = states.get(id)?.satisfiedAtIndex ?? null;
      return satisfiedAt !== null && satisfiedAt <= Math.min(index, before - 1);
    },
    hypothesisName: (key) => pack.hypotheses.get(key)?.name ?? key,
    hypothesisKey: (reference) =>
      pack.hypotheses.has(reference) ? reference : (keyById.get(reference) ?? reference),
    evidenceLabel: (evidenceId) => evidenceLabels.get(evidenceId),
    decision: (eventId) => (indexOf(eventId) >= 0 ? analysis.decisions.get(eventId) : undefined),
    rankNext,
    closureIndex,
  };
}
