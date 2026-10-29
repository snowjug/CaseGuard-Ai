/*
 * Hidden-character handling for untrusted text (NFR-SEC-05). Zero-width characters, bidirectional
 * controls and Unicode "tag" characters are invisible to a human reviewer but are read by a model,
 * which makes them a carrier for smuggled instructions.
 *
 * Characters are classified by code point rather than with regular-expression character classes:
 * several of these code points are combining or joining marks, which make such classes ambiguous.
 */

export interface HiddenCharacterCounts {
  /** Zero-width and other invisible formatting characters (ZWSP, ZWNJ, word joiner, BOM mid-text, ...). */
  readonly zeroWidth: number;
  /** Bidirectional controls (LRO/RLO/isolates/marks) that can reorder what a reader sees. */
  readonly bidiControls: number;
  /** Unicode tag characters (U+E0000-E007F) and variation selectors supplement: "ASCII smuggling". */
  readonly tagCharacters: number;
  /** Other control characters (everything below U+0020 except tab/newline/carriage return, DEL, C1). */
  readonly controls: number;
  /** Offset of the first character of each kind, or -1, so findings can point at it. */
  readonly firstIndex: {
    readonly zeroWidth: number;
    readonly bidiControls: number;
    readonly tagCharacters: number;
  };
}

type HiddenKind = 'zeroWidth' | 'bidi' | 'tag' | 'control';

const ZERO_WIDTH_POINTS = new Set([
  0x00ad, 0x034f, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x180e, 0x200b, 0x200c, 0x3164, 0xfeff, 0xffa0,
]);
const ZERO_WIDTH_JOINER = 0x200d;
const EMOJI = /\p{Extended_Pictographic}|\uFE0F|\p{Emoji_Modifier}/u;
/** Plain printable ASCII plus tab/newline/CR needs no scanning at all. */
const NEEDS_SCAN = /[^\u0020-\u007E\t\n\r]/;

function kindOf(cp: number): HiddenKind | null {
  if (cp < 0x20) return cp === 0x09 || cp === 0x0a || cp === 0x0d ? null : 'control';
  if (cp < 0x7f) return null;
  if (cp <= 0x9f) return 'control';
  if (
    cp === 0x061c ||
    cp === 0x200e ||
    cp === 0x200f ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069)
  ) {
    return 'bidi';
  }
  if ((cp >= 0xe0000 && cp <= 0xe007f) || (cp >= 0xe0100 && cp <= 0xe01ef)) return 'tag';
  if (
    ZERO_WIDTH_POINTS.has(cp) ||
    (cp >= 0x2060 && cp <= 0x2064) ||
    (cp >= 0x206a && cp <= 0x206f) ||
    (cp >= 0xfff9 && cp <= 0xfffb)
  ) {
    return 'zeroWidth';
  }
  return null;
}

function codePointBefore(text: string, index: number): string {
  if (index <= 0) return '';
  const low = text.charCodeAt(index - 1);
  if (low >= 0xdc00 && low <= 0xdfff && index >= 2) return text.slice(index - 2, index);
  return text.charAt(index - 1);
}

function codePointAt(text: string, index: number): string {
  const cp = text.codePointAt(index);
  return cp === undefined ? '' : String.fromCodePoint(cp);
}

/** A ZWJ between two emoji is part of the emoji; anywhere else it is a hidden character. */
function isHiddenJoiner(text: string, index: number): boolean {
  const before = codePointBefore(text, index);
  const after = codePointAt(text, index + 1);
  return !(before !== '' && after !== '' && EMOJI.test(before) && EMOJI.test(after));
}

interface HiddenHit {
  readonly index: number;
  readonly length: number;
  readonly kind: HiddenKind;
  readonly codePoint: number;
}

/** Every hidden character in `text` in order. A BOM at offset 0 is ordinary and is skipped. */
function* hiddenCharacters(text: string): Generator<HiddenHit> {
  if (!NEEDS_SCAN.test(text)) return;
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i) ?? 0;
    const length = cp > 0xffff ? 2 : 1;
    let kind: HiddenKind | null;
    if (cp === ZERO_WIDTH_JOINER) kind = isHiddenJoiner(text, i) ? 'zeroWidth' : null;
    else if (cp === 0xfeff && i === 0) kind = null;
    else kind = kindOf(cp);
    if (kind !== null) yield { index: i, length, kind, codePoint: cp };
    i += length;
  }
}

/**
 * Removes zero-width, bidi, tag and control characters (keeping tab, newline and carriage return)
 * and turns U+0085/U+2028/U+2029 into plain newlines. Emoji joiners are preserved. A leading BOM
 * is dropped like any other zero-width character.
 */
export function stripHiddenCharacters(text: string): string {
  if (!NEEDS_SCAN.test(text)) return text;
  const normalized = text.replace(/[\u0085\u2028\u2029]/g, '\n');
  let out = '';
  let last = 0;
  for (let i = 0; i < normalized.length;) {
    const cp = normalized.codePointAt(i) ?? 0;
    const length = cp > 0xffff ? 2 : 1;
    const hidden = cp === ZERO_WIDTH_JOINER ? isHiddenJoiner(normalized, i) : kindOf(cp) !== null;
    if (hidden) {
      out += normalized.slice(last, i);
      last = i + length;
    }
    i += length;
  }
  return out + normalized.slice(last);
}

/** Counts hidden characters by kind. A BOM at the very start of the text is not counted. */
export function countHiddenCharacters(text: string): HiddenCharacterCounts {
  const counts = { zeroWidth: 0, bidiControls: 0, tagCharacters: 0, controls: 0 };
  const first = { zeroWidth: -1, bidiControls: -1, tagCharacters: -1 };
  for (const hit of hiddenCharacters(text)) {
    if (hit.kind === 'bidi') {
      counts.bidiControls += 1;
      if (first.bidiControls < 0) first.bidiControls = hit.index;
    } else if (hit.kind === 'tag') {
      counts.tagCharacters += 1;
      if (first.tagCharacters < 0) first.tagCharacters = hit.index;
    } else if (hit.kind === 'zeroWidth') {
      counts.zeroWidth += 1;
      if (first.zeroWidth < 0) first.zeroWidth = hit.index;
    } else {
      counts.controls += 1;
    }
  }
  return { ...counts, firstIndex: first };
}

/** Renders hidden characters visibly (for example `⟦U+200B⟧`) so a reviewer can see what was there. */
export function visualizeHiddenCharacters(text: string): string {
  let out = '';
  let last = 0;
  for (const hit of hiddenCharacters(text)) {
    out += `${text.slice(last, hit.index)}\u27E6U+${hit.codePoint.toString(16).toUpperCase().padStart(4, '0')}\u27E7`;
    last = hit.index + hit.length;
  }
  return out + text.slice(last);
}
