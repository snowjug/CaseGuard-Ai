import {
  REDACTION_CATEGORIES,
  type RedactionCategory,
  type RedactionFinding,
} from '@caseguard/schemas';
import { placeholderFor } from './rules';

/** Replacement counts per category for one input. Never holds matched text. */
export interface RedactionTally {
  readonly counts: Map<RedactionCategory, number>;
}

export function createTally(): RedactionTally {
  return { counts: new Map() };
}

export function countHit(tally: RedactionTally, category: RedactionCategory, by = 1): void {
  tally.counts.set(category, (tally.counts.get(category) ?? 0) + by);
}

export function mergeCounts(into: RedactionTally, from: RedactionTally): void {
  for (const [category, count] of from.counts) countHit(into, category, count);
}

export function findingsFrom(tally: RedactionTally): RedactionFinding[] {
  return REDACTION_CATEGORIES.filter((category) => (tally.counts.get(category) ?? 0) > 0).map(
    (category) => ({
      category,
      count: tally.counts.get(category) ?? 0,
      placeholder: placeholderFor(category),
    }),
  );
}

export function totalOf(tally: RedactionTally): number {
  let total = 0;
  for (const count of tally.counts.values()) total += count;
  return total;
}
