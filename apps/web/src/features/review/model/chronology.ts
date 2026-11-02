import {
  CUSTOMER_SIDE_ROLES,
  ENGINEER_SIDE_ROLES,
  EVENT_TYPE_LABELS,
  PARTICIPANT_ROLE_LABELS,
  type ForkListResponse,
  type ParticipantRole,
  type TimelineEvent,
} from '@caseguard/schemas';
import { formatDateTimeUtc, formatDayMonthUtc } from '@caseguard/ui';
import { minutesBetween } from '../../reasoning/time';
import { orderForks } from './forks';
import { describeSpan, plural } from './words';

export type LaneId = 'customer' | 'engineer' | 'system';

export const LANES: readonly { id: LaneId; label: string; description: string }[] = [
  { id: 'customer', label: 'Customer', description: 'Customer administrators and end users' },
  {
    id: 'engineer',
    label: 'Engineer',
    description: 'Support engineers, escalation engineers and support managers',
  },
  { id: 'system', label: 'System', description: 'Automated events and status changes' },
];

export function laneOfRole(role: ParticipantRole): LaneId {
  if (CUSTOMER_SIDE_ROLES.includes(role)) return 'customer';
  if (ENGINEER_SIDE_ROLES.includes(role)) return 'engineer';
  return 'system';
}

/** Why an event is on the list of key events. */
export type KeyReason =
  'opened' | 'decision' | 'escalation' | 'validation' | 'resolution' | 'closed';

export const KEY_REASON_WORDS: Record<KeyReason, string> = {
  opened: 'Case opened',
  decision: 'Decision point',
  escalation: 'Escalation',
  validation: 'Fix validated',
  resolution: 'Resolution',
  closed: 'Last event',
};

export interface ChronologyEvent {
  id: string;
  at: string;
  lane: LaneId;
  laneLabel: string;
  roleLabel: string;
  typeLabel: string;
  title: string;
  /** Position along the strip, from 0 (first event) to 1 (last event), on the compressed scale of `compressedPositions`. */
  position: number;
  reasons: KeyReason[];
  /** The numbers (from 1, earliest first) of the decision points taken at this event. */
  decisionNumbers: number[];
}

export interface Wait {
  fromEventId: string;
  toEventId: string;
  fromAt: string;
  toAt: string;
  fromTitle: string;
  toTitle: string;
  minutes: number;
  waiter: 'customer' | 'engineer' | 'nobody';
  /** `The customer waited 15 hours 10 minutes for a reply.` */
  text: string;
  fromPosition: number;
  toPosition: number;
}

export interface Chronology {
  /** Every event of the case, so the reader sees how many there are; only the key ones are listed. */
  total: number;
  start: string | null;
  end: string | null;
  spanMinutes: number;
  /** The key events, in time order. */
  events: ChronologyEvent[];
  /** The positions of the events that are not key, for the quiet ticks of the strip. */
  otherPositions: { id: string; lane: LaneId; position: number }[];
  waits: Wait[];
  decisionPoints: { number: number; forkId: string; eventId: string; at: string; title: string }[];
  /** True when the case has a recorded resolution or ended with one. */
  resolved: boolean;
  /** Where each UTC day begins along the strip, for the axis. */
  dayMarks: { label: string; position: number }[];
  /** The strip and the list in one paragraph, for people who do not see the strip. */
  summary: string;
}

const KEY_TYPES: Partial<Record<TimelineEvent['type'], KeyReason>> = {
  escalation: 'escalation',
  escalation_response: 'escalation',
  validation_result: 'validation',
  resolution_note: 'resolution',
};

/** Who waited on whom, from the lanes on either side of a gap. */
function whoWaited(before: LaneId, after: LaneId): Wait['waiter'] {
  if (before === 'customer' && after !== 'customer') return 'customer';
  if (before === 'engineer' && after === 'customer') return 'engineer';
  return 'nobody';
}

function waitSentence(waiter: Wait['waiter'], minutes: number): string {
  const span = describeSpan(minutes);
  if (waiter === 'customer') return `The customer waited ${span} for a reply.`;
  if (waiter === 'engineer') return `The engineer waited ${span} for the customer.`;
  return `Nothing was recorded for ${span}.`;
}

const timeOrder = (a: TimelineEvent, b: TimelineEvent): number =>
  Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.sequence - b.sequence;

/** A quarter of an hour is added to every gap before its square root is taken, so simultaneous events still part. */
export const SPACING_FLOOR_MINUTES = 15;

/**
 * Where each event sits along the strip, from 0 to 1. The room a gap takes grows with the square root of its length (plus
 * a quarter hour), not with the length itself: on a true time scale a burst of events within half an hour lands on top
 * of each other beside a wait of a day. The strip says that its spacing is not to scale; the waits are shaded and named.
 */
