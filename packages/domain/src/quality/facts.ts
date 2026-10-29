import type {
  ActionValueConfig,
  CaseEvent,
  CaseResolution,
  Claim,
  DecisionFork,
  DiagnosticAction,
} from '@caseguard/schemas';
import { isCustomerSide } from '../engine/context';
import { findDiagnosisIndex } from '../engine/hindsight';
import type { DeterministicAnalysis } from '../engine/pipeline';
import type { RequirementState } from '../engine/requirements';
import { eventText } from '../engine/signals';
import type { CompiledPack } from '../knowledge/compile';
import { compareIso } from '../util/time';
import {
  computeReplyWaits,
  isCustomerChase,
  isCustomerFacingEngineerEvent,
  type ReplyWait,
} from './conversation';
import type { QualityRuleParameters } from './parameters';

export interface ClosureFacts {
  /** Index (in the view) of the first closure statement. */
  index: number;
  at: string;
  /** Null when only the resolution record marks the closure. */
  event: CaseEvent | null;
}

export interface DiagnosisFacts {
  index: number;
  key: string;
  at: string;
}

/** Everything the dimension and penalty rules read, derived once from one temporal view. */
export interface QualityFacts {
  analysis: DeterministicAnalysis;
  pack: CompiledPack;
  actionConfig: ActionValueConfig;
  params: QualityRuleParameters;
  events: readonly CaseEvent[];
  indexOf: ReadonlyMap<string, number>;
  /** The temporal boundary of the view: nothing after it is known. */
  viewEnd: string;
  resolution: CaseResolution | null;
  actions: readonly DiagnosticAction[];
  actionByEvent: ReadonlyMap<string, DiagnosticAction>;
  forksByEvent: ReadonlyMap<string, DecisionFork>;
  /** Engineer statement claims (hedged, definitive, template, closure-style). */
  statementClaims: readonly Claim[];
  requirement: (id: string) => RequirementState | undefined;
  hypothesisName: (key: string) => string;
  closure: ClosureFacts | null;
  diagnosis: DiagnosisFacts | null;
  customerFacing: readonly CaseEvent[];
  replyWaits: readonly ReplyWait[];
  chaseEvents: readonly CaseEvent[];
}

function findClosure(
  events: readonly CaseEvent[],
  pack: CompiledPack,
  resolution: CaseResolution | null,
): ClosureFacts | null {
  const index = events.findIndex(
    (e) =>
      e.type === 'resolution_note' ||
      (e.type === 'status_change' && pack.lexicon.closure.some((re) => re.test(eventText(e)))),
  );
  const event = index >= 0 ? events[index] : undefined;
  if (event) return { index, at: event.timestamp, event };
  if (!resolution) return null;
  let last = -1;
  events.forEach((e, i) => {
    if (compareIso(e.timestamp, resolution.resolvedAt) <= 0) last = i;
  });
  return last >= 0 ? { index: last, at: resolution.resolvedAt, event: null } : null;
}

export function buildQualityFacts(input: {
  analysis: DeterministicAnalysis;
  pack: CompiledPack;
  actionConfig: ActionValueConfig;
  params: QualityRuleParameters;
}): QualityFacts {
  const { analysis, pack, actionConfig, params } = input;
  const view = analysis.view;
  const events = view.events;
  const requirementById = new Map(analysis.requirementStates.map((s) => [s.requirementId, s]));
  const diagnosisHit = findDiagnosisIndex(pack, analysis.timeline, analysis.requirementStates, 0);
  const diagnosisEvent = diagnosisHit ? events[diagnosisHit.index] : undefined;
  const firstCustomer = events.findIndex((e) => isCustomerSide(e.participantRole));
  return {
    analysis,
    pack,
    actionConfig,
    params,
    events,
    indexOf: new Map(events.map((e, i) => [e.id, i])),
    viewEnd: view.asOf,
    resolution: view.resolution,
    actions: analysis.actions,
    actionByEvent: new Map(analysis.actions.map((a) => [a.eventId, a])),
    forksByEvent: new Map(analysis.forks.map((f) => [f.eventId, f])),
    statementClaims: analysis.claims.filter((c) => c.ruleId.startsWith('statement.')),
    requirement: (id) => requirementById.get(id),
    hypothesisName: (key) => pack.hypotheses.get(key)?.name ?? key,
    closure: findClosure(events, pack, view.resolution),
    diagnosis:
      diagnosisHit && diagnosisEvent
        ? { index: diagnosisHit.index, key: diagnosisHit.key, at: diagnosisEvent.timestamp }
        : null,
    customerFacing: events.filter(isCustomerFacingEngineerEvent),
    replyWaits: computeReplyWaits(events, view.asOf),
    chaseEvents: events.filter((e, i) => isCustomerChase(e, i === firstCustomer)),
  };
}
