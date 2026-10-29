import {
  EVENT_TYPES,
  PARTICIPANT_ROLES,
  type EventType,
  type EvidenceCategory,
  type ParticipantRole,
  type TimelineEvent,
} from '@caseguard/schemas';
import { ValidationFailedError } from '../../errors';

export interface TimelineFilters {
  readonly types: ReadonlySet<EventType> | null;
  readonly roles: ReadonlySet<ParticipantRole> | null;
  readonly category: EvidenceCategory | null;
  /** The hypothesis the events must bear on; null for no filter. */
  readonly hypothesisId: string | null;
  /** Inclusive zoom window in epoch milliseconds, already clamped to the `asOf` boundary. */
  readonly fromMs: number | null;
  readonly toMs: number | null;
}

export interface TimelineFilterQuery {
  readonly types?: string | undefined;
  readonly roles?: string | undefined;
  readonly category?: EvidenceCategory | undefined;
  readonly hypothesisId?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

/** A comma-separated list of known values; unknown ones are a 422 naming what is allowed. */
export function parseCsvFilter<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  field: string,
): ReadonlySet<T> | null {
  const tokens = (raw ?? '')
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token !== '');
  if (tokens.length === 0) return null;
  const isAllowed = (token: string): token is T => allowed.some((value) => value === token);
  const valid = tokens.filter(isAllowed);
  if (valid.length !== tokens.length) {
    throw new ValidationFailedError(`Unknown value for ${field}`, [
      { path: `query.${field}`, message: `Use a comma-separated list of: ${allowed.join(', ')}` },
    ]);
  }
  return new Set(valid);
}

/** Parses and validates the timeline filters; the zoom window never reaches beyond `asOf`. */
export function parseTimelineFilters(
  query: TimelineFilterQuery,
  asOf: string | null,
): TimelineFilters {
  const from = query.from === undefined ? null : Date.parse(query.from);
  const requestedTo = query.to === undefined ? null : Date.parse(query.to);
  if (from !== null && requestedTo !== null && from > requestedTo) {
    throw new ValidationFailedError('The zoom window is reversed', [
      { path: 'query.from', message: 'from must not be after to' },
    ]);
  }
  const boundary = asOf === null ? null : Date.parse(asOf);
  const toMs =
    requestedTo === null
      ? boundary
      : boundary === null
        ? requestedTo
        : Math.min(requestedTo, boundary);
  return {
    types: parseCsvFilter(query.types, EVENT_TYPES, 'types'),
    roles: parseCsvFilter(query.roles, PARTICIPANT_ROLES, 'roles'),
    category: query.category ?? null,
    hypothesisId: query.hypothesisId ?? null,
    fromMs: from,
    toMs,
  };
}

/** The part of a timeline event the filters read. */
export type FilterableEvent = Pick<
  TimelineEvent,
  'id' | 'timestamp' | 'type' | 'participantRole' | 'categories'
>;

/**
 * Keeps the events that match every filter. `relatedEventIds` is the set of events that bear on the
 * requested hypothesis (null when that filter is off).
 */
export function applyTimelineFilters<T extends FilterableEvent>(
  events: readonly T[],
  filters: TimelineFilters,
  relatedEventIds: ReadonlySet<string> | null,
): T[] {
  return events.filter((event) => {
    const at = Date.parse(event.timestamp);
    return (
      (filters.types === null || filters.types.has(event.type)) &&
      (filters.roles === null || filters.roles.has(event.participantRole)) &&
      (filters.category === null || event.categories.includes(filters.category)) &&
      (relatedEventIds === null || relatedEventIds.has(event.id)) &&
      (filters.fromMs === null || at >= filters.fromMs) &&
      (filters.toMs === null || at <= filters.toMs)
    );
  });
}
