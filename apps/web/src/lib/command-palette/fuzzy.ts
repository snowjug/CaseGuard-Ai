export interface FuzzyResult {
  /** Higher is better. */
  score: number;
  /** Indices in `text` of the matched characters (for highlighting). */
  indices: number[];
}

const isBoundary = (text: string, index: number): boolean => {
  if (index === 0) return true;
  const previous = text.charAt(index - 1);
  return (
    previous === ' ' ||
    previous === '-' ||
    previous === '_' ||
    previous === '.' ||
    previous === '/' ||
    previous === ':'
  );
};

/**
 * Case-insensitive fuzzy match. A contiguous substring always beats a scattered subsequence; within a subsequence,
 * consecutive characters and word starts score higher. Returns `null` when the query is not a subsequence of the text.
 */
export function fuzzyMatch(query: string, text: string): FuzzyResult | null {
  const q = query.trim().toLowerCase();
  if (q === '') return { score: 0, indices: [] };
  const t = text.toLowerCase();

  const contiguous = t.indexOf(q);
  if (contiguous !== -1) {
    const indices = Array.from({ length: q.length }, (_, i) => contiguous + i);
    const boundaryBonus = isBoundary(t, contiguous) ? 40 : 0;
    return { score: 1000 + boundaryBonus - contiguous * 2 - (t.length - q.length) * 0.1, indices };
  }

  const indices: number[] = [];
  let score = 0;
  let cursor = 0;
  let previousMatch = -2;
  for (const char of q) {
    const found = t.indexOf(char, cursor);
    if (found === -1) return null;
    score += 10;
    if (found === previousMatch + 1) score += 12;
    if (isBoundary(t, found)) score += 8;
    score -= Math.min(5, found - cursor) * 0.5;
    indices.push(found);
    previousMatch = found;
    cursor = found + 1;
  }
  return { score, indices };
}

export interface Searchable {
  label: string;
  keywords?: string | undefined;
}

export interface RankedItem<T> {
  item: T;
  score: number;
  /** Matched character positions in `label` (empty when the match came from the keywords). */
  indices: number[];
}

/** Filters and ranks items by label (and, with a lower weight, keywords). An empty query keeps the original order. */
export function rankByQuery<T extends Searchable>(
  query: string,
  items: readonly T[],
): RankedItem<T>[] {
  if (query.trim() === '') return items.map((item) => ({ item, score: 0, indices: [] }));
  const ranked: RankedItem<T>[] = [];
  for (const item of items) {
    const byLabel = fuzzyMatch(query, item.label);
    if (byLabel) {
      ranked.push({ item, score: byLabel.score, indices: byLabel.indices });
      continue;
    }
    const byKeywords = item.keywords ? fuzzyMatch(query, item.keywords) : null;
    if (byKeywords) ranked.push({ item, score: byKeywords.score * 0.5, indices: [] });
  }
  return ranked.sort((a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label));
}
