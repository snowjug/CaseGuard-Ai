/*
 * Detection view of a string (H1).
 *
 * The redaction rules are written against plain ASCII: `password:` followed by a space, `Bearer`
 * followed by a space, an ASCII key body. Text that comes from HTML, Teams, Outlook or a hostile
 * author can say the same thing with other characters: a no-break space or an ideographic space after
 * the colon, a full-width colon, a zero-width space (U+200B) inside the word `password` or inside a
 * key. None of that may let a secret through.
 *
 * `foldForDetection` builds a *view* of the text for the rules to read:
 *   - every code point is folded with NFKC on its own (full-width letters, digits and punctuation
 *     become ASCII; compatibility forms become their plain equivalents),
 *   - invisible characters (format controls, default-ignorable code points, C0/C1 controls) are
 *     removed,
 *   - Unicode space separators become a plain space and line/paragraph separators become a newline.
 * Only mappings that keep one character per character are used (a code point either becomes exactly
 * one character or disappears), and an offset map points every character of the view back to the
 * character it came from. Replacements are applied to the ORIGINAL string through that map, so
 * everything outside a redacted span stays byte-for-byte what the author wrote: the folded text
 * itself is never stored.
 *
 * Not folded: look-alike letters from other scripts (Cyrillic U+0430 for Latin "a") and combining
 * marks. NFKC does not map them, and guessing would change what a word means.
 */

export interface FoldedText {
  /** What the rules read. */
  readonly text: string;
  /**
   * `starts[i]` is the offset, in the original string, of the character that produced `text[i]`;
   * `starts[text.length]` is the original length. Both halves of a surrogate pair share one entry.
   */
  readonly starts: Int32Array;
}

/** Printable ASCII plus tab, newline and carriage return: nothing in it needs folding. */
const PLAIN = /^[\u0020-\u007E\t\n\r]*$/;
const INVISIBLE = /^(?:\p{Cf}|\p{Default_Ignorable_Code_Point})$/u;
const SPACE_SEPARATOR = /^\p{Zs}$/u;
/** Braille blank: renders as a space but is a letter-like symbol to Unicode. */
const BRAILLE_BLANK = 0x2800;
const STRIP = -1;

const MEMO_LIMIT = 8192;
const memo = new Map<number, number>();

function classify(codePoint: number): number {
  if (codePoint === 0x85 || codePoint === 0x2028 || codePoint === 0x2029) return 0x0a;
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) return STRIP;
  const text = String.fromCodePoint(codePoint);
  if (INVISIBLE.test(text)) return STRIP;
  if (codePoint === BRAILLE_BLANK || SPACE_SEPARATOR.test(text)) return 0x20;
  return codePoint;
}

function computeFold(codePoint: number): number {
  const own = classify(codePoint);
  if (own !== codePoint) return own;
  const text = String.fromCodePoint(codePoint);
  const normalized = text.normalize('NFKC');
  if (normalized === text) return codePoint;
  const folded = normalized.codePointAt(0) ?? codePoint;
  // Expansions (a ligature becoming two letters, an ellipsis becoming three dots) would break the
  // one-to-one offset map, and none of them matters to the rules, so those characters stay as they are.
  if (normalized.length !== (folded > 0xffff ? 2 : 1)) return codePoint;
  // A BMP character never becomes an astral one: it would need two units where the source has one.
  if (folded > 0xffff && codePoint <= 0xffff) return codePoint;
  const result = classify(folded);
  // A character that folds to a control keeps its own form; invisible and space results are honoured.
  return result === STRIP && folded < 0x20 ? codePoint : result;
}

function foldCodePoint(codePoint: number): number {
  const known = memo.get(codePoint);
  if (known !== undefined) return known;
  const folded = computeFold(codePoint);
  if (memo.size >= MEMO_LIMIT) memo.clear();
  memo.set(codePoint, folded);
  return folded;
}

function unitsToString(units: Uint16Array, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 8192) {
    out += String.fromCharCode(...units.subarray(i, Math.min(length, i + 8192)));
  }
  return out;
}

/**
 * The detection view of `source`, or `null` when the view would be identical to it (the common
 * case: plain text needs no offset map at all).
 */
export function foldForDetection(source: string): FoldedText | null {
  if (PLAIN.test(source)) return null;
  const length = source.length;
  const units = new Uint16Array(length);
  const starts = new Int32Array(length + 1);
  let out = 0;
  let changed = false;

  for (let i = 0; i < length;) {
    const unit = source.charCodeAt(i);
    if (unit < 0x80) {
      if ((unit >= 0x20 && unit < 0x7f) || unit === 0x09 || unit === 0x0a || unit === 0x0d) {
        units[out] = unit;
        starts[out] = i;
        out += 1;
      } else {
        changed = true;
      }
      i += 1;
      continue;
    }

    let codePoint = unit;
    let size = 1;
    if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < length) {
      const next = source.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        codePoint = 0x10000 + ((unit - 0xd800) << 10) + (next - 0xdc00);
        size = 2;
      }
    }

    const folded = foldCodePoint(codePoint);
    if (folded === STRIP) {
      changed = true;
    } else if (folded === codePoint) {
      for (let k = 0; k < size; k += 1) {
        units[out] = source.charCodeAt(i + k);
        starts[out] = i;
        out += 1;
      }
    } else {
      changed = true;
      if (folded > 0xffff) {
        const offset = folded - 0x10000;
        units[out] = 0xd800 + (offset >> 10);
        starts[out] = i;
        units[out + 1] = 0xdc00 + (offset & 0x3ff);
        starts[out + 1] = i;
        out += 2;
      } else {
        units[out] = folded;
        starts[out] = i;
        out += 1;
      }
    }
    i += size;
  }

  if (!changed) return null;
  starts[out] = length;
  return { text: unitsToString(units, out), starts: starts.subarray(0, out + 1) };
}
