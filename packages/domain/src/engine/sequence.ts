import {
  CUSTOMER_SIDE_ROLES,
  ENGINEER_SIDE_ROLES,
  type CaseEvent,
  type DecisionFork,
  type SourceRef,
  type TemporalFinding,
  type TemporalRule,
} from '@caseguard/schemas';
import type { CompiledPack } from '../knowledge/compile';
import { stableId } from '../util/ids';
import { resolveAction, type ResolvedAction } from './actions';
import type { BeliefTimeline } from './belief';
import { satisfiedSetAt, type RequirementState } from './requirements';
import type { Observation } from './signals';
import { sourcePointerFor } from './source-ref';
import type { TemporalView } from './temporal';

/**
 * Findings that need more than one event (wave 2): a request that was never answered before the case moved on, a step
 * done only after escalation, a step repeated after it failed, a hypothesis pursued after the evidence had ruled it
 * out, a correction that changed the leading cause, and the earliest moment a better step was available.
 *
 * Every finding is anchored at the event that makes it true (`asOf`) and names the events it considered, so it is
 * computed from a temporal view and can never use anything said later: a view cut at the anchor produces the same
 * finding, a view cut before it produces none.
 */

export interface SequenceInput {
  view: TemporalView;
  pack: CompiledPack;
  caseId: string;
  observations: readonly Observation[];
  timeline: BeliefTimeline;
  requirementStates: readonly RequirementState[];
  forks: readonly DecisionFork[];
}

const isEngineer = (event: CaseEvent): boolean =>
  ENGINEER_SIDE_ROLES.includes(event.participantRole);
const isCustomer = (event: CaseEvent): boolean =>
  CUSTOMER_SIDE_ROLES.includes(event.participantRole);

const hhmm = (event: CaseEvent): string => event.timestamp.slice(11, 16);

function eventRef(
  event: CaseEvent,
  role: string,
  action: ResolvedAction | null = null,
): TemporalFinding['events'][number] {
  const span = action?.span ?? null;
  const sourceRef: SourceRef = {
    eventId: event.id,
    sourceId: event.sourceId,
    pointer: sourcePointerFor(event, span?.field ?? null),
    ...(span ? { field: span.field, start: span.start, end: span.end } : {}),
    ...(action?.excerpt ? { excerpt: action.excerpt.slice(0, 600) } : {}),
  };
  return { eventId: event.id, timestamp: event.timestamp, role, sourceRef };
}

function finding(
  caseId: string,
  rule: TemporalRule,
  anchor: CaseEvent,
  events: TemporalFinding['events'],
  knownThen: string,
  conclusion: string,
  level: 'low' | 'medium' | 'high',
  note: string,
  evidenceIds: readonly string[] = [],
): TemporalFinding {
  return {
    id: stableId('seq', caseId, rule, ...events.map((e) => e.eventId)),
    rule,
    events: events.slice(0, 12),
    asOf: anchor.timestamp,
    knownThen: knownThen.slice(0, 500),
    conclusion: conclusion.slice(0, 500),
    uncertainty: { level, note: note.slice(0, 300) },
    evidenceIds: evidenceIds.slice(0, 20),
  };
}

const labelOf = (pack: CompiledPack, key: string): string => pack.actions.get(key)?.label ?? key;

/** A step the customer was asked for, and the case went on to escalate or close with no reply on record. */
export function requestedNeverCompleted(input: SequenceInput): TemporalFinding[] {
  const { view, pack, caseId } = input;
  const out: TemporalFinding[] = [];
  view.events.forEach((request, i) => {
    if (!isEngineer(request)) return;
    const asked = resolveAction(request, pack);
    const action = asked ? pack.actions.get(asked.key) : undefined;
    if (!asked || !action || action.executor === 'engineer' || action.executor === 'system') return;
    for (const next of view.events.slice(i + 1)) {
      if (isCustomer(next)) return;
      if (next.type !== 'escalation' && next.type !== 'resolution_note') continue;
      out.push(
        finding(
          caseId,
          'requested_never_completed',
          next,
          [eventRef(request, 'request', asked), eventRef(next, 'moved on')],
          `At ${hhmm(request)} UTC the customer side was asked to do this: ${action.label}. No reply from the customer is on record between then and ${hhmm(next)} UTC.`,
          `The case ${next.type === 'escalation' ? 'was escalated' : 'was closed'} while the request for “${action.label}” had no reply on record.`,
          'medium',
          'The customer may have done it and said nothing in the record; the case record cannot show that.',
        ),
      );
      return;
    }
  });
  return out;
}

