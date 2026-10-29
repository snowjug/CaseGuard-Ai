import type {
  Case,
  CaseEvent,
  CounterfactualScenario,
  TimelineEvent,
  TimelineResponse,
} from '@caseguard/schemas';
import { round } from '../util/math';
import { formatDuration, minutesBetween } from '../util/time';
import { knownAt, lastStepAt } from './as-of';
import { isCustomerSide } from './context';
import type { DeterministicAnalysis } from './pipeline';

/** Gaps at or above this many minutes are marked as delays on the timeline. */
export const DELAY_MINUTES = 240;
const EXCERPT_LIMIT = 500;

/** Groups items by key, keeping their order, in one linear pass. */
function groupBy<T>(items: readonly T[], keyOf: (item: T) => string | null): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    if (key === null) continue;
    const list = groups.get(key);
    if (list) list.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

export interface TimelineInput {
  caseRecord: Pick<Case, 'id' | 'openedAt'>;
  events: readonly CaseEvent[];
  analysis: DeterministicAnalysis;
  asOf: string | null;
  scenario?: CounterfactualScenario | null;
  offset?: number;
  limit?: number;
  /** Open live-warning count at `asOf`, supplied by the warnings engine. */
  openWarningCount?: number;
}

export function buildTimelineResponse(input: TimelineInput): TimelineResponse {
  const { caseRecord, events, analysis, asOf, scenario } = input;
  const known = knownAt(asOf);
  const visible = events.filter((e) => known(e.timestamp));
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 200;

  const actionByEvent = new Map(analysis.actions.map((a) => [a.eventId, a]));
  const forksByEvent = groupBy(analysis.forks, (f) => f.eventId);
  const claimsByEvent = groupBy(analysis.claims, (c) => c.eventId);
  const evidenceByEvent = groupBy(analysis.evidence, (ev) => ev.eventId);
  const stepByEvent = new Map(analysis.timeline.steps.map((s) => [s.eventId, s]));
  const hypRecordByKey = new Map(analysis.hypotheses.map((h) => [h.key, h.id]));

  const delays: TimelineResponse['delays'] = [];
  const timelineEvents: TimelineEvent[] = visible.map((event, i) => {
    const prev = visible[i - 1];
    const gap = prev ? Math.max(0, minutesBetween(prev.timestamp, event.timestamp)) : null;
    const action = actionByEvent.get(event.id);
    const isDelay = gap !== null && gap >= DELAY_MINUTES;
    if (prev && isDelay && gap !== null) {
      const customerWaiting =
        isCustomerSide(prev.participantRole) && !isCustomerSide(event.participantRole);
      delays.push({
        fromEventId: prev.id,
        toEventId: event.id,
        minutes: round(gap, 0),
        reason: customerWaiting
          ? `The customer waited ${formatDuration(gap)} for a reply.`
          : isCustomerSide(event.participantRole)
            ? `The engineer waited ${formatDuration(gap)} for the customer.`
            : `No activity for ${formatDuration(gap)}.`,
      });
    }
    const step = stepByEvent.get(event.id);
    const effects = step
      ? step.effects
          .flatMap((eff) =>
            Object.entries(eff.delta)
              .filter(([, d]) => Math.abs(d) >= 0.02)
              .map(([key, delta]) => ({ key, delta })),
          )
          .reduce<Map<string, number>>(
            (acc, { key, delta }) => acc.set(key, (acc.get(key) ?? 0) + delta),
            new Map(),
          )
      : new Map<string, number>();
    const claims = claimsByEvent.get(event.id) ?? [];
    const body = event.body.replace(/\s+/g, ' ').trim();
    return {
      id: event.id,
      sequence: event.sequence,
      timestamp: event.timestamp,
      type: event.type,
      participantRole: event.participantRole,
      participantAlias: event.participantAlias,
      title: event.title,
      bodyExcerpt: body.slice(0, EXCERPT_LIMIT),
      bodyTruncated: body.length > EXCERPT_LIMIT,
      actionKey: action?.actionKey ?? null,
      actionLabel: action?.label ?? null,
      actionKind: action?.kind ?? null,
      customerEffort: action ? action.customerEffort : null,
      destructive: action?.destructive ?? false,
      gapMinutes: gap === null ? null : round(gap, 0),
      isDelay,
      isRepeatedDiagnostic: action?.isRepeat ?? false,
      forkIds: (forksByEvent.get(event.id) ?? []).map((f) => f.id),
      claimIds: claims.map((c) => c.id),
      evidenceIds: (evidenceByEvent.get(event.id) ?? []).map((e) => e.id),
      categories: [...new Set(claims.map((c) => c.category))],
      hypothesisEffects: [...effects.entries()]
        .filter(([key]) => hypRecordByKey.has(key))
        .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
        .slice(0, 3)
        .map(([key, delta]) => ({
          hypothesisId: hypRecordByKey.get(key) ?? key,
          delta: round(delta, 3),
        })),
      aiTokens: event.ai ? event.ai.promptTokens + event.ai.completionTokens : null,
      simulated: false,
    };
  });

  const repeats = analysis.actions
    .filter((a) => a.isRepeat && a.repeatOfActionId && known(a.startedAt))
    .map((a) => {
      const original = analysis.actions.find((o) => o.id === a.repeatOfActionId);
      return {
        eventId: a.eventId,
        repeatOfEventId: original?.eventId ?? a.eventId,
        actionKey: a.actionKey,
      };
    });

  // Rank by what was believed at `asOf`, never by the final confidence: an as-of view that listed the
  // eventual winner first would leak the outcome. The last visible step is exactly where a replay of
  // the prefix ends, so the order matches a faithful as-of re-analysis.
  const lastVisibleStep = lastStepAt(analysis.timeline.steps, known);
  const hypothesisSeries = analysis.hypotheses
    .map((h) => ({
      h,
      confidenceAsOf: lastVisibleStep ? round(lastVisibleStep.posterior[h.key] ?? 0, 3) : h.prior,
    }))
    .sort((a, b) => b.confidenceAsOf - a.confidenceAsOf)
    .slice(0, 5)
    .map(({ h }) => ({
      hypothesisId: h.id,
      key: h.key,
      name: h.name,
      points: h.timeline
        .filter((p) => known(p.at))
        .map((p) => ({ at: p.at, confidence: p.confidence })),
    }));

  const evidenceKnown = analysis.evidence.filter((e) => known(e.observedAt));
  const missingOpen = analysis.missing.filter(
    (m) =>
      known(m.firstRelevantAt) &&
      m.criticality === 'critical' &&
      !(m.resolvedAt !== null && known(m.resolvedAt)),
  );

  const page = timelineEvents.slice(offset, offset + limit);
  return {
    caseId: caseRecord.id,
    asOf,
    openedAt: caseRecord.openedAt,
    events: page,
    nextCursor: offset + limit < timelineEvents.length ? String(offset + limit) : null,
    total: timelineEvents.length,
    simulatedEvents: (scenario?.steps ?? []).map((s) => ({
      id: `sim_${s.id}`,
      scenarioId: s.scenarioId,
      stepIndex: s.index,
      timestamp: s.simulatedAt,
      label: s.label,
      actionKey: s.actionKey,
      actionKind: s.kind,
      customerEffort: s.customerEffort,
      outcomeLabel: s.predictedOutcome.label,
      probability: s.predictedOutcome.probability,
      simulated: true as const,
    })),
    delays: delays.filter((d) => page.some((e) => e.id === d.toEventId)),
    repeats: repeats.filter((r) => page.some((e) => e.id === r.eventId)),
    hypothesisSeries,
    withheldFutureEventCount: events.length - visible.length,
    knownAtAsOf: {
      evidenceCount: evidenceKnown.length,
      claimCount: analysis.claims.filter((c) => known(c.timestamp)).length,
      criticalMissingCount: missingOpen.length,
      openWarningCount: input.openWarningCount ?? 0,
    },
  };
}
