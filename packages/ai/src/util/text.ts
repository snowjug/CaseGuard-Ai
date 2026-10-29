export { estimateTokens } from '@caseguard/domain';

const STOPWORDS: ReadonlySet<string> = new Set([
  'the',
  'and',
  'for',
  'that',
  'this',
  'with',
  'was',
  'were',
  'are',
  'from',
  'have',
  'has',
  'had',
  'not',
  'but',
  'its',
  'into',
  'than',
  'then',
  'there',
  'their',
  'they',
  'been',
  'being',
  'will',
  'would',
  'could',
  'should',
  'about',
  'which',
  'when',
  'what',
  'who',
  'how',
  'can',
  'may',
  'also',
  'such',
  'some',
  'any',
  'all',
  'one',
  'two',
  'out',
  'our',
  'you',
  'your',
  'per',
  'via',
  'still',
  'only',
  'more',
  'most',
  'very',
  'after',
  'before',
]);

/** Truncates to `max` characters, marking the cut so a reader knows text is missing. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export const collapseWhitespace = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Canonical form used for duplicate detection and cache similarity (case and spacing insensitive). */
export const normalizeText = (text: string): string => collapseWhitespace(text).toLowerCase();

/** Lower-case content words (length >= 3, stop words removed) used for lexical support checks. */
export function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9._-]+/)
    .map((w) => w.replace(/^[._-]+|[._-]+$/g, ''))
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

/** Share of `claim` words that also occur in `source` (1 when the claim has no content words). */
export function containment(claim: ReadonlySet<string>, source: ReadonlySet<string>): number {
  if (claim.size === 0) return 1;
  let shared = 0;
  for (const word of claim) if (source.has(word)) shared++;
  return shared / claim.size;
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of small) if (large.has(item)) shared++;
  return shared / (a.size + b.size - shared);
}

/** Overlapping word n-grams of a text, used to detect verbatim copying (punctuation-insensitive). */
export function wordShingles(text: string, size: number): Set<string> {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9._-]+/)
    .map((w) => w.replace(/^[._-]+|[._-]+$/g, ''))
    .filter((w) => w.length > 0);
  const out = new Set<string>();
  for (let i = 0; i + size <= words.length; i++) out.add(words.slice(i, i + size).join(' '));
  return out;
}
