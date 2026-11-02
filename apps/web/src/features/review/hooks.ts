'use client';

import type {
  ActionRanking,
  AnalysisRun,
  CaseDetail,
  CaseWarning,
  CoachingReport,
  CounterfactualScenario,
  DiagnosticAction,
  ForkListResponse,
  MetricEstimate,
  Permission,
  QualityAssessment,
  ReviewState,
  SkillMatch,
  SkillOverlay,
} from '@caseguard/schemas';
import { useQueries } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { useApiQuery } from '../../lib/api/hooks';
import { useApiPages } from '../../lib/api/pages';
import { useApiClient } from '../../lib/api/provider';
import { queryKeys, staleTimeFor } from '../../lib/api/query-keys';
import { useAuth } from '../../lib/auth/context';
import { useSession } from '../../lib/auth/session';
import {
  denied,
  failed,
  loading,
  ready,
  type ClaimReviewRecord,
  type Source,
  type TimelineBundle,
} from './model/sources';

export type { ClaimReviewRecord, TimelineBundle } from './model/sources';

/**
 * The reads of the guided review, one hook each. A part of the page never waits for another and never fails the page:
 * each hook says whether its read is loading, was not made because the role may not read it (no request goes out, the
 * API would answer 403), failed, or is ready. The request shapes match the other case pages, so what they already read
 * is served from the cache.
 */

export interface Handle<T> {
  source: Source<T>;
  /** Asks again (for a read that failed); does nothing for a read that was denied. */
  retry: () => void;
  fetching: boolean;
  /** When the data was read, in milliseconds since the epoch (0 until it was). */
  readAt: number;
}

interface Gate {
  kind: 'loading' | 'failed' | 'granted' | 'denied';
  error: unknown;
  retry: () => void;
}

function useGate(permission: Permission): Gate {
  const auth = useAuth();
  const session = useSession();
  if (auth.status !== 'ready' || session.isLoading) {
    return { kind: 'loading', error: null, retry: session.refetch };
  }
  if (session.error) return { kind: 'failed', error: session.error, retry: session.refetch };
  return {
    kind: session.can(permission) ? 'granted' : 'denied',
    error: null,
    retry: session.refetch,
  };
}

interface BaseQuery {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  isFetching: boolean;
  dataUpdatedAt: number;
  refetch: () => unknown;
}

function handleOf<T>(
  gate: Gate,
  permission: Permission,
  query: BaseQuery,
  data: T | undefined,
): Handle<T> {
  const none = { fetching: false, readAt: 0 };
  if (gate.kind === 'denied')
    return { source: denied(permission), retry: () => undefined, ...none };
  if (gate.kind === 'failed') return { source: failed(gate.error), retry: gate.retry, ...none };
  if (gate.kind === 'loading') return { source: loading(), retry: () => undefined, ...none };
  const retry = (): void => void query.refetch();
  const base = { retry, fetching: query.isFetching, readAt: query.dataUpdatedAt };
  if (query.isError) return { ...base, source: failed(query.error) };
  if (query.isPending || data === undefined) return { ...base, source: loading() };
  return { ...base, source: ready(data) };
}

const whole = (caseId: string) => ({ params: { caseId }, query: {} });

export function useDetailHandle(caseId: string): Handle<CaseDetail> {
  const gate = useGate('case:read');
  const query = useApiQuery(
    'cases.get',
    { params: { caseId } },
    { enabled: gate.kind === 'granted' },
  );
  return handleOf(gate, 'case:read', query, query.data);
}

export function useRunHandle(caseId: string): Handle<AnalysisRun | null> {
  const gate = useGate('case:read');
  const query = useApiQuery(
    'analysis.latest',
    { params: { caseId } },
    { enabled: gate.kind === 'granted' },
  );
  return handleOf(gate, 'case:read', query, query.data ? query.data.run : undefined);
}

export function useQualityHandle(caseId: string): Handle<QualityAssessment> {
  const gate = useGate('quality:read');
  const query = useApiQuery('quality.get', whole(caseId), { enabled: gate.kind === 'granted' });
  return handleOf(gate, 'quality:read', query, query.data);
}

export function useMetricsHandle(caseId: string): Handle<MetricEstimate[]> {
  const gate = useGate('quality:read');
  const query = useApiQuery('metrics.get', whole(caseId), { enabled: gate.kind === 'granted' });
  return handleOf(gate, 'quality:read', query, query.data?.items);
}

export function useCoachingHandle(caseId: string): Handle<CoachingReport> {
  const gate = useGate('quality:read');
  const query = useApiQuery(
    'coaching.get',
    { params: { caseId } },
    { enabled: gate.kind === 'granted' },
  );
  return handleOf(gate, 'quality:read', query, query.data);
}

export function useForksHandle(caseId: string): Handle<ForkListResponse> {
  const gate = useGate('case:read');
  const query = useApiQuery('forks.list', whole(caseId), { enabled: gate.kind === 'granted' });
  return handleOf(gate, 'case:read', query, query.data);
}

export function useScenariosHandle(caseId: string): Handle<CounterfactualScenario[]> {
  const gate = useGate('case:read');
  const query = useApiQuery('counterfactuals.list', whole(caseId), {
    enabled: gate.kind === 'granted',
  });
  return handleOf(gate, 'case:read', query, query.data?.items);
}

export function useWarningsHandle(caseId: string): Handle<CaseWarning[]> {
  const gate = useGate('case:read');
  const query = useApiQuery(
    'warnings.list',
    { params: { caseId }, query: { state: 'all' as const } },
    { enabled: gate.kind === 'granted' },
  );
  return handleOf(gate, 'case:read', query, query.data?.items);
}

