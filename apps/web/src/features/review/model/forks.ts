import type { DecisionFork, ForkListResponse } from '@caseguard/schemas';

/**
 * The decision points of the case in the order a reader meets them: earliest first, the engine's sequence breaking a
 * tie. The review numbers them in this order everywhere (the chronology strip, the explanations, the report).
 */
export function orderForks(forks: readonly DecisionFork[]): DecisionFork[] {
  return [...forks].sort(
    (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.sequence - b.sequence,
  );
}

/** The decision point the engine marks as the earliest meaningful one, or `null` when none is marked. */
export function earliestFork(forks: ForkListResponse): DecisionFork | null {
  const ordered = orderForks(forks.items);
  return (
    ordered.find((fork) => fork.id === forks.earliestMeaningfulForkId) ??
    ordered.find((fork) => fork.isEarliestMeaningful) ??
    null
  );
}

/** The first alternative that was safe to take (the engine lists them best first), or `null`. */
export function betterAlternative(fork: DecisionFork): DecisionFork['alternatives'][number] | null {
  return fork.alternatives.find((alternative) => alternative.safe) ?? null;
}
