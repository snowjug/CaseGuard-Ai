import type { CaseEvent, SignalDetector, SourceField, StatementModality } from '@caseguard/schemas';
import type { CompiledDetector, CompiledPack } from '../knowledge/compile';
import { stableId } from '../util/ids';
import {
  assessModality,
  firesFor,
  maskQuotedHistory,
  maskReplyTitle,
  type DetectionUse,
} from './modality';
import { normaliseChatStyle, toOriginalSpan, type ScanMap } from './normalise-chat';
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
  /** Which stored text `start` and `end` count into. Null exactly when there are no offsets (structured values). */
  field: SourceField | null;
  start: number | null;
  end: number | null;
  /** How the sentence stands to the fact: asserted, or reported or corrected (the other modalities never become observations). */
  modality: StatementModality;
  /** The words that gave it a modality other than asserted. */
  cue: string | null;
  /**
   * Set when the sentence denies another signal that the pack pairs with this one, so this observation reads the denial
   * ("service health lists nothing active" is "no active incident"). The id of the signal that was denied.
   */
  negationOf: string | null;
}

const NON_BELIEF_EVENT_TYPES: ReadonlySet<string> = new Set([
  'validation_result',
  'resolution_note',
  'status_change',
]);
/** Longest text of one event the detectors read. */
export const MAX_SCAN_CHARS = 20_000;
/** Characters of the scanned text an excerpt keeps before and after a match, before whitespace is folded. */
export const EXCERPT_CHARS_BEFORE = 50;
export const EXCERPT_CHARS_AFTER = 70;
/** Longest excerpt kept on evidence and claims. */
export const MAX_EXCERPT_CHARS = 280;

/** The text the detectors read: the title, a line break and the body (just the body when there is no title). */
export function eventText(event: Pick<CaseEvent, 'title' | 'body'>): string {
  const text = event.title ? `${event.title}\n${event.body}` : event.body;
  return text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text;
}

/** A span of the stored event text, counted from the start of the named field. */
export interface LocatedSpan {
  field: SourceField;
  start: number;
  end: number;
}

/**
 * Where a span of `eventText(event)` lies in the stored event. Offsets found in the scanned text count
 * from the start of the title, which is not where the body starts: a span inside the body is moved to
 * count from the start of the body, one inside the title stays as it is, and one that crosses the line
 * break between them keeps counting into the whole scanned text (`titleAndBody`).
 */
export function locateInEvent(
  event: Pick<CaseEvent, 'title'>,
  start: number,
  end: number,
): LocatedSpan {
  const title = event.title;
  if (!title) return { field: 'body', start, end };
  const bodyStart = title.length + 1;
  if (end <= title.length) return { field: 'title', start, end };
  if (start >= bodyStart) return { field: 'body', start: start - bodyStart, end: end - bodyStart };
  return { field: 'titleAndBody', start, end };
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
  /** How the sentence stands to the fact the detector found (see `assessModality`). */
  modality: StatementModality;
  /** The words that gave it a modality other than asserted. */
  cue: string | null;
}

/** Words the detector found that were not counted, because the sentence does not state the fact. */
export interface SuppressedMatch {
  modality: StatementModality;
  cueId: string | null;
  cue: string | null;
  excerpt: string;
  start: number;
  end: number;
}

export interface DetectorScan {
  /** The first match that states the fact; null when there is none. */
  match: DetectorMatch | null;
  /** When there is no such match: the first one that was found and not counted, and why. */
  suppressed: SuppressedMatch | null;
}

const NOT_FOUND: DetectorScan = { match: null, suppressed: null };

/** Most matches of one detector in one event that are weighed; the cap bounds the cost of a hostile text. */
export const MAX_MATCHES_PER_DETECTOR = 12;

/**
 * What the detectors read in one event: the stored text (excerpts and offsets are taken from it) and the text matching runs
 * on, which is the same text with the earlier messages an e-mail quotes and the title of a reply blanked out and the listed
 * chat shorthand and typos replaced. `map` leads from a position in `scan` back to the word it came from in `text` (null
 * when nothing was replaced).
 */
export interface EventTexts {
  text: string;
  scan: string;
  map: ScanMap | null;
}

const scanTextOf = (
  text: string,
  type: string,
  title: string | null | undefined,
): { scan: string; map: ScanMap | null } => {
  const normalised = normaliseChatStyle(maskQuotedHistory(maskReplyTitle(text, title), type));
  return { scan: normalised.text, map: normalised.map };
};

