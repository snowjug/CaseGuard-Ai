import type { CaseEvent, SourceField, SourceRef } from '@caseguard/schemas';
import { EXCERPT_CHARS_AFTER, EXCERPT_CHARS_BEFORE, MAX_EXCERPT_CHARS, eventText } from './signals';

/**
 * What checking a recorded excerpt against the immutable stored event found.
 * - `verified`: the stored text holds exactly the cited span there, so the excerpt is a real quotation.
 * - `mismatch`: a location was recorded but the stored text does not hold the excerpt there.
 * - `not_checkable`: nothing to compare (no offsets, no excerpt); nothing is claimed.
 */
export type ExcerptVerification = 'verified' | 'mismatch' | 'not_checkable';

/** Why a check came out as it did. A code, never stored text, so it is safe to log. */
export type ExcerptCheckReason =
  | 'matches'
  | 'no_location'
  | 'no_excerpt'
  | 'empty_span'
  | 'wrong_event'
  | 'out_of_range'
  | 'text_differs';

/** Verbatim stored text around a cited span: `before + match + after` is one contiguous piece of it. */
export interface ExcerptContext {
  before: string;
  match: string;
  after: string;
}

export interface ExcerptCheck {
  verification: ExcerptVerification;
  reason: ExcerptCheckReason;
  /** Present only for a verified excerpt: an unchecked excerpt is never shown as a quotation. */
  context: ExcerptContext | null;
}

/** How much stored text a verified quotation shows on each side of the cited span. */
export const CONTEXT_CHARS_BEFORE = 200;
export const CONTEXT_CHARS_AFTER = 200;
/** The longest cited span a quotation shows; past it the quotation ends where the span is cut. */
export const CONTEXT_CHARS_MATCH = 800;
/** A cut through a run of characters longer than this is not moved to the edge of a word. */
const MAX_WORD_CHARS = 32;

const ELLIPSIS = '…';

const notCheckable = (reason: ExcerptCheckReason): ExcerptCheck => ({
  verification: 'not_checkable',
  reason,
  context: null,
});
const mismatch = (reason: ExcerptCheckReason): ExcerptCheck => ({
  verification: 'mismatch',
  reason,
  context: null,
});

/** The stored text a field names; null when the event has no such text. */
function fieldText(event: Pick<CaseEvent, 'title' | 'body'>, field: SourceField): string | null {
  switch (field) {
    case 'title':
      return event.title ? event.title : null;
    case 'body':
      return event.body;
    case 'titleAndBody':
      return event.title ? `${event.title}\n${event.body}` : event.body;
  }
}

/** Where the body starts in the text the detectors scan (the title and its line break come first). */
const bodyStartInScan = (event: Pick<CaseEvent, 'title'>): number =>
  event.title ? event.title.length + 1 : 0;

/**
 * The excerpt the detectors record for a match: the scanned text around it, whitespace folded, with an
 * ellipsis where the text goes on. Written out here on purpose (the engine builds it in `matchDetector`)
 * so that a check is a second derivation of the same rule, not the engine agreeing with itself.
 */
function windowExcerpt(scan: string, start: number, end: number): string {
  const from = Math.max(0, start - EXCERPT_CHARS_BEFORE);
  const to = Math.min(scan.length, end + EXCERPT_CHARS_AFTER);
  const folded = scan.slice(from, to).replace(/\s+/g, ' ').trim();
  return ((from > 0 ? ELLIPSIS : '') + folded + (to < scan.length ? ELLIPSIS : '')).slice(
    0,
    MAX_EXCERPT_CHARS,
  );
}

const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;
const isSpace = (char: string | undefined): boolean => char !== undefined && /\s/u.test(char);

/** A cut at `index` must not fall between the two halves of a surrogate pair. */
const keepPairWhole = (text: string, index: number, direction: 1 | -1): number =>
  index > 0 && index < text.length && isLowSurrogate(text.charCodeAt(index))
    ? index + direction
    : index;

