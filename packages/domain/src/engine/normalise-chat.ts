/**
 * Chat-style normalisation of the text the detectors read (wave 2).
 *
 * People write support messages the way they write chat: "ppl", "pls", "r", "somtimes", "didnt". The knowledge pack is
 * written in plain English, so before a pattern is tried the text is normalised with a FIXED, reviewed list of
 * abbreviations and common typos: whole words only, no fuzzy matching, no guessing. Every replacement keeps a map to
 * the stored text, so a match found in the normalised text is reported at its place in the original, and excerpts and
 * source references still point at what the writer wrote.
 */

export interface ScanMap {
  /** For each index of the normalised text, where the word it came from starts in the original text. */
  readonly start: Int32Array;
  /** For each index of the normalised text, where the word it came from ends in the original text (exclusive). */
  readonly end: Int32Array;
}

export interface NormalisedText {
  readonly text: string;
  /** Null when nothing was replaced: positions in `text` are then positions in the original. */
  readonly map: ScanMap | null;
}

/** Abbreviations and chat shorthand: whole words, lower case. */
const ABBREVIATIONS: Readonly<Record<string, string>> = {
  ppl: 'people',
  pls: 'please',
  plz: 'please',
  thru: 'through',
  tho: 'though',
  cuz: 'because',
  bc: 'because',
  b4: 'before',
  msg: 'message',
  msgs: 'messages',
  acct: 'account',
  pwd: 'password',
  pw: 'password',
  lb: 'load balancer',
  tmrw: 'tomorrow',
  tomo: 'tomorrow',
  tue: 'tuesday',
  tues: 'tuesday',
  thu: 'thursday',
  thur: 'thursday',
  thurs: 'thursday',
  fri: 'friday',
  ur: 'your',
};

/** Negations typed without the apostrophe. */
const CONTRACTIONS: Readonly<Record<string, string>> = {
  dont: "don't",
  doesnt: "doesn't",
  didnt: "didn't",
  cant: "can't",
  wont: "won't",
  isnt: "isn't",
  arent: "aren't",
  wasnt: "wasn't",
  werent: "weren't",
  havent: "haven't",
  hasnt: "hasn't",
  couldnt: "couldn't",
  wouldnt: "wouldn't",
  shouldnt: "shouldn't",
};

/** Typos that are common enough to be worth a line, each one the misspelling of exactly one word. */
const TYPOS: Readonly<Record<string, string>> = {
  somtimes: 'sometimes',
  sometims: 'sometimes',
  sometimez: 'sometimes',
  agian: 'again',
  agin: 'again',
  peple: 'people',
  poeple: 'people',
  pepole: 'people',
  peaple: 'people',
  ofice: 'office',
  offce: 'office',
  colegues: 'colleagues',
  collegues: 'colleagues',
  colleages: 'colleagues',
  coleagues: 'colleagues',
  sice: 'since',
  mornig: 'morning',
  geting: 'getting',
  problm: 'problem',
  probelm: 'problem',
  problme: 'problem',
  recieved: 'received',
  teh: 'the',
  taht: 'that',
  wiht: 'with',
  becuase: 'because',
  becasue: 'because',
  untill: 'until',
  occured: 'occurred',
  thier: 'their',
  reinstal: 'reinstall',
  loging: 'logging',
};

const LEXICON: ReadonlyMap<string, string> = new Map(
  Object.entries({ ...ABBREVIATIONS, ...CONTRACTIONS, ...TYPOS }),
);

/** The number of entries, for the test that each one has a positive example and a look-alike. */
export const NORMALISATION_ENTRIES: ReadonlyMap<string, string> = LEXICON;

const WORD = /[A-Za-z][A-Za-z0-9']*/g;
const isSpace = (char: string | undefined): boolean => char === undefined || /\s/.test(char);

/** `r` and `u` are words only when they stand alone, in lower case, between spaces or punctuation that ends a phrase. */
function replacementFor(word: string, text: string, index: number): string | undefined {
  if (word === 'r' || word === 'u') {
    const before = text[index - 1];
    const after = text[index + 1];
    if (!isSpace(before) && before !== '(') return undefined;
    if (!isSpace(after) && !',.;:!?)'.includes(after ?? ' ')) return undefined;
    return word === 'r' ? 'are' : 'you';
  }
  return LEXICON.get(word.toLowerCase());
}

/** The text with the listed abbreviations and typos replaced, and the map back to the original. */
export function normaliseChatStyle(text: string): NormalisedText {
  const found: { index: number; length: number; replacement: string }[] = [];
  for (const match of text.matchAll(WORD)) {
    const word = match[0] ?? '';
    const index = match.index ?? 0;
    const replacement = replacementFor(word, text, index);
    if (replacement !== undefined) found.push({ index, length: word.length, replacement });
  }
  if (found.length === 0) return { text, map: null };
  return assemble(text, found);
}

/**
 * Builds the normalised text piece by piece: an unchanged run keeps one-to-one positions, a replaced word maps
 * wholly (every character of the replacement) to the word it replaced.
 */
function assemble(
  text: string,
  found: readonly { index: number; length: number; replacement: string }[],
): NormalisedText {
  const parts: string[] = [];
  const start: number[] = [];
  const end: number[] = [];
  let at = 0;
  for (const item of found) {
    if (item.index > at) {
      parts.push(text.slice(at, item.index));
      for (let i = at; i < item.index; i += 1) {
        start.push(i);
        end.push(i + 1);
      }
    }
    parts.push(item.replacement);
    for (let i = 0; i < item.replacement.length; i += 1) {
      start.push(item.index);
      end.push(item.index + item.length);
    }
    at = item.index + item.length;
  }
  if (at < text.length) {
    parts.push(text.slice(at));
    for (let i = at; i < text.length; i += 1) {
      start.push(i);
      end.push(i + 1);
    }
  }
  return {
    text: parts.join(''),
    map: { start: Int32Array.from(start), end: Int32Array.from(end) },
  };
}

/** Where a span of the normalised text lies in the original: from the start of its first word to the end of its last. */
export function toOriginalSpan(
  map: ScanMap | null,
  start: number,
  end: number,
): { start: number; end: number } {
  if (map === null) return { start, end };
  const length = map.start.length;
  if (length === 0) return { start, end };
  const from = start >= length ? (map.end[length - 1] ?? start) : (map.start[start] ?? start);
  if (end <= start) return { start: from, end: from };
  const to = end > length ? (map.end[length - 1] ?? end) : (map.end[end - 1] ?? end);
  return { start: from, end: to };
}
