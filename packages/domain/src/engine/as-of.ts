import { compareIso, toMs } from '../util/time';

/**
 * Predicate for "recorded at or before `asOf`", compared as instants. ISO strings that differ in
 * sub-second precision ("…:00Z" versus "…:00.500Z") do not sort like the instants they denote, so
 * string order is never used to decide what was known when. `null` means the whole record.
 */
export function knownAt(asOf: string | null): (iso: string) => boolean {
  if (asOf === null) return () => true;
  const limit = toMs(asOf);
  return (iso) => toMs(iso) <= limit;
}

/** The last step recorded at or before the boundary: where a replay of the prefix ends. */
export function lastStepAt<T extends { at: string }>(
  steps: readonly T[],
  known: (iso: string) => boolean,
): T | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step !== undefined && known(step.at)) return step;
  }
  return undefined;
}

/** Earlier-first comparison of nullable timestamps; a missing timestamp sorts before any instant. */
export function compareNullableIso(a: string | null, b: string | null): number {
  if (a === null) return b === null ? 0 : -1;
  return b === null ? 1 : compareIso(a, b);
}
