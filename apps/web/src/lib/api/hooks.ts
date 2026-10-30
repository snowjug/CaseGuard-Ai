'use client';

import type { Job, JobStatus, RouteId, RouteResponse, ROUTES } from '@caseguard/schemas';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationOptions,
  type UseQueryOptions,
} from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useAuth } from '../auth/context';
import type { ApiArgs, ApiInput } from './client';
import type { ApiError } from './errors';
import { useApiClient } from './provider';
import { invalidateRoutes, queryKeys, staleTimeFor } from './query-keys';

/** Routes that only read (their method is GET): usable with `useApiQuery`. */
export type ReadRouteId = {
  [K in RouteId]: (typeof ROUTES)[K]['method'] extends 'GET' ? K : never;
}[RouteId];
/** Routes that change state: usable with `useApiMutation`. */
export type WriteRouteId = Exclude<RouteId, ReadRouteId>;

/** Input of a query: required exactly when the route needs params or a query. Pass `undefined` for routes that need nothing. */
export type QueryInput<K extends ReadRouteId> =
  object extends ApiInput<K> ? ApiInput<K> | undefined : ApiInput<K>;

export type ApiQueryOptions<K extends ReadRouteId> = Omit<
  UseQueryOptions<RouteResponse<K>, ApiError, RouteResponse<K>>,
  'queryKey' | 'queryFn'
>;

/**
 * Typed GET. The route id fixes the params, query and response types (from the schema registry); the cache key is
 * partitioned by identity; the abort signal from TanStack cancels the request when the component goes away.
 */
export function useApiQuery<K extends ReadRouteId>(
  routeId: K,
  input: QueryInput<K>,
  options: ApiQueryOptions<K> = {},
) {
  const client = useApiClient();
  const { identityKey } = useAuth();
  const keyInput = input as
    { params?: Record<string, unknown>; query?: Record<string, unknown> } | undefined;
  return useQuery<RouteResponse<K>, ApiError, RouteResponse<K>>({
    queryKey: queryKeys.request(identityKey, routeId, keyInput),
    // The generic conditional argument tuple cannot be spread type-safely; the input type is enforced by QueryInput.
    queryFn: ({ signal }) =>
      client.call(routeId, ...([{ ...(input ?? {}), signal }] as unknown as ApiArgs<K>)),
    staleTime: staleTimeFor(routeId),
    ...options,
  });
}

export interface ApiMutationOptions<K extends WriteRouteId> extends Omit<
  UseMutationOptions<RouteResponse<K>, ApiError, ApiInput<K>>,
  'mutationFn'
> {
  /** Routes whose cached data is stale after success; they are refetched if on screen. */
  invalidate?: readonly RouteId[];
}

/**
 * Typed write. Idempotent routes get an `Idempotency-Key` automatically (pass `idempotencyKey` in the input to
 * supply your own). Non-idempotent writes are never retried.
 */
export function useApiMutation<K extends WriteRouteId>(
  routeId: K,
  options: ApiMutationOptions<K> = {},
) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { identityKey } = useAuth();
  const { invalidate = [], onSuccess, ...rest } = options;
  return useMutation<RouteResponse<K>, ApiError, ApiInput<K>>({
    ...rest,
    mutationFn: (input) => client.call(routeId, ...([input] as unknown as ApiArgs<K>)),
    onSuccess: async (data, variables, onMutateResult, context) => {
      await invalidateRoutes(queryClient, identityKey, invalidate);
      await onSuccess?.(data, variables, onMutateResult, context);
    },
  });
}

const TERMINAL: readonly JobStatus[] = ['succeeded', 'failed', 'cancelled'];

/** True once a job can no longer change. */
export function isTerminalJob(status: JobStatus | undefined): boolean {
  return status !== undefined && TERMINAL.includes(status);
}

/** Polling cadence: quick at first, slower for long-running jobs (milliseconds). */
export function jobPollInterval(updateCount: number): number {
  if (updateCount < 10) return 800;
  if (updateCount < 40) return 2000;
  return 5000;
}

export interface UseJobOptions {
  /** Called once when the job reaches a terminal state (succeeded, failed or cancelled). */
  onTerminal?: (job: Job) => void;
  enabled?: boolean;
}

/**
 * Polls `jobs.get` until the job is terminal and exposes progress for a progress bar. Polling stops by itself and
 * never continues after the component unmounts (TanStack Query cancels the interval).
 */
export function useJob(jobId: string | null | undefined, options: UseJobOptions = {}) {
  const query = useApiQuery(
    'jobs.get',
    { params: { jobId: jobId ?? '' } },
    {
      enabled: Boolean(jobId) && (options.enabled ?? true),
      staleTime: 0,
      refetchInterval: (q) =>
        isTerminalJob(q.state.data?.status) ? false : jobPollInterval(q.state.dataUpdateCount),
    },
  );
  const job = query.data;
  const notified = useRef<string | null>(null);
  const { onTerminal } = options;
  useEffect(() => {
    if (job && isTerminalJob(job.status) && notified.current !== job.id) {
      notified.current = job.id;
      onTerminal?.(job);
    }
  }, [job, onTerminal]);

  return {
    job,
    status: job?.status,
    percent: job?.progress.percent ?? 0,
    stage: job?.progress.stage ?? '',
    stages: job?.progress.stages ?? [],
    isTerminal: isTerminalJob(job?.status),
    isRunning: job?.status === 'running' || job?.status === 'queued',
    error: query.error,
    refetch: query.refetch,
  };
}
