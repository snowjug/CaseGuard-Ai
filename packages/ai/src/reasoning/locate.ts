import { MAX_EXCERPT_CHARS, verifyExcerpt } from '@caseguard/domain';
import type { AiFindingEvidence } from '@caseguard/schemas';
import { sha256Hex } from '../util/hash';
import type { RuleEvent } from './context';
import { normaliseExcerpt } from './text';

/** A normalised copy of a text, with where each character of it came from in the original. */
interface MappedText {
  text: string;
  /** Offset in the original where the segment that gave character `i` starts. */
  starts: number[];
  /** Offset in the original where that segment ends (exclusive). */
  ends: number[];
}

const SPACE = /\s/u;
const MARK = /\p{M}/u;

const codePointLength = (text: string, index: number): number =>
  (text.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;

/**
 * NFC-normalises a text and collapses whitespace runs to one space (trimmed), remembering for each character of the
 * result the span of the original it came from. Composition is done per base character with its combining marks, so
 * offsets stay meaningful. When that does not reproduce the plain normalisation (rare scripts that compose across
 * segments) the text cannot be mapped and null is returned: the caller then never records an offset.
 */
function mapNormalised(original: string): MappedText | null {
  const chars: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let pendingSpace: { start: number; end: number } | null = null;
  let i = 0;
  while (i < original.length) {
    const width = codePointLength(original, i);
    if (SPACE.test(original.slice(i, i + width))) {
      let j = i + width;
      while (
        j < original.length &&
        SPACE.test(original.slice(j, j + codePointLength(original, j)))
      ) {
        j += codePointLength(original, j);
      }
      if (chars.length > 0) pendingSpace = { start: i, end: j };
      i = j;
      continue;
    }
    let j = i + width;
    while (j < original.length && MARK.test(original.slice(j, j + codePointLength(original, j)))) {
      j += codePointLength(original, j);
    }
    if (pendingSpace) {
      chars.push(' ');
      starts.push(pendingSpace.start);
      ends.push(pendingSpace.end);
      pendingSpace = null;
    }
    const normalised = original.slice(i, j).normalize('NFC');
    // Per UTF-16 unit, so an index into `chars` is an index into the joined text.
    for (let k = 0; k < normalised.length; k++) {
      chars.push(normalised.charAt(k));
      starts.push(i);
      ends.push(j);
    }
    i = j;
  }
  const text = chars.join('');
  return text === normaliseExcerpt(original) ? { text, starts, ends } : null;
}

/** Where a normalised quotation lies in the original text: the first occurrence, as offsets into the original. */
export function findInOriginal(
  original: string,
  normalisedNeedle: string,
): { start: number; end: number } | null {
  if (normalisedNeedle === '') return null;
  const mapped = mapNormalised(original);
  if (!mapped) return null;
  const at = mapped.text.indexOf(normalisedNeedle);
  if (at < 0) return null;
  const start = mapped.starts[at];
  const end = mapped.ends[at + normalisedNeedle.length - 1];
  return start === undefined || end === undefined ? null : { start, end };
}

/** True when the normalised quotation is a verbatim part of the text the model was shown for the event. */
export function isInShownText(event: RuleEvent, normalisedNeedle: string): boolean {
  return [event.shownTitle, event.shownText].some(
    (shown) => shown !== null && normaliseExcerpt(shown).includes(normalisedNeedle),
  );
}

/** The longest span an evidence record keeps, cut so a surrogate pair stays whole. */
function capSpan(text: string, start: number, end: number): number {
  let cut = Math.min(end, start + MAX_EXCERPT_CHARS);
  if (cut < end && cut > start + 1) {
    const last = text.charCodeAt(cut - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  }
  return cut;
}

/**
 * The server's own record of a quotation. The excerpt is located in the stored text of the event (whitespace and
 * Unicode form do not matter, nothing else does), its offsets are recorded, and `verifyExcerpt` from the domain
 * confirms that the stored text holds exactly that span there. A quotation of text that redaction replaced is not in
 * the stored text; if it is in the redacted text the model was shown, it is recorded as verified in the redacted view,
 * without offsets. Anything else is not located (null). The model's own offsets do not exist and are never used.
 */
export function locateCitation(
  event: RuleEvent,
  citation: { eventId: string; excerpt: string },
): AiFindingEvidence | null {
  const needle = normaliseExcerpt(citation.excerpt);
  if (needle.length < 3) return null;
  const storedEvent = { id: event.id, title: event.storedTitle, body: event.storedBody };
  for (const field of ['body', 'title'] as const) {
    const stored = field === 'body' ? event.storedBody : event.storedTitle;
    if (stored === null || stored === '') continue;
    const hit = findInOriginal(stored, needle);
    if (!hit) continue;
    const end = capSpan(stored, hit.start, hit.end);
    const excerpt = stored.slice(hit.start, end);
    const check = verifyExcerpt(storedEvent, {
      eventId: event.id,
      field,
      start: hit.start,
      end,
      excerpt,
    });
    if (check.verification !== 'verified') continue;
    return {
      eventId: event.id,
      excerpt,
      verifiedIn: 'stored_text',
      field,
      start: hit.start,
      end,
      verified: true,
      sourceHash: sha256Hex(stored),
    };
  }
  for (const shown of [event.shownText, event.shownTitle]) {
    if (shown !== null && normaliseExcerpt(shown).includes(needle)) {
      return {
        eventId: event.id,
        excerpt: needle,
        verifiedIn: 'redacted_view',
        field: null,
        start: null,
        end: null,
        verified: true,
        sourceHash: sha256Hex(shown),
      };
    }
  }
  return null;
}