/** A low-risk diagnostic step that could have been taken before escalating, taken only afterwards. */
export function stepOnlyAfterEscalation(input: SequenceInput): TemporalFinding[] {
  const { view, pack, caseId, requirementStates } = input;
  const events = view.events;
  const escalationKeys = new Set(pack.pack.policies.escalationActionIds);
  const at = events.findIndex((event) => {
    if (!isEngineer(event)) return false;
    if (event.type === 'escalation') return true;
    const key = resolveAction(event, pack)?.key;
    return key !== undefined && escalationKeys.has(key);
  });
  const escalation = events[at];
  if (at < 0 || !escalation) return [];
  const done = new Set<string>();
  for (const event of events.slice(0, at)) {
    const key = resolveAction(event, pack)?.key;
    if (key) done.add(key);
  }
  const known = satisfiedSetAt(requirementStates, at - 1);
  const out: TemporalFinding[] = [];
  for (const event of events.slice(at + 1)) {
    if (!isEngineer(event)) continue;
    const taken = resolveAction(event, pack);
    const action = taken ? pack.actions.get(taken.key) : undefined;
    if (!taken || !action || done.has(taken.key)) continue;
    if (action.valueClass !== 'diagnostic' || action.destructive || action.requiresApproval)
      continue;
    if (action.operationalRisk > 0.3 || !action.requires.every((r) => known.has(r))) continue;
    done.add(taken.key);
    out.push(
      finding(
        caseId,
        'step_only_after_escalation',
        event,
        [eventRef(escalation, 'escalation'), eventRef(event, 'step taken afterwards', taken)],
        `At ${hhmm(escalation)} UTC the case was escalated. Everything this step needs was already in the record then, and it is low risk.`,
        `“${action.label}” was done at ${hhmm(event)} UTC, after the escalation, though it could have been done before it.`,
        'medium',
        'The engineer may have had a reason not on record, such as access or time.',
      ),
    );
  }
  return out;
}

/** The ids of the signals that report that a step did not help. */
const ineffectiveSignals = (pack: CompiledPack, key: string): Set<string> =>
  new Set(
    (pack.actions.get(key)?.outcomes ?? [])
      .filter((outcome) => outcome.ineffective === true)
      .flatMap((outcome) => outcome.emitsSignals),
  );

/** A step that was reported not to have helped, asked for again. */
export function failedStepRepeated(input: SequenceInput): TemporalFinding[] {
  const { view, pack, caseId, observations } = input;
  const events = view.events;
  const out: TemporalFinding[] = [];
  const reported = new Set<string>();
  events.forEach((again, i) => {
    if (!isEngineer(again)) return;
    const second = resolveAction(again, pack);
    if (!second || reported.has(second.key)) return;
    const failed = ineffectiveSignals(pack, second.key);
    if (failed.size === 0) return;
    for (let j = 0; j < i; j += 1) {
      const first = events[j];
      if (!first || !isEngineer(first)) continue;
      const earlier = resolveAction(first, pack);
      if (earlier?.key !== second.key) continue;
      const outcome = observations.find(
        (o) => o.eventIndex > j && o.eventIndex < i && failed.has(o.signalId),
      );
      if (!outcome) continue;
      const reply = events[outcome.eventIndex];
      if (!reply) continue;
      reported.add(second.key);
      out.push(
        finding(
          caseId,
          'failed_step_repeated',
          again,
          [
            eventRef(first, 'first time', earlier),
            eventRef(reply, 'reported no effect'),
            eventRef(again, 'asked again', second),
          ],
          `“${labelOf(pack, second.key)}” was asked for at ${hhmm(first)} UTC and the reply at ${hhmm(reply)} UTC reported that it did not help.`,
          `The same step was asked for again at ${hhmm(again)} UTC.`,
          'medium',
          'A second attempt can be worth it when the first was done wrongly; the record does not say whether it was.',
          [outcome.id],
        ),
      );
      return;
    }
  });
  return out;
}

const posteriorBefore = (timeline: BeliefTimeline, index: number): Record<string, number> =>
  index <= 0 ? timeline.prior : (timeline.steps[index - 1]?.posterior ?? timeline.prior);

