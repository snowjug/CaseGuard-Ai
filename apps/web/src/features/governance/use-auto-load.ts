'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useNearEnd } from '../../lib/virtual-list';

/** The parts of an infinite query that loading more pages depends on. */
export interface PagedLoadState {
  hasNextPage: boolean;
  isFetching: boolean;
  /** A failed request of any kind: the page after the last one, or a refresh of the pages already loaded. */
  isError: boolean;
  isFetchNextPageError: boolean;
  fetchNextPage: () => unknown;
  refetch: () => unknown;
}

/**
 * Infinite scrolling for a paged list: attach the returned ref to an empty element after the list. More pages are
 * requested by themselves only while the query is idle and healthy. After a failed request nothing is requested any
 * more until the person chooses Retry: the near-end observer reports whenever the end of the list comes into view
 * (and again whenever it is rebuilt), so asking again by itself would repeat a request that keeps failing. The
 * callback keeps its identity, so the observer is not rebuilt when a request starts or ends.
 */
export function useAutoLoadNext(query: PagedLoadState): (node: HTMLElement | null) => void {
  const { hasNextPage, isFetching, isError, fetchNextPage } = query;
  const latest = useRef(fetchNextPage);
  useEffect(() => {
    latest.current = fetchNextPage;
  });
  const onNearEnd = useCallback(() => {
    void latest.current();
  }, []);
  return useNearEnd(hasNextPage && !isFetching && !isError, onNearEnd);
}

/** Retry after a failure: the page that failed to load, or the refresh that failed. */
export function retryPages(
  query: Pick<PagedLoadState, 'isFetchNextPageError' | 'fetchNextPage' | 'refetch'>,
): void {
  if (query.isFetchNextPageError) void query.fetchNextPage();
  else void query.refetch();
}