export function compressedPositions(ordered: readonly TimelineEvent[]): Map<string, number> {
  const weights = ordered.map((event, index) => {
    const before = ordered[index - 1];
    if (!before) return 0;
    return Math.sqrt(
      Math.max(0, minutesBetween(before.timestamp, event.timestamp)) + SPACING_FLOOR_MINUTES,
    );
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let run = 0;
  return new Map(
    ordered.map((event, index) => {
      run += weights[index] ?? 0;
      return [event.id, total === 0 ? 0.5 : run / total] as const;
    }),
  );
}

/**
 * The chronology of the case for the strip and its text alternative.
 *
 * Key events are the first event, every event where a decision point was found, escalations and their answers, the
 * validation of the fix, the resolution and the last event. A meaningful wait is a gap the engine flagged as a delay
 * (`isDelay`); its length is measured from the two timestamps and its sentence says who was waiting, from the sides the
 * two events came from.
 */
export function deriveChronology(
  events: readonly TimelineEvent[],
  forks: ForkListResponse | null,
  resolvedAt: string | null = null,
): Chronology {
  const ordered = [...events].sort(timeOrder);
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  if (!first || !last) {
    return {
      total: 0,
      start: null,
      end: null,
      spanMinutes: 0,
      events: [],
      otherPositions: [],
      waits: [],
      decisionPoints: [],
      resolved: resolvedAt !== null,
      dayMarks: [],
      summary: 'No events were recorded for this case.',
    };
  }
  const span = Date.parse(last.timestamp) - Date.parse(first.timestamp);
  const positions = compressedPositions(ordered);
  const positionOf = (id: string): number => positions.get(id) ?? 0.5;

  const decisionPoints = orderForks(forks?.items ?? []).map((fork, index) => ({
    number: index + 1,
    forkId: fork.id,
    eventId: fork.eventId,
    at: fork.timestamp,
    title: fork.title,
  }));
  const numbersOf = (event: TimelineEvent): number[] =>
    decisionPoints
      .filter((point) => point.eventId === event.id || event.forkIds.includes(point.forkId))
      .map((point) => point.number);

  const keyEvents: ChronologyEvent[] = [];
  const otherPositions: Chronology['otherPositions'] = [];
  for (const event of ordered) {
    const reasons: KeyReason[] = [];
    const numbers = numbersOf(event);
    if (event === first) reasons.push('opened');
    if (numbers.length > 0) reasons.push('decision');
    const typed = KEY_TYPES[event.type];
    if (typed) reasons.push(typed);
    if (event === last && !reasons.includes('resolution')) reasons.push('closed');
    const lane = laneOfRole(event.participantRole);
    if (reasons.length === 0) {
      otherPositions.push({ id: event.id, lane, position: positionOf(event.id) });
      continue;
    }
    keyEvents.push({
      id: event.id,
      at: event.timestamp,
      lane,
      laneLabel: LANES.find((item) => item.id === lane)?.label ?? lane,
      roleLabel: PARTICIPANT_ROLE_LABELS[event.participantRole],
      typeLabel: EVENT_TYPE_LABELS[event.type],
      title: event.title?.trim() || EVENT_TYPE_LABELS[event.type],
      position: positionOf(event.id),
      reasons,
      decisionNumbers: numbers,
    });
  }

  const waits: Wait[] = [];
  ordered.forEach((event, index) => {
    const before = ordered[index - 1];
    if (!before || !event.isDelay) return;
    const minutes = minutesBetween(before.timestamp, event.timestamp);
    const waiter = whoWaited(laneOfRole(before.participantRole), laneOfRole(event.participantRole));
    waits.push({
      fromEventId: before.id,
      toEventId: event.id,
      fromAt: before.timestamp,
      toAt: event.timestamp,
      fromTitle: before.title?.trim() || EVENT_TYPE_LABELS[before.type],
      toTitle: event.title?.trim() || EVENT_TYPE_LABELS[event.type],
      minutes,
      waiter,
      text: waitSentence(waiter, minutes),
      fromPosition: positionOf(before.id),
      toPosition: positionOf(event.id),
    });
  });

  const resolved = resolvedAt !== null || ordered.some((event) => event.type === 'resolution_note');
  const dayMarks: Chronology['dayMarks'] = [];
  let currentDay = '';
  for (const event of ordered) {
    const day = event.timestamp.slice(0, 10);
    if (day === currentDay) continue;
    currentDay = day;
    dayMarks.push({ label: formatDayMonthUtc(event.timestamp), position: positionOf(event.id) });
  }
  const longest = [...waits].sort((a, b) => b.minutes - a.minutes)[0];
  const parts = [
    `${plural(ordered.length, 'event')} over ${describeSpan(span / 60_000)}, from ${formatDateTimeUtc(first.timestamp)} to ${formatDateTimeUtc(last.timestamp)}.`,
    `${plural(keyEvents.length, 'key event')} listed below.`,
    decisionPoints.length > 0
      ? `${plural(decisionPoints.length, 'decision point')} where a better-supported step was available.`
      : 'No decision point stood out.',
    waits.length > 0
      ? `${plural(waits.length, 'meaningful wait')}; the longest: ${longest?.text.toLowerCase().replace(/\.$/, '') ?? ''}.`
      : 'No meaningful waits.',
  ];

  return {
    total: ordered.length,
    start: first.timestamp,
    end: last.timestamp,
    spanMinutes: span / 60_000,
    events: keyEvents,
    otherPositions,
    waits,
    decisionPoints,
    resolved,
    dayMarks,
    summary: parts.join(' '),
  };
}

/** The key events and the waits between them in one time order, for the list that is the text alternative. */
export type ChronologyRow =
  { kind: 'event'; at: string; event: ChronologyEvent } | { kind: 'wait'; at: string; wait: Wait };

export function chronologyRows(chronology: Chronology): ChronologyRow[] {
  const rows: ChronologyRow[] = [
    ...chronology.events.map((event) => ({ kind: 'event' as const, at: event.at, event })),
    ...chronology.waits.map((wait) => ({ kind: 'wait' as const, at: wait.fromAt, wait })),
  ];
  // A wait that starts at the moment of an event comes after that event.
  return rows.sort(
    (a, b) =>
      Date.parse(a.at) - Date.parse(b.at) || (a.kind === b.kind ? 0 : a.kind === 'event' ? -1 : 1),
  );
}
