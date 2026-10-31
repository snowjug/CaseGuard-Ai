'use client';

import type { ActionRanking, DecisionFork } from '@caseguard/schemas';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { asOfCall, asOfFresh, snapToEvent, useEventInstants } from '../../components/case/as-of';
import { keepWithinBoundary } from '../../lib/api/boundary-placeholder';
import { useApiQuery } from '../../lib/api/hooks';
import { queryKeys } from '../../lib/api/query-keys';
import { useAuth } from '../../lib/auth/context';
import { instantBefore } from '../reasoning/time';
import { sameInstant } from './model';

/** The query string of an as-of read: the boundary when there is one, nothing otherwise (optional fields are omitted). */
const boundary = (asOf: string | null): { asOf?: string } => (asOf ? { asOf } : {});

/**
 * The Arena's reads. Every one carries the same boundary, so the whole page describes one instant, and none ever shows
 * the answer of another one: while a new boundary loads, the query is pending and the page shows its loading state,
 * because the previous answer (the whole record, or a later window) would put the numbers of another moment under the
 * name of the one the person chose. The previous answer stays on screen only for the SAME moment (a refetch). An earlier
 * view is metered by the server, so it is never retried behind the scenes (the page shows the wait itself) and a window
 * that was already computed stays fresh; a superseded request is cancelled by TanStack Query's abort signal. `ready`
 * holds an earlier view back until the cursor knows the case's event instants, so it is asked for once, on an event.
 */
const readOf = (caseId: string, asOf: string | null) => ({
  params: { caseId },
  query: boundary(asOf),
});

export function useHypotheses(caseId: string, asOf: string | null, ready = true) {
  const auth = useAuth();
  const read = readOf(caseId, asOf);
  return useApiQuery(
    'hypotheses.list',
    { ...read, ...asOfCall(asOf) },
    {
      enabled: auth.status === 'ready' && ready,
      placeholderData: keepWithinBoundary(read),
      ...asOfFresh(asOf),
    },
  );
}

export function useForks(caseId: string, asOf: string | null, ready = true) {
  const auth = useAuth();
  const read = readOf(caseId, asOf);
  return useApiQuery(
    'forks.list',
    { ...read, ...asOfCall(asOf) },
    {
      enabled: auth.status === 'ready' && ready,
      placeholderData: keepWithinBoundary(read),
      ...asOfFresh(asOf),
    },
  );
}

export function useActions(caseId: string, asOf: string | null, ready = true) {
  const auth = useAuth();
  const read = readOf(caseId, asOf);
  return useApiQuery(
    'actions.list',
    { ...read, ...asOfCall(asOf) },
    {
      enabled: auth.status === 'ready' && ready,
      placeholderData: keepWithinBoundary(read),
      ...asOfFresh(asOf),
    },
  );
}

export function useActionRanking(caseId: string, asOf: string | null, ready = true) {
  const auth = useAuth();
  const read = readOf(caseId, asOf);
  return useApiQuery(
    'actionValue.rank',
    { ...read, ...asOfCall(asOf) },
    {
      enabled: auth.status === 'ready' && ready,
      placeholderData: keepWithinBoundary(read),
      ...asOfFresh(asOf),
    },
  );
}

export interface DecisionPoint {
  /** The earliest meaningful decision fork, once the fork list is known. */
  fork: DecisionFork | null;
  /** The event instant just before its decision (what was known when it was taken); null until known, or when none. */
  asOf: string | null;
  /** True while the fork list or the case's event instants are still loading. */
  pending: boolean;
}

/**
 * The moment just before the earliest meaningful decision fork, on an event instant (the same window the "just before
 * the decision" shortcut and a time cursor land on, so the server shares one pass between them). It reads the
 * whole-record fork list (already on the page) and, when `wanted`, every event instant of the case; nothing is read
 * while it is not wanted.
 */
export function useDecisionPoint(caseId: string, wanted: boolean): DecisionPoint {
  const forks = useForks(caseId, null, wanted);
  const { instants, settled } = useEventInstants(caseId, wanted);
  const fork = forks.data?.items.find((item) => item.isEarliestMeaningful) ?? null;
  const asOf =
    fork !== null && instants !== null && instants.length > 0
      ? snapToEvent(instantBefore(fork.timestamp), instants)
      : null;
  return { fork, asOf, pending: wanted && (forks.isPending || !settled) };
}

/**
 * After a reviewer records an override, the response carries the whole-record list of reviewer overrides: the one view
 * that must show it at once. It replaces the cached whole-record ranking's list, and the whole ranking when the override
 * was about that ranking's own instant (the response is then that very ranking); the whole-record ranking is then read
 * again in the background. An earlier window is left alone: it cannot know a decision made after it, so nothing about it
 * changes and it is not asked for again (its read is metered).
 */
export function usePrimeWholeRecordRanking(): (caseId: string, response: ActionRanking) => void {
  const queryClient = useQueryClient();
  const { identityKey } = useAuth();
  return useCallback(
    (caseId, response) => {
      const key = queryKeys.request(identityKey, 'actionValue.rank', {
        params: { caseId },
        query: {},
      });
      queryClient.setQueryData<ActionRanking>(key, (cached) => {
        if (!cached) return undefined;
        if (sameInstant(cached.asOf, response.asOf)) return response;
        return { ...cached, reviewerOverrides: response.reviewerOverrides ?? [] };
      });
      void queryClient.invalidateQueries({ queryKey: key, exact: true });
    },
    [queryClient, identityKey],
  );
}