/** A hypothesis the evidence had ruled out, pursued with a step meant to test it. */
export function rejectedHypothesisReused(input: SequenceInput): TemporalFinding[] {
  const { view, pack, caseId, timeline } = input;
  const events = view.events;
  const out: TemporalFinding[] = [];
  const reported = new Set<string>();
  events.forEach((event, i) => {
    if (!isEngineer(event)) return;
    const taken = resolveAction(event, pack);
    const action = taken ? pack.actions.get(taken.key) : undefined;
    if (!taken || !action) return;
    const now = posteriorBefore(timeline, i);
    for (const hypothesisId of action.targets) {
      if (reported.has(hypothesisId) || (now[hypothesisId] ?? 1) >= 0.05) continue;
      let peak = 0;
      let ruledOutAt = -1;
      for (let k = 0; k < i; k += 1) {
        const p = timeline.steps[k]?.posterior[hypothesisId] ?? 0;
        if (p > peak) peak = p;
        if (peak >= 0.15 && p < 0.05 && ruledOutAt < 0) ruledOutAt = k;
      }
      const ruledOut = events[ruledOutAt];
      if (!ruledOut || peak < 0.15) continue;
      reported.add(hypothesisId);
      const name = pack.hypotheses.get(hypothesisId)?.name ?? hypothesisId;
      out.push(
        finding(
          caseId,
          'rejected_hypothesis_reused',
          event,
          [eventRef(ruledOut, 'ruled it out'), eventRef(event, 'pursued it again', taken)],
          `By ${hhmm(ruledOut)} UTC the evidence had made “${name}” very unlikely (it had been ${Math.round(peak * 100)}% at its highest).`,
          `At ${hhmm(event)} UTC the step “${action.label}”, which tests that cause, was taken.`,
          'medium',
          'The estimate comes from the pack’s illustrative likelihoods; a step can serve more than one purpose.',
        ),
      );
    }
  });
  return out;
}

/** A correction by the customer after which another cause leads. */
export function correctionChangedCause(input: SequenceInput): TemporalFinding[] {
  const { view, pack, caseId, observations, timeline } = input;
  const out: TemporalFinding[] = [];
  const lead = (belief: Record<string, number>): string | null =>
    Object.entries(belief).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  view.events.forEach((event, i) => {
    if (!isCustomer(event)) return;
    const corrected = observations.filter((o) => o.eventIndex === i && o.modality === 'corrected');
    const first = corrected[0];
    if (!first) return;
    const before = lead(posteriorBefore(timeline, i));
    const after = lead(timeline.steps[i]?.posterior ?? {});
    if (before === null || after === null || before === after) return;
    const name = (id: string): string => pack.hypotheses.get(id)?.name ?? id;
    out.push(
      finding(
        caseId,
        'customer_correction_changed_cause',
        event,
        [eventRef(event, 'correction')],
        `Before the correction at ${hhmm(event)} UTC the leading cause was “${name(before)}”.`,
        `After it the leading cause is “${name(after)}”.`,
        'medium',
        'The leading cause is a model estimate from the pack’s likelihoods and can move on later evidence.',
        corrected.map((o) => o.id),
      ),
    );
  });
  return out;
}

/** The earliest moment at which a clearly better step was available, from the decision forks. */
export function earliestMissedMoment(input: SequenceInput): TemporalFinding[] {
  const { view, caseId, forks } = input;
  const fork = forks.find((f) => f.isEarliestMeaningful);
  const decision = fork ? view.events.find((e) => e.id === fork.eventId) : undefined;
  if (!fork || !decision) return [];
  const known = fork.informationAvailable.eventIds
    .map((id) => view.events.find((e) => e.id === id))
    .filter((e): e is CaseEvent => e !== undefined && e.id !== decision.id)
    .slice(-4)
    .map((e) => eventRef(e, 'known then'));
  return [
    finding(
      caseId,
      'earliest_missed_moment',
      decision,
      [...known, eventRef(decision, 'decision')],
      fork.informationAvailable.summary,
      fork.title,
      fork.severity === 'high' ? 'low' : 'medium',
      'A judgement from the pack’s action values; a reviewer should confirm that the better step was practical.',
      fork.informationAvailable.evidenceIds,
    ),
  ];
}

/** The sequence findings of the view, in the order of the events that make them true. */
export function detectSequenceFindings(input: SequenceInput): TemporalFinding[] {
  return [
    ...requestedNeverCompleted(input),
    ...stepOnlyAfterEscalation(input),
    ...failedStepRepeated(input),
    ...rejectedHypothesisReused(input),
    ...correctionChangedCause(input),
    ...earliestMissedMoment(input),
  ].sort((a, b) => a.asOf.localeCompare(b.asOf) || a.id.localeCompare(b.id));
}
