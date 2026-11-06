import {
  EVENT_TYPES,
  EVIDENCE_CATEGORIES,
  PARTICIPANT_ROLES,
  type EventType,
  type EvidenceCategory,
  type ParticipantRole,
  type SimulatedTimelineEvent,
  type TimelineEvent,
} from '@caseguard/schemas';
import { codecs, type UrlCodec } from '../../lib/url-state';

/** Events requested per page (the API maximum). Long cases load further pages as the list is scrolled. */
export const PAGE_SIZE = 200;

export const FLAGS = ['delay', 'repeat', 'fork'] as const;
export type TimelineFlag = (typeof FLAGS)[number];

export const FLAG_LABELS: Record<TimelineFlag, string> = {
  delay: 'Delays',
  repeat: 'Repeated diagnostics',
  fork: 'Key decisions',
};

/** A comma-separated URL list restricted to known values, so a hostile or stale address never reaches the API. */
function knownList<const V extends readonly string[]>(values: V): UrlCodec<V[number][]> {
  const base = codecs.stringList();
  const known = new Set<string>(values);
  return {
    parse: (raw) => base.parse(raw).filter((item): item is V[number] => known.has(item)),
    serialize: (value) => base.serialize([...new Set(value)]),
  };
}

export const TIMELINE_FILTERS = {
  types: knownList(EVENT_TYPES),
  roles: knownList(PARTICIPANT_ROLES),
  category: codecs.enumOf(['all', ...EVIDENCE_CATEGORIES] as const, 'all'),
  hyp: codecs.optionalString(),
  flags: knownList(FLAGS),
  from: codecs.isoTimestamp(),
  to: codecs.isoTimestamp(),
  scenario: codecs.optionalString(),
} as const;

export interface TimelineFilterValues {
  types: EventType[];
  roles: ParticipantRole[];
  category: 'all' | EvidenceCategory;
  hyp: string | null;
  flags: TimelineFlag[];
  from: string | null;
  to: string | null;
  scenario: string | null;
}

/** The filters the server applies (`timeline.get`). Delay, repeat and fork flags are applied on the loaded events. */
export function timelineQuery(
  filters: TimelineFilterValues,
  asOf: string | null,
): {
  limit: number;
  asOf?: string;
  types?: string;
  roles?: string;
  category?: EvidenceCategory;
  hypothesisId?: string;
  from?: string;
  to?: string;
  scenarioId?: string;
} {
  return {
    limit: PAGE_SIZE,
    ...(asOf ? { asOf } : {}),
    ...(filters.types.length > 0 ? { types: filters.types.join(',') } : {}),
    ...(filters.roles.length > 0 ? { roles: filters.roles.join(',') } : {}),
    ...(filters.category !== 'all' ? { category: filters.category } : {}),
    ...(filters.hyp ? { hypothesisId: filters.hyp } : {}),
    ...(filters.from ? { from: filters.from } : {}),
    ...(filters.to ? { to: filters.to } : {}),
    ...(filters.scenario ? { scenarioId: filters.scenario } : {}),
  };
}

/** Number of narrowing filters in use (flags and the zoom window included). */
export function activeFilterCount(filters: TimelineFilterValues): number {
  return (
    (filters.types.length > 0 ? 1 : 0) +
    (filters.roles.length > 0 ? 1 : 0) +
    (filters.category !== 'all' ? 1 : 0) +
    (filters.hyp ? 1 : 0) +
    (filters.flags.length > 0 ? 1 : 0) +
    (filters.from || filters.to ? 1 : 0)
  );
}

/** Keeps events that carry every selected flag (delay, repeated diagnostic, decision fork). */
export function matchesFlags(
  event: Pick<TimelineEvent, 'isDelay' | 'isRepeatedDiagnostic' | 'forkIds'>,
  flags: readonly TimelineFlag[],
): boolean {
  return flags.every((flag) => {
    if (flag === 'delay') return event.isDelay;
    if (flag === 'repeat') return event.isRepeatedDiagnostic;
    return event.forkIds.length > 0;
  });
}

/** One row of the list: a recorded event, or a simulated step of the overlaid scenario. */
export type TimelineRow =
  | { kind: 'event'; id: string; at: string; event: TimelineEvent }
  | { kind: 'simulated'; id: string; at: string; step: SimulatedTimelineEvent };

/** Interleaves simulated steps with recorded events by time; at the same instant the recorded event comes first. */
export function mergeRows(
  events: readonly TimelineEvent[],
  simulated: readonly SimulatedTimelineEvent[],
): TimelineRow[] {
  const rows: TimelineRow[] = [
    ...events.map((event): TimelineRow => ({
      kind: 'event',
      id: event.id,
      at: event.timestamp,
      event,
    })),
    ...simulated.map((step): TimelineRow => ({
      kind: 'simulated',
      id: step.id,
      at: step.timestamp,
      step,
    })),
  ];
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const order = Date.parse(a.row.at) - Date.parse(b.row.at);
      if (order !== 0) return order;
      if (a.row.kind !== b.row.kind) return a.row.kind === 'event' ? -1 : 1;
      return a.index - b.index;
    })
    .map((entry) => entry.row);
}

/** A window of one event on each side of `index`: where the decision at that event was taken. */
export function decisionWindow(
  events: readonly Pick<TimelineEvent, 'timestamp'>[],
  index: number,
): { from: string; to: string } | null {
  const here = events[index];
  if (!here) return null;
  const before = events[index - 1] ?? here;
  const after = events[index + 1] ?? here;
  return { from: before.timestamp, to: after.timestamp };
}