export function eventTexts(event: Pick<CaseEvent, 'title' | 'body' | 'type'>): EventTexts {
  const text = eventText(event);
  return { text, ...scanTextOf(text, event.type, event.title) };
}

const resolveTexts = (
  event: Pick<CaseEvent, 'title' | 'body' | 'type'>,
  texts: EventTexts | string | undefined,
): EventTexts =>
  texts === undefined
    ? eventTexts(event)
    : typeof texts === 'string'
      ? { text: texts, ...scanTextOf(texts, event.type, event.title) }
      : texts;

function excerptAround(haystack: string, start: number, end: number): string {
  const from = Math.max(0, start - EXCERPT_CHARS_BEFORE);
  const to = Math.min(haystack.length, end + EXCERPT_CHARS_AFTER);
  const excerpt = haystack.slice(from, to).replace(/\s+/g, ' ').trim();
  return (from > 0 ? '…' : '') + excerpt + (to < haystack.length ? '…' : '');
}

type StructuredCondition = Extract<SignalDetector, { kind: 'structured' }>;

function conditionHolds(
  event: CaseEvent,
  c: { key: string; op: StructuredCondition['op']; value?: string | number | boolean | undefined },
): boolean {
  return compare(c.op, event.structured?.[c.key], c.value);
}

/**
 * Runs one compiled detector against an event. A regex detector weighs every match (up to a cap), not only the first:
 * the first that states the fact is returned, and when none does the first that was found is returned as suppressed,
 * with the reason. `use` decides which modalities state the fact (a signal, an engineer's action, a request to the
 * customer, a requirement).
 */
export function scanDetector(
  compiled: CompiledDetector,
  event: CaseEvent,
  texts?: EventTexts | string,
  use: DetectionUse = 'signal',
): DetectorScan {
  const { detector } = compiled;
  if (!passesFilters(detector, event)) return NOT_FOUND;
  if (detector.kind === 'structured') {
    const actual = event.structured?.[detector.key];
    return compare(detector.op, actual, detector.value)
      ? {
          match: {
            excerpt: `${detector.key} = ${JSON.stringify(actual)}`,
            method: 'structured',
            start: null,
            end: null,
            modality: 'asserted',
            cue: null,
          },
          suppressed: null,
        }
      : NOT_FOUND;
  }
  if (detector.kind === 'structured_all') {
    if (!detector.conditions.every((c) => conditionHolds(event, c))) return NOT_FOUND;
    const summary = detector.conditions
      .map((c) => `${c.key} = ${JSON.stringify(event.structured?.[c.key])}`)
      .join(', ');
    return {
      match: {
        excerpt: summary,
        method: 'structured',
        start: null,
        end: null,
        modality: 'asserted',
        cue: null,
      },
      suppressed: null,
    };
  }
  if (!compiled.scan) return NOT_FOUND;
  const { text, scan, map } = resolveTexts(event, texts);
  let suppressed: SuppressedMatch | null = null;
  let weighed = 0;
  for (const found of scan.matchAll(compiled.scan)) {
    const words = found[0] ?? '';
    if (words === '') continue;
    weighed += 1;
    if (weighed > MAX_MATCHES_PER_DETECTOR) break;
    const foundAt = found.index ?? 0;
    const assessed = assessModality(scan, foundAt, foundAt + words.length, {
      negativeContent: compiled.negativeContent,
    });
    // Everything reported points into the stored text, however the matched text was normalised.
    const { start, end } = toOriginalSpan(map, foundAt, foundAt + words.length);
    const excerpt = excerptAround(text, start, end);
    if (firesFor(use, assessed.modality)) {
      return {
        match: {
          excerpt,
          method: 'pattern',
          start,
          end,
          modality: assessed.modality,
          cue: assessed.cue,
        },
        suppressed: null,
      };
    }
    suppressed ??= {
      modality: assessed.modality,
      cueId: assessed.cueId,
      cue: assessed.cue,
      excerpt,
      start,
      end,
    };
  }
  return suppressed === null ? NOT_FOUND : { match: null, suppressed };
}

/** Runs one compiled detector against an event as a signal detector; returns the first match that states the fact. */
export function matchDetector(
  compiled: CompiledDetector,
  event: CaseEvent,
  text?: string,
): DetectorMatch | null {
  return scanDetector(compiled, event, text, 'signal').match;
}

