import type { CaseEvent, SignalDetector } from '@caseguard/schemas';
import type { CompiledDetector, CompiledPack } from '../knowledge/compile';
import { stableId } from '../util/ids';
import type { TemporalView } from './temporal';

/** One occurrence of a knowledge-pack signal in one event. */
export interface Observation {
  id: string;
  signalId: string;
  eventId: string;
  /** Index of the event inside the view the observation was detected in. */
  eventIndex: number;
  timestamp: string;
  excerpt: string;
  method: 'structured' | 'pattern';
  /** 0 for the first time this signal is observed in the case, then 1, 2, ... */
  repeatIndex: number;
  /** False for validation/closure events: they may satisfy requirements but never move beliefs. */
  affectsBelief: boolean;
  start: number | null;
  end: number | null;
}

const NON_BELIEF_EVENT_TYPES: ReadonlySet<string> = new Set([
  'validation_result',
  'resolution_note',
  'status_change',
]);
const MAX_SCAN_CHARS = 20_000;

export function eventText(event: CaseEvent): string {
  const text = event.title ? `${event.title}\n${event.body}` : event.body;
  return text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text;
}

function passesFilters(detector: SignalDetector, event: CaseEvent): boolean {
  if (detector.eventTypes && !detector.eventTypes.includes(event.type)) return false;
  if (
    detector.kind === 'regex' &&
    detector.roles &&
    !detector.roles.includes(event.participantRole)
  )
    return false;
  return true;
}

function compare(
  op: Extract<SignalDetector, { kind: 'structured' }>['op'],
  actual: unknown,
  expected: unknown,
): boolean {
  switch (op) {
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'eq':
      return actual === expected;
    case 'neq':
      return actual !== expected;
    case 'includes':
      return Array.isArray(actual)
        ? actual.includes(expected)
        : typeof actual === 'string' && typeof expected === 'string' && actual.includes(expected);
    default: {
      if (typeof actual !== 'number' || typeof expected !== 'number') return false;
      if (op === 'gt') return actual > expected;
      if (op === 'gte') return actual >= expected;
      if (op === 'lt') return actual < expected;
      return actual <= expected;
    }
  }
}

export interface DetectorMatch {
  excerpt: string;
  method: 'structured' | 'pattern';
  start: number | null;
  end: number | null;
}

type StructuredCondition = Extract<SignalDetector, { kind: 'structured' }>;

function conditionHolds(
  event: CaseEvent,
  c: { key: string; op: StructuredCondition['op']; value?: string | number | boolean | undefined },
): boolean {
  return compare(c.op, event.structured?.[c.key], c.value);
}

/** Runs one compiled detector against an event; returns the first match or null. */
export function matchDetector(
  compiled: CompiledDetector,
  event: CaseEvent,
  text?: string,
): DetectorMatch | null {
  const { detector, regex } = compiled;
  if (!passesFilters(detector, event)) return null;
  if (detector.kind === 'structured') {
    const actual = event.structured?.[detector.key];
    return compare(detector.op, actual, detector.value)
      ? {
          excerpt: `${detector.key} = ${JSON.stringify(actual)}`,
          method: 'structured',
          start: null,
          end: null,
        }
      : null;
  }
  if (detector.kind === 'structured_all') {
    if (!detector.conditions.every((c) => conditionHolds(event, c))) return null;
    const summary = detector.conditions
      .map((c) => `${c.key} = ${JSON.stringify(event.structured?.[c.key])}`)
      .join(', ');
    return { excerpt: summary, method: 'structured', start: null, end: null };
  }
  if (!regex) return null;
  const haystack = text ?? eventText(event);
  const match = regex.exec(haystack);
  if (!match) return null;
  const start = match.index;
  const end = start + match[0].length;
  const from = Math.max(0, start - 50);
  const to = Math.min(haystack.length, end + 70);
  const excerpt = haystack.slice(from, to).replace(/\s+/g, ' ').trim();
  return {
    excerpt: (from > 0 ? '…' : '') + excerpt + (to < haystack.length ? '…' : ''),
    method: 'pattern',
    start,
    end,
  };
}

export function firstDetectorMatch(
  detectors: readonly CompiledDetector[] | undefined,
  event: CaseEvent,
  text?: string,
): DetectorMatch | null {
  if (!detectors) return null;
  for (const d of detectors) {
    const m = matchDetector(d, event, text);
    if (m) return m;
  }
  return null;
}

/** Detects every knowledge-pack signal in every event of a temporal view. */
export function detectObservations(
  view: TemporalView,
  pack: CompiledPack,
  caseId: string,
): Observation[] {
  const out: Observation[] = [];
  const seenCount = new Map<string, number>();
  view.events.forEach((event, eventIndex) => {
    const text = eventText(event);
    for (const signal of pack.pack.signals) {
      const match = firstDetectorMatch(pack.signalDetectors.get(signal.id), event, text);
      if (!match) continue;
      const repeatIndex = seenCount.get(signal.id) ?? 0;
      seenCount.set(signal.id, repeatIndex + 1);
      out.push({
        id: stableId('evd', caseId, signal.id, event.id),
        signalId: signal.id,
        eventId: event.id,
        eventIndex,
        timestamp: event.timestamp,
        excerpt: match.excerpt.slice(0, 280),
        method: match.method,
        repeatIndex,
        affectsBelief: !NON_BELIEF_EVENT_TYPES.has(event.type),
        start: match.start,
        end: match.end,
      });
    }
  });
  return out;
}
