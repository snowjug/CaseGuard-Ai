'use client';

import type { CaseDetail } from '@caseguard/schemas';
import { useBreadcrumbLabel } from '../../lib/breadcrumbs';
import { useApiQuery } from '../../lib/api/hooks';
import { useAuth } from '../../lib/auth/context';
import { asOfCall, asOfFresh } from './as-of';

/** The case record (`cases.get`) of the URL's case, with the breadcrumb showing its reference instead of its id. */
export function useCaseDetail(caseId: string) {
  const auth = useAuth();
  const query = useApiQuery(
    'cases.get',
    { params: { caseId } },
    { enabled: auth.status === 'ready' },
  );
  useBreadcrumbLabel(`case:${caseId}`, query.data?.reference);
  return query;
}

export interface CaseTimeRange {
  /** First instant of the case (ISO UTC). */
  min: string;
  /** Last instant of the case (ISO UTC). */
  max: string;
}

/** The span the time cursor scrubs: from the first recorded event to the last one. */
export function caseTimeRange(
  detail: Pick<CaseDetail, 'openedAt' | 'firstEventAt' | 'lastEventAt'> | undefined,
): CaseTimeRange | null {
  if (!detail) return null;
  const min = detail.firstEventAt ?? detail.openedAt;
  const max = detail.lastEventAt ?? min;
  return Date.parse(max) > Date.parse(min) ? { min, max } : null;
}

/**
 * What was known at `asOf`: the counts the API computed from the events up to that instant (and how many later events
 * it withheld). A one-row timeline request carries exactly that summary without any event content. Not requested
 * while no boundary is set, nor before `ready` (the cursor's event instants are still loading). Not retried behind the
 * scenes: a metered view that is refused (429) is shown by the page, with its wait.
 */
export function useKnownAt(caseId: string, asOf: string | null, ready = true) {
  const auth = useAuth();
  return useApiQuery(
    'timeline.get',
    { params: { caseId }, query: { limit: 1, ...(asOf ? { asOf } : {}) }, ...asOfCall(asOf) },
    { enabled: auth.status === 'ready' && asOf !== null && ready, ...asOfFresh(asOf) },
  );
}
