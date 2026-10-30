'use client';

import type { RouteResponse } from '@caseguard/schemas';
import {
  useInfiniteQuery,
  type InfiniteData,
  type QueryKey,
  type UseInfiniteQueryOptions,
} from '@tanstack/react-query';
import { useAuth } from '../auth/context';
import type { ApiArgs } from './client';
import type { ApiError } from './errors';
import type { QueryInput, ReadRouteId } from './hooks';
import { useApiClient } from './provider';
import { queryKeys, staleTimeFor } from './query-keys';

/** Read routes whose response carries a `nextCursor` (cursor pagination): `cases.list`, `timeline.get`, `evidence.list`... */
export type PagedRouteId = {
  [K in ReadRouteId]: RouteResponse<K> extends { nextCursor: string | null } ? K : never;
}[ReadRouteId];

export type ApiPagesOptions<K extends PagedRouteId> = Omit<
  UseInfiniteQueryOptions<
    RouteResponse<K>,
    ApiError,
    InfiniteData<RouteResponse<K>, string | null>,
    QueryKey,
    string | null
  >,
  'queryKey' | 'queryFn' | 'getNextPageParam' | 'initialPageParam'
>;

interface RequestInput {
  params?: Record<string, unknown> | undefined;
  query?: Record<string, unknown> | undefined;
}

/**
 * What `QueryBoundary` should see for a paged query: a failed "load more" or a failed background refresh keeps the pages
 * already on screen (shown with an inline error by the page) instead of replacing them with the page-level error, and
 * loading the next page is not a "refresh" of the list.
 */
export function pagedBoundary<D>(query: {
  isPending: boolean;
  isError: boolean;
  error: ApiError | null;
  data: D | undefined;
  isFetching: boolean;
  isFetchingNextPage: boolean;
  refetch: () => unknown;
}) {
  return {
    isPending: query.isPending,
    isError: query.isError && query.data === undefined,
    error: query.error,
    data: query.data,
    isFetching: query.isFetching && !query.isFetchingNextPage,
    refetch: query.refetch,
  };
}

/**
 * Typed cursor pagination for a read route. The first page is requested without a cursor; `fetchNextPage()` asks for
 * the page after the last one with the `nextCursor` the API returned. The cache key extends the one `useApiQuery`
 * would use, so invalidating the route (`invalidateRoutes`) refreshes every loaded page.
 */
export function useApiPages<K extends PagedRouteId>(
  routeId: K,
  input: QueryInput<K>,
  options: ApiPagesOptions<K> = {},
) {
  const client = useApiClient();
  const { identityKey } = useAuth();
  const request = input as RequestInput | undefined;
  return useInfiniteQuery<
    RouteResponse<K>,
    ApiError,
    InfiniteData<RouteResponse<K>, string | null>,
    QueryKey,
    string | null
  >({
    queryKey: [...queryKeys.request(identityKey, routeId, request), 'pages'],
    initialPageParam: null,
    queryFn: ({ pageParam, signal }) => {
      const query = pageParam === null ? request?.query : { ...request?.query, cursor: pageParam };
      const call = { ...request, ...(query ? { query } : {}), signal };
      // The generic conditional argument tuple cannot be spread type-safely; `QueryInput` enforces the input type.
      return client.call(routeId, ...([call] as unknown as ApiArgs<K>));
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: staleTimeFor(routeId),
    ...options,
  });
}