/** The first detector of a list that finds a match stating the fact; when none does, the first match that was set aside. */
export function scanDetectors(
  detectors: readonly CompiledDetector[] | undefined,
  event: CaseEvent,
  texts?: EventTexts | string,
  use: DetectionUse = 'signal',
): DetectorScan {
  if (!detectors || detectors.length === 0) return NOT_FOUND;
  const resolved = resolveTexts(event, texts);
  let suppressed: SuppressedMatch | null = null;
  for (const detector of detectors) {
    const result = scanDetector(detector, event, resolved, use);
    if (result.match) return result;
    suppressed ??= result.suppressed;
  }
  return suppressed === null ? NOT_FOUND : { match: null, suppressed };
}

export function firstDetectorMatch(
  detectors: readonly CompiledDetector[] | undefined,
  event: CaseEvent,
  texts?: EventTexts | string,
  use: DetectionUse = 'signal',
): DetectorMatch | null {
  return scanDetectors(detectors, event, texts, use).match;
}

/** A signal's words that were found in an event and not counted, with the reason. */
export interface SuppressedObservation extends SuppressedMatch {
  signalId: string;
  eventId: string;
  eventIndex: number;
}

/** The most set-aside matches a view keeps; the rest are counted. A hostile text could otherwise set aside one per signal per event. */
export const MAX_SUPPRESSED_KEPT = 500;

/**
 * Detects every knowledge-pack signal in every event of a temporal view. A sentence that mentions a signal's words
 * without stating the fact (a denial, a guess, a plan, a condition) is not an observation; when `notes` is given the
 * set-aside matches are collected in it (at most `MAX_SUPPRESSED_KEPT`, with every one counted in `total`). A denial of
 * the positive side of a declared signal pair is an observation of the negative side ("service health lists nothing
 * active" is "no active incident").
 */
export function detectObservations(
  view: TemporalView,
  pack: CompiledPack,
  caseId: string,
  notes?: { suppressed: SuppressedObservation[]; total?: number },
): Observation[] {
  const out: Observation[] = [];
  const seenCount = new Map<string, number>();
  const push = (
    signalId: string,
    event: CaseEvent,
    eventIndex: number,
    match: DetectorMatch,
    negationOf: string | null,
  ): void => {
    const where =
      match.start !== null && match.end !== null
        ? locateInEvent(event, match.start, match.end)
        : null;
    const repeatIndex = seenCount.get(signalId) ?? 0;
    seenCount.set(signalId, repeatIndex + 1);
    out.push({
      id: stableId('evd', caseId, signalId, event.id),
      signalId,
      eventId: event.id,
      eventIndex,
      timestamp: event.timestamp,
      excerpt: match.excerpt.slice(0, MAX_EXCERPT_CHARS),
      method: match.method,
      repeatIndex,
      affectsBelief: !NON_BELIEF_EVENT_TYPES.has(event.type),
      field: where?.field ?? null,
      start: where?.start ?? null,
      end: where?.end ?? null,
      modality: match.modality,
      cue: match.cue,
      negationOf,
    });
  };
  view.events.forEach((event, eventIndex) => {
    const texts = eventTexts(event);
    const found = new Set<string>();
    const setAside: SuppressedObservation[] = [];
    for (const signal of pack.pack.signals) {
      const result = scanDetectors(pack.signalDetectors.get(signal.id), event, texts, 'signal');
      if (result.match) {
        push(signal.id, event, eventIndex, result.match, null);
        found.add(signal.id);
      } else if (result.suppressed) {
        setAside.push({ ...result.suppressed, signalId: signal.id, eventId: event.id, eventIndex });
      }
    }
    for (const note of setAside) {
      if (notes) {
        notes.total = (notes.total ?? 0) + 1;
        if (notes.suppressed.length < MAX_SUPPRESSED_KEPT) notes.suppressed.push(note);
      }
      if (note.modality !== 'negated') continue;
      const link = pack.signalPairs.get(note.signalId);
      if (!link || link.side !== 'positive' || !link.pair.denialIsNegative) continue;
      if (found.has(link.counterpart)) continue;
      found.add(link.counterpart);
      push(
        link.counterpart,
        event,
        eventIndex,
        {
          excerpt: note.excerpt,
          method: 'pattern',
          start: note.start,
          end: note.end,
          modality: 'asserted',
          cue: note.cue,
        },
        note.signalId,
      );
    }
  });
  return out;
}
