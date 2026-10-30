'use client';

import type { ReactNode } from 'react';
import { AsOfLimited, isRateLimited } from '../../components/case/as-of';
import { IdentityRequired } from '../../components/common/IdentityRequired';
import { QueryErrorState } from '../../components/common/QueryErrorState';
import type { BoundaryQuery, QueryBoundaryMeta } from '../../components/common/QueryBoundary';
import { useAuth } from '../../lib/auth/context';
import { FailureNotice } from './FailureNotice';
import { explainFailure } from './failure';

export interface PanelBoundaryProps<T> {
  /** The result of `useApiQuery`; `errorUpdatedAt` restarts the countdown of a refused earlier view on each refusal. */
  query: BoundaryQuery<T> & { errorUpdatedAt?: number };
  skeleton: ReactNode;
  /** Headline noun for errors: "The quality index". */
  subject: string;
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  /**
   * The boundary the read was made at (`?asOf`), for a read of an earlier view. When the server refuses it for lack of
   * budget (429) the panel says so calmly, counts the wait down and offers a Retry, instead of failing.
   */
  asOf?: string | null;
  /** Offered with that notice: leave the earlier view for the whole record, which is never limited. */
  onWholeRecord?: () => void;
  children: (data: T, meta: QueryBoundaryMeta) => ReactNode;
}

/** "The quality index" becomes "the quality index": the noun phrase of a sentence. */
const nounPhrase = (subject: string): string => subject.charAt(0).toLowerCase() + subject.slice(1);

/**
 * The state machine of one panel of a page (identity, skeleton, error with Retry, empty, data). It differs from the
 * page-level `QueryBoundary` in one way: a throttled read (429 with `Retry-After`) is shown with how long to wait instead
 * of as a generic failure. A read of an earlier view that the server refuses (the budget for recomputing views is empty)
 * gets the shared calm notice of the case pages, with its countdown; any other throttle gets the plain one.
 */
export function PanelBoundary<T>({
  query,
  skeleton,
  subject,
  isEmpty,
  empty,
  asOf,
  onWholeRecord,
  children,
}: PanelBoundaryProps<T>) {
  const auth = useAuth();
  if (auth.status === 'unauthenticated') return <IdentityRequired />;
  if (auth.status === 'loading' || query.isPending) return <>{skeleton}</>;
  if (query.isError) {
    if (asOf && isRateLimited(query.error)) {
      return (
        <AsOfLimited
          key={query.errorUpdatedAt}
          error={query.error}
          subject={nounPhrase(subject)}
          compact
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
          onWholeRecord={onWholeRecord}
        />
      );
    }
    const failure = explainFailure(query.error);
    if (failure.kind === 'throttled') {
      return (
        <FailureNotice
          failure={failure}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      );
    }
    return (
      <QueryErrorState
        compact
        subject={subject}
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  const data = query.data;
  if (data === undefined) return <>{skeleton}</>;
  if (isEmpty?.(data)) return <>{empty}</>;
  return <>{children(data, { isRefreshing: query.isFetching })}</>;
}