export function useRankingHandle(caseId: string): Handle<ActionRanking> {
  const gate = useGate('case:read');
  const query = useApiQuery('actionValue.rank', whole(caseId), {
    enabled: gate.kind === 'granted',
  });
  return handleOf(gate, 'case:read', query, query.data);
}

export function useActionsHandle(caseId: string, enabled = true): Handle<DiagnosticAction[]> {
  const gate = useGate('case:read');
  const query = useApiQuery('actions.list', whole(caseId), {
    enabled: gate.kind === 'granted' && enabled,
  });
  const handle = handleOf(gate, 'case:read', query, query.data?.items);
  // A read that was not asked for yet is not "loading": nothing is on its way.
  return !enabled && handle.source.kind === 'loading' ? { ...handle, fetching: false } : handle;
}

export function useMatchesHandle(caseId: string): Handle<SkillMatch[]> {
  const gate = useGate('skill:read');
  const query = useApiQuery('skillMatches.list', whole(caseId), {
    enabled: gate.kind === 'granted',
  });
  return handleOf(gate, 'skill:read', query, query.data?.items);
}

/** The reads of the skill overlay for each match: one request each, sharing the cache of the page that asked. */
export function useOverlayHandles(
  caseId: string,
  matchIds: readonly string[],
): Record<string, Handle<SkillOverlay>> {
  const client = useApiClient();
  const { identityKey } = useAuth();
  const gate = useGate('skill:read');
  const results = useQueries({
    queries: matchIds.map((matchId) => ({
      queryKey: queryKeys.request(identityKey, 'skillOverlay.get', { params: { caseId, matchId } }),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        client.call('skillOverlay.get', { params: { caseId, matchId }, signal }),
      staleTime: staleTimeFor('skillOverlay.get'),
      enabled: gate.kind === 'granted',
    })),
  });
  const waiting: BaseQuery = {
    isPending: true,
    isError: false,
    error: null,
    isFetching: false,
    dataUpdatedAt: 0,
    refetch: () => undefined,
  };
  return Object.fromEntries(
    matchIds.map((matchId, index) => {
      const result = results[index];
      return [matchId, handleOf(gate, 'skill:read', result ?? waiting, result?.data)] as const;
    }),
  );
}

/** Every event of the case is read, a page of 200 at a time, up to this many pages. */
const MAX_TIMELINE_PAGES = 5;

/** The whole timeline (it shares the cache of the Timeline page, which asks for the same pages). */
export function useTimelineHandle(caseId: string): Handle<TimelineBundle> {
  const gate = useGate('case:read');
  const pages = useApiPages(
    'timeline.get',
    { params: { caseId }, query: { limit: 200 } },
    { enabled: gate.kind === 'granted' },
  );
  const { hasNextPage, isFetchingNextPage, fetchNextPage, isError, data } = pages;
  const loaded = data?.pages.length ?? 0;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isError && loaded < MAX_TIMELINE_PAGES)
      void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, isError, loaded, fetchNextPage]);
  const complete = data !== undefined && (!hasNextPage || loaded >= MAX_TIMELINE_PAGES);
  const bundle = useMemo<TimelineBundle | undefined>(
    () =>
      data && complete
        ? {
            events: data.pages.flatMap((page) => page.events),
            total: data.pages[0]?.total ?? 0,
            truncated: hasNextPage,
          }
        : undefined,
    [data, complete, hasNextPage],
  );
  return handleOf(
    gate,
    'case:read',
    {
      isPending: pages.isPending || (data !== undefined && !complete && !isError),
      isError: pages.isError && !complete,
      error: pages.error,
      isFetching: pages.isFetching,
      dataUpdatedAt: pages.dataUpdatedAt,
      refetch: pages.refetch,
    },
    bundle,
  );
}

const REVIEWED: readonly Exclude<ReviewState, 'pending'>[] = ['confirmed', 'corrected', 'rejected'];

/** The claims a person reviewed, read once for the report (each state is a small filtered read of the ledger). */
export function useClaimReviewsHandle(
  caseId: string,
  enabled: boolean,
): Handle<ClaimReviewRecord[]> {
  const gate = useGate('case:read');
  const on = gate.kind === 'granted' && enabled;
  const confirmed = useApiQuery(
    'evidence.list',
    { params: { caseId }, query: { reviewState: 'confirmed', limit: 200 } },
    { enabled: on },
  );
  const corrected = useApiQuery(
    'evidence.list',
    { params: { caseId }, query: { reviewState: 'corrected', limit: 200 } },
    { enabled: on },
  );
  const rejected = useApiQuery(
    'evidence.list',
    { params: { caseId }, query: { reviewState: 'rejected', limit: 200 } },
    { enabled: on },
  );
  const all = [confirmed, corrected, rejected];
  const data = all.every((query) => query.data !== undefined)
    ? REVIEWED.flatMap((state, index) =>
        (all[index]?.data?.items ?? []).map((claim) => ({
          id: claim.id,
          text: claim.text,
          state,
          by: claim.reviewedBy,
          at: claim.reviewedAt,
          reason: claim.reviewReason,
        })),
      ).sort((a, b) => Date.parse(a.at ?? '') - Date.parse(b.at ?? ''))
    : undefined;
  const failedQuery = all.find((query) => query.isError);
  return handleOf(
    gate,
    'case:read',
    {
      isPending: enabled && data === undefined && !failedQuery,
      isError: failedQuery !== undefined,
      error: failedQuery?.error ?? null,
      isFetching: all.some((query) => query.isFetching),
      dataUpdatedAt: Math.max(...all.map((query) => query.dataUpdatedAt)),
      refetch: () => Promise.all(all.map((query) => query.refetch())),
    },
    data,
  );
}
