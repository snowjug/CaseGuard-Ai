import type { CaseEvent, CaseResolution } from '@caseguard/schemas';
import { hashJson } from '../util/ids';
import { compareIso } from '../util/time';

/**
 * Temporal integrity gatekeeper (ADR-0007).
 *
 * Every analysis that must respect "information available at time T" accepts ONLY a TemporalView.
 * The brand makes it impossible to hand such a function a raw event array, and the single factory
 * below is the only place where the boundary is applied. The final resolution is carried only when
 * the boundary has reached it.
 */
declare const temporalBrand: unique symbol;

export interface TemporalView {
  readonly [temporalBrand]: true;
  /** Inclusive upper bound (or exclusive when `mode` is 'before'). */
  readonly asOf: string;
  readonly mode: 'at' | 'before';
  /** Events visible inside the boundary, ordered by (timestamp, sequence). */
  readonly events: readonly CaseEvent[];
  /** Always null unless the boundary has passed the resolution time. */
  readonly resolution: CaseResolution | null;
  /** Count of events withheld because they lie beyond the boundary (never their content). */
  readonly withheldFutureEventCount: number;
  /** Stable digest of the visible event ids; recorded on scenarios as the boundary fingerprint. */
  readonly fingerprint: string;
}

/** A view that can never contain the final resolution (used by counterfactual generation). */
export type PreResolutionView = TemporalView & { readonly resolution: null };

export interface TemporalViewOptions {
  /** 'at' keeps events with timestamp <= asOf; 'before' keeps timestamp < asOf (decision moment). */
  mode?: 'at' | 'before';
  resolution?: CaseResolution | null;
}

export function createTemporalView(
  events: readonly CaseEvent[],
  asOf: string,
  options: TemporalViewOptions = {},
): TemporalView {
  const mode = options.mode ?? 'at';
  const sorted = [...events].sort(
    (a, b) => compareIso(a.timestamp, b.timestamp) || a.sequence - b.sequence,
  );
  const visible = sorted.filter((e) =>
    mode === 'at' ? compareIso(e.timestamp, asOf) <= 0 : compareIso(e.timestamp, asOf) < 0,
  );
  const resolution =
    options.resolution && compareIso(options.resolution.resolvedAt, asOf) <= 0 && mode === 'at'
      ? options.resolution
      : null;
  return {
    asOf,
    mode,
    events: visible,
    resolution,
    withheldFutureEventCount: sorted.length - visible.length,
    fingerprint: hashJson(visible.map((e) => e.id)),
  } as unknown as TemporalView;
}

/**
 * View of everything strictly before one event (the decision moment of that event): events ordered
 * before it by (timestamp, sequence). Never contains the event itself, later events or the resolution.
 */
export function createTemporalViewBeforeEvent(
  events: readonly CaseEvent[],
  eventId: string,
): PreResolutionView {
  const target = events.find((e) => e.id === eventId);
  if (!target) throw new Error(`Unknown event "${eventId}" for temporal view`);
  const sorted = [...events].sort(
    (a, b) => compareIso(a.timestamp, b.timestamp) || a.sequence - b.sequence,
  );
  const visible = sorted.filter(
    (e) =>
      compareIso(e.timestamp, target.timestamp) < 0 ||
      (compareIso(e.timestamp, target.timestamp) === 0 && e.sequence < target.sequence),
  );
  return {
    asOf: target.timestamp,
    mode: 'before',
    events: visible,
    resolution: null,
    withheldFutureEventCount: sorted.length - visible.length,
    fingerprint: hashJson(visible.map((e) => e.id)),
  } as unknown as PreResolutionView;
}

/**
 * The decision-moment view of the event at `length` in an already ordered view: its first `length`
 * events. Equivalent to createTemporalViewBeforeEvent for that event, without re-sorting.
 */
export function createTemporalPrefixView(view: TemporalView, length: number): PreResolutionView {
  const visible = view.events.slice(0, Math.max(0, length));
  const boundary = view.events[length]?.timestamp ?? view.asOf;
  let fingerprint: string | undefined;
  return {
    asOf: boundary,
    mode: 'before',
    events: visible,
    resolution: null,
    withheldFutureEventCount: view.events.length - visible.length,
    // Hashing every visible id is linear in the prefix; do it only for views that are asked for it.
    get fingerprint(): string {
      fingerprint ??= hashJson(visible.map((e) => e.id));
      return fingerprint;
    },
  } as unknown as PreResolutionView;
}

/** The post-hoc, whole-case view used for retrospective quality assessment. */
export function createFullView(
  events: readonly CaseEvent[],
  resolution: CaseResolution | null,
): TemporalView {
  const last = events.reduce(
    (max, e) => (compareIso(e.timestamp, max) > 0 ? e.timestamp : max),
    events[0]?.timestamp ?? '1970-01-01T00:00:00.000Z',
  );
  const asOf =
    resolution && compareIso(resolution.resolvedAt, last) > 0 ? resolution.resolvedAt : last;
  return createTemporalView(events, asOf, { resolution });
}

/** Narrows a view to one that provably excludes the resolution, or throws. */
export function assertPreResolution(view: TemporalView): asserts view is PreResolutionView {
  if (view.resolution !== null) {
    throw new Error(
      'Temporal integrity violation: the final resolution is present in a pre-resolution analysis view.',
    );
  }
}

/**
 * True when the view holds every recorded event: an inclusive boundary with nothing withheld. A case
 * that is still open can satisfy this too; whether hindsight is legitimate is `isCompleteCase`.
 */
export function coversWholeCase(view: TemporalView): boolean {
  return view.mode === 'at' && view.withheldFutureEventCount === 0;
}

/**
 * True when the view is the complete, closed case: it holds every recorded event AND the recorded
 * resolution (`TemporalView.resolution`, which is `Case.hasResolution` as the engine sees it and what
 * quality, metrics and the hindsight check read as "the case has a resolution"). Only then is a
 * judgement made with hindsight legitimate. In a prefix, and in an open case analysed over everything
 * recorded so far, the last action may simply not have been answered yet: the same artefact.
 */
export function isCompleteCase(view: TemporalView): boolean {
  return coversWholeCase(view) && view.resolution !== null;
}

/**
 * Counts references that point outside the view (events, evidence ids). Used for the leak check
 * recorded on every counterfactual scenario.
 */
export function findFutureReferences(
  view: TemporalView,
  referencedEventIds: Iterable<string>,
): string[] {
  const visible = new Set(view.events.map((e) => e.id));
  const leaks: string[] = [];
  for (const id of referencedEventIds) if (!visible.has(id)) leaks.push(id);
  return leaks;
}