/** Where the text before a span begins: about `CONTEXT_CHARS_BEFORE` back, starting at a word when it can. */
function contextStart(text: string, start: number): number {
  let from = keepPairWhole(text, Math.max(0, start - CONTEXT_CHARS_BEFORE), 1);
  if (from > 0 && from < start && !isSpace(text[from - 1]) && !isSpace(text[from])) {
    // Only a cut through an ordinary word moves; a longer unbroken run (a hash, a path) is left as cut.
    const gap = text.slice(from, start).search(/\s/u);
    if (gap >= 0 && gap < MAX_WORD_CHARS) from += gap + 1;
  }
  return from;
}

/** Where the text after a span ends: about `CONTEXT_CHARS_AFTER` on, ending at a word when it can. */
function contextEnd(text: string, end: number): number {
  let to = keepPairWhole(text, Math.min(text.length, end + CONTEXT_CHARS_AFTER), -1);
  if (to < text.length && to > end && !isSpace(text[to - 1]) && !isSpace(text[to])) {
    const tail = text.slice(end, to);
    const gap = tail.search(/\s\S*$/u);
    if (gap >= 0 && tail.length - gap - 1 < MAX_WORD_CHARS) to = end + gap;
  }
  return to;
}

/** The bounded verbatim quotation around `[start, end)` of `text`. */
export function excerptContext(text: string, start: number, end: number): ExcerptContext {
  const matchEnd = keepPairWhole(text, Math.min(end, start + CONTEXT_CHARS_MATCH), -1);
  const cutShort = matchEnd < end;
  const from = contextStart(text, start);
  const to = cutShort ? matchEnd : contextEnd(text, end);
  return {
    before: text.slice(from, start),
    match: text.slice(start, matchEnd),
    after: text.slice(matchEnd, to),
  };
}

/**
 * Checks a recorded source reference against the stored event it names, and quotes the stored text only
 * when the check passes.
 *
 * A reference carries a field (title, body, or both as `title + "\n" + body`), offsets counted into that
 * field, and the excerpt the analysis recorded. The excerpt is `verified` when the stored text, cut where
 * the reference says, gives exactly that excerpt in one of the two shapes the engine records:
 * - the window shape of evidence: the scanned text around the match (50 characters before, 70 after),
 *   whitespace folded, with an ellipsis where the text goes on, cut to the stored length; or
 * - the span shape of statement and attribute claims: the cited span itself.
 * Either way the excerpt is rebuilt from the stored event and compared in full, so a changed excerpt,
 * shifted offsets, a wrong field or edited text each give `mismatch`. With no field, offsets or excerpt
 * there is nothing to compare and the answer is `not_checkable`: nothing is ever verified by default.
 */
export function verifyExcerpt(
  event: Pick<CaseEvent, 'id' | 'title' | 'body'>,
  ref: SourceRef | null | undefined,
): ExcerptCheck {
  if (ref === null || ref === undefined) return notCheckable('no_location');
  const { field, start, end, excerpt } = ref;
  if (field === undefined || start === undefined || end === undefined) {
    return notCheckable('no_location');
  }
  if (excerpt === undefined) return notCheckable('no_excerpt');
  if (ref.eventId !== undefined && ref.eventId !== event.id) return mismatch('wrong_event');

  const text = fieldText(event, field);
  if (text === null || start > end || end > text.length) return mismatch('out_of_range');
  if (start === end) return notCheckable('empty_span');

  const spanForm = text.slice(start, end).slice(0, MAX_EXCERPT_CHARS);
  let verified = excerpt === spanForm;
  if (!verified) {
    // The detectors scan the title, a line break and the body, capped: offsets of the body move by the title.
    const scan = eventText(event);
    const shift = field === 'body' ? bodyStartInScan(event) : 0;
    verified =
      end + shift <= scan.length && excerpt === windowExcerpt(scan, start + shift, end + shift);
  }
  return verified
    ? { verification: 'verified', reason: 'matches', context: excerptContext(text, start, end) }
    : mismatch('text_differs');
}
