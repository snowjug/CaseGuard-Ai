import { compareIso } from '@caseguard/domain';
import type { CaseListItem } from '../../db';

/**
 * The case the command center describes when none was asked for (or the asked-for one is gone): the
 * most recently analysed case, else the newest case, else none.
 */
export function defaultCaseId(
  analysed: readonly CaseListItem[],
  newestId: string | null,
): string | null {
  const latest = [...analysed]
    .filter((item) => item.analyzedAt !== null)
    .sort(
      (a, b) =>
        compareIso(b.analyzedAt ?? b.openedAt, a.analyzedAt ?? a.openedAt) ||
        compareIso(b.openedAt, a.openedAt) ||
        b.id.localeCompare(a.id),
    )[0];
  return latest?.id ?? newestId;
}

/**
 * The analysed case opened just before `active`: the only honest thing a trend can compare with, because
 * a case keeps only its latest analysis. Null when `active` is the oldest analysed case.
 */
export function previousAnalysedCase(
  analysed: readonly CaseListItem[],
  active: Pick<CaseListItem, 'id' | 'openedAt'>,
): CaseListItem | null {
  return (
    [...analysed]
      .filter((item) => item.id !== active.id && compareIso(item.openedAt, active.openedAt) < 0)
      .sort((a, b) => compareIso(b.openedAt, a.openedAt) || b.id.localeCompare(a.id))[0] ?? null
  );
}
