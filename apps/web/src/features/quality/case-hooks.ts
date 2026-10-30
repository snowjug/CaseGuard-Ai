'use client';

import type { CaseDetail } from '@caseguard/schemas';
import { formatDateTimeUtc } from '@caseguard/ui';
import { asOfCall, asOfFresh } from '../../components/case/as-of';
import { keepWithinBoundary } from '../../lib/api/boundary-placeholder';
import { useApiQuery } from '../../lib/api/hooks';
import { useAuth } from '../../lib/auth/context';
import { useBreadcrumbLabel } from '../../lib/breadcrumbs';

/** The query string of an as-of read: the boundary when there is one, nothing otherwise (optional fields are omitted). */
export const boundary = (asOf: string | null): { asOf?: string } => (asOf ? { asOf } : {});

/** `9 Mar 2026, 12:30 UTC`, with seconds only when the boundary has some, so `12:30:45` is never shown as `12:30`. */
export function formatBoundary(iso: string): string {
  const ms = Date.parse(iso);
  return formatDateTimeUtc(iso, {
    seconds: Number.isFinite(ms) && new Date(ms).getUTCSeconds() !== 0,
  });
}

/** The case record: reference and title for the header, first and last event for the time cursor, analysis state. */
export function useCaseRecord(caseId: string) {
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
  min: string;
  max: string;
}

/** The span the time cursor scrubs: from the first recorded event to the last one, or null for a single instant. */
export function caseTimeRange(
  detail: Pick<CaseDetail, 'openedAt' | 'firstEventAt' | 'lastEventAt'> | undefined,
): CaseTimeRange | null {
  if (!detail) return null;
  const min = detail.firstEventAt ?? detail.openedAt;
  const max = detail.lastEventAt ?? min;
  return Date.parse(max) > Date.parse(min) ? { min, max } : null;
}

/*
 * The reads of the review at a moment. Every one carries the same boundary, so the whole page describes one instant, and
 * every one follows the protocol of the case pages (`components/case/as-of`):
 *  - an earlier view is metered by the server, so it is never retried behind the scenes (`asOfCall`): the panel shows the
 *    wait itself, with its countdown, and a window that was already computed stays fresh (`asOfFresh`);
 *  - the previous answer stays on screen only for the SAME moment (`keepWithinBoundary`). Across a boundary the query is
 *    pending and the panel shows its loading state, because the answer of the whole record, or of a later window, would
 *    put the scores, warnings and matches of another moment under the name of the one the person chose;
 *  - `ready` holds an earlier view back until the cursor knows the case's event instants, so it is asked for once, on an
 *    event, and never for an arbitrary minute.
 * A superseded request is cancelled by TanStack Query's abort signal.
 */

/** The Case Quality Index at the boundary (`quality.get`). */
export function useQualityAt(caseId: string, asOf: string | null, ready = true) {
  const auth = useAuth();
  const read = { params: { caseId }, query: boundary(asOf) };
  return useApiQuery(
    'quality.get',
    { ...read, ...asOfCall(asOf) },
    {
      enabled: auth.status === 'ready' && ready,
      placeholderData: keepWithinBoundary(read),
      ...asOfFresh(asOf),
    },
  );
}

/** Avoidable Support Effort and the other metric estimates at the boundary (`metrics.get`). */
export function useMetricsAt(caseId: string, asOf: string | null, ready = true) {
  const auth = useAuth();
  const read = { params: { caseId }, query: boundary(asOf) };
  return useApiQuery(
    'metrics.get',
    { ...read, ...asOfCall(asOf) },
    {
      enabled: auth.status === 'ready' && ready,
      placeholderData: keepWithinBoundary(read),
      ...asOfFresh(asOf),
    },
  );
}

/** Every warning of the case, with its state as it stood at the boundary (`warnings.list`). */
export function useWarningsAt(caseId: string, asOf: string | null, ready = true) {
  const auth = useAuth();
  const read = { params: { caseId }, query: { state: 'all' as const, ...boundary(asOf) } };
  return useApiQuery(
    'warnings.list',
    { ...read, ...asOfCall(asOf) },
    {
      enabled: auth.status === 'ready' && ready,
      placeholderData: keepWithinBoundary(read),
      ...asOfFresh(asOf),
    },
  );
}

/** The skills that fit the case, matched from only what was known at the boundary (`skillMatches.list`). */
export function useSkillMatchesAt(caseId: string, asOf: string | null, ready = true) {
  const auth = useAuth();
  const read = { params: { caseId }, query: boundary(asOf) };
  return useApiQuery(
    'skillMatches.list',
    { ...read, ...asOfCall(asOf) },
    {
      enabled: auth.status === 'ready' && ready,
      placeholderData: keepWithinBoundary(read),
      ...asOfFresh(asOf),
    },
  );
}
