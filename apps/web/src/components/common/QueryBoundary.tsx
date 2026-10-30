'use client';

import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { ApiError } from '../../lib/api/errors';
import { useAuth } from '../../lib/auth/context';
import { IdentityRequired } from './IdentityRequired';
import { QueryErrorState } from './QueryErrorState';

export interface QueryBoundaryMeta {
  /** True while data is being refetched (or replaced after a parameter change) and the previous data is on screen. */
  isRefreshing: boolean;
}

export interface QueryBoundaryProps<T> {
  /** The result of `useApiQuery`. */
  query: UseQueryResult<T, ApiError>;
  /** Shown during the first load (the page's own skeleton: it should match the final layout). */
  skeleton: ReactNode;
  /** Headline noun for errors: "The Command Center". */
  subject?: string;
  /** True when the loaded data is empty; `empty` is shown instead of `children`. */
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  children: (data: T, meta: QueryBoundaryMeta) => ReactNode;
}

/**
 * The standard page-level state machine for one query: identity required, loading skeleton, error with Retry, empty
 * state, then the data. Wrap every page's main query in it so all pages behave the same way.
 */
export function QueryBoundary<T>({
  query,
  skeleton,
  subject,
  isEmpty,
  empty,
  children,
}: QueryBoundaryProps<T>) {
  const auth = useAuth();
  if (auth.status === 'unauthenticated') return <IdentityRequired />;
  if (auth.status === 'loading' || query.isPending) return <>{skeleton}</>;
  if (query.isError) {
    return (
      <QueryErrorState
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
        {...(subject ? { subject } : {})}
      />
    );
  }
  if (isEmpty?.(query.data)) return <>{empty}</>;
  return <>{children(query.data, { isRefreshing: query.isFetching })}</>;
}
