'use client';

import { Notice, VisuallyHidden, cg } from '@caseguard/ui';
import { Button, makeStyles } from '@fluentui/react-components';
import { ArrowSyncRegular, HistoryRegular } from '@fluentui/react-icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../lib/api/errors';
import { useApiPages } from '../../lib/api/pages';
import { hasReason } from '../../lib/api/reason';
import { useAuth } from '../../lib/auth/context';
import { useRetryCountdown } from '../../lib/use-retry-countdown';
import { useAsOfState } from '../../lib/url-state';

const useStyles = makeStyles({
  actions: { display: 'flex', flexWrap: 'wrap', gap: cg.space[2], marginTop: cg.space[2] },
});

/**
 * A window the server already computed cannot change (later events and later reviewer decisions are withheld from it),
 * so a visited window is kept for this long and showing it again costs nothing.
 */
export const AS_OF_STALE_MS = 10 * 60_000;

/** Request extras for an earlier view: no hidden retries (the page shows the wait itself, with its countdown). */
export function asOfCall(asOf: string | null): { maxRetries?: 0 } {
  return asOf === null ? {} : { maxRetries: 0 };
}

/** Query options for an earlier view: a window that was already computed stays fresh, and cached for as long. */
export function asOfFresh(asOf: string | null): { staleTime?: number; gcTime?: number } {
  return asOf === null ? {} : { staleTime: AS_OF_STALE_MS, gcTime: AS_OF_STALE_MS };
}

/** The `Problem.reason` of the 429 that says the budget for recomputing earlier views is empty (with `Retry-After`). */
export const ENGINE_BUDGET_REASON = 'engine_budget';

/**
 * True for the 429 of a metered earlier view: `reason: 'engine_budget'`, with `Retry-After`. A 429 that names no reason
 * (the API's general rate limit) is answered the same calm way, a countdown and a Retry; one that names any other reason
 * is not this limit, and is left to the page's ordinary error state.
 */
export function isRateLimited(error: unknown): error is ApiError {
  return (
    error instanceof ApiError &&
    error.status === 429 &&
    (error.reason === undefined || error.reason === ENGINE_BUDGET_REASON)
  );
}

/**
 * The last event instant at or before `instant`: the answer between two events is the same, so a time cursor lands on an
 * event instead of on an arbitrary minute (fewer distinct requests, and a boundary that means something). `instants` is
 * ascending. Before the first event there is nothing to land on, so the instant is returned as it is.
 */
export function snapToEvent(instant: string, instants: readonly string[]): string {
  const target = Date.parse(instant);
  if (!Number.isFinite(target) || instants.length === 0) return instant;
  let low = 0;
  let high = instants.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (Date.parse(instants[middle] ?? '') <= target) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found === -1 ? instant : (instants[found] ?? instant);
}

/** Cases with more events than this many pages are snapped against the instants loaded so far. */
const MAX_INSTANT_PAGES = 25;

/**
 * Every event instant of the case (ascending, unique), read from the whole-record timeline: a plain read that is not
 * metered. Only the instants are used, to snap and step the time cursor; nothing of a later event is shown. Shares the
 * cache of the unfiltered timeline, so the Timeline page does not ask twice. The first page is read at once (it holds
 * every event of all but the longest cases); the rest only when `walk` is set, so a long timeline is not downloaded
 * just in case, and the Timeline page keeps paging it by itself until an earlier moment is asked for.
 *
 * The walk stops at the first page that fails: it asks again only through `retry`, once per call, never by itself.
 */
export function useEventInstants(
  caseId: string,
  walk: boolean,
): {
  instants: readonly string[] | null;
  /** True once the instants are known or could not be loaded (a case that is not analysed has none). */
  settled: boolean;
  /** True when reading them failed for a reason that asking again could fix (not a case that is not analysed). */
  failed: boolean;
  /** Asks again for the page that failed. */
  retry: () => void;
} {
  const auth = useAuth();
  const pages = useApiPages(
    'timeline.get',
    { params: { caseId }, query: { limit: 200 } },
    { enabled: auth.status === 'ready' },
  );
  const { hasNextPage, isFetchingNextPage, fetchNextPage, isFetchNextPageError, refetch } = pages;
  const errored = pages.isError;
  const loaded = pages.data?.pages.length ?? 0;
  useEffect(() => {
    if (walk && hasNextPage && !isFetchingNextPage && !errored && loaded < MAX_INSTANT_PAGES)
      void fetchNextPage();
  }, [walk, hasNextPage, isFetchingNextPage, errored, loaded, fetchNextPage]);
  const retry = useCallback(() => {
    void (isFetchNextPageError ? fetchNextPage() : refetch());
  }, [isFetchNextPageError, fetchNextPage, refetch]);
  const complete = pages.data !== undefined && (!hasNextPage || loaded >= MAX_INSTANT_PAGES);
  const instants = useMemo(() => {
    if (!pages.data || !complete) return null;
    const all = pages.data.pages.flatMap((page) => page.events.map((event) => event.timestamp));
    return [...new Set(all)].sort((a, b) => Date.parse(a) - Date.parse(b));
  }, [pages.data, complete]);
  return {
    instants,
    settled: complete || errored,
    failed: errored && !complete && !hasReason(pages.error, 'not_analysed', 'conflict'),
    retry,
  };
}

export interface AsOfCursor {
  /** The boundary in force: the address's instant moved to the last event at or before it; `null` is the whole record. */
  asOf: string | null;
  /** Sets the boundary, moved to the last event at or before it. `null` returns to the whole record. */
  setAsOf: (asOf: string | null) => void;
  /** Whole-record event instants (ascending), or null while they are unknown. */
  instants: readonly string[] | null;
  /** False while an earlier view would still have to wait for the instants (it would be requested twice otherwise). */
  ready: boolean;
  /** True when an earlier moment is asked for and the event instants could not be read (the cursor cannot snap). */
  instantsFailed: boolean;
  /** Reads the event instants again, once per call. */
  retryInstants: () => void;
}

/**
 * `?asOf` for the case pages. Earlier views are metered on the server, and one computation serves every instant between
 * two events, so the boundary is always an event instant: a cursor that is dragged or typed lands on the last event at
 * or before it, an address with an arbitrary instant is read the same way, and every request names a window that can be
 * cached and shared.
 */
export function useAsOfCursor(caseId: string): AsOfCursor {
  const [requested, setRequested] = useAsOfState();
  const { instants, settled, failed, retry } = useEventInstants(caseId, requested !== null);
  const asOf =
    requested !== null && instants !== null ? snapToEvent(requested, instants) : requested;
  const setAsOf = useCallback(
    (next: string | null): void => {
      setRequested(next !== null && instants !== null ? snapToEvent(next, instants) : next);
    },
    [instants, setRequested],
  );
  return {
    asOf,
    setAsOf,
    instants,
    ready: requested === null || settled,
    instantsFailed: requested !== null && failed,
    retryInstants: retry,
  };
}

/** Seconds the server asked to wait (`Retry-After`), or 0 when it did not say. */
const waitOf = (error: ApiError): number =>
  error.retryAfterMs === undefined ? 0 : Math.max(1, Math.ceil(error.retryAfterMs / 1000));

export interface AsOfLimitedProps {
  error: ApiError;
  onRetry: () => void;
  retrying?: boolean;
  /** Also offer the whole record, which is never limited. */
  onWholeRecord?: (() => void) | undefined;
  /** What could not be worked out, as a noun phrase: "the timeline". */
  subject: string;
  compact?: boolean;
}

/**
 * A calm notice for a metered earlier view that could not be computed right now (429): why, how long to wait (the
 * server's `Retry-After`, counted down in the button) and a Retry. Windows already opened stay available, and so does the
 * whole record. Give it a `key` that changes with each failure so the countdown starts again.
 *
 * The countdown ticks every second, so neither the notice nor the button is a live region (a screen reader would read
 * it out each second). One static sentence is announced when the notice appears and one when the wait is over.
 */
export function AsOfLimited({
  error,
  onRetry,
  retrying = false,
  onWholeRecord,
  subject,
  compact = false,
}: AsOfLimitedProps) {
  const styles = useStyles();
  const [left] = useRetryCountdown(waitOf(error));
  const [asked] = useState(() => waitOf(error));
  const announcement =
    left > 0
      ? `Earlier views are limited. Try again in ${asked} ${asked === 1 ? 'second' : 'seconds'}.`
      : asked > 0
        ? 'You can retry now.'
        : 'Earlier views are limited. You can retry now.';
  return (
    <div>
      <Notice variant="info" title="Earlier views are limited" compact={compact}>
        Computing earlier views is limited to keep the service responsive, so {subject} could not be
        computed for this moment just now. Views you already opened stay available.
        <div className={styles.actions}>
          <Button
            appearance="primary"
            size={compact ? 'small' : 'medium'}
            icon={<ArrowSyncRegular />}
            disabled={left > 0 || retrying}
            onClick={onRetry}
          >
            {left > 0 ? `Retry in ${left} s` : retrying ? 'Retrying…' : 'Retry'}
          </Button>
          {onWholeRecord ? (
            <Button
              appearance="outline"
              size={compact ? 'small' : 'medium'}
              icon={<HistoryRegular />}
              onClick={onWholeRecord}
            >
              Show the whole record
            </Button>
          ) : null}
        </div>
      </Notice>
      <VisuallyHidden role="status" aria-live="polite">
        {announcement}
      </VisuallyHidden>
    </div>
  );
}

/** Where reviewer decisions normally appear, in an earlier view: the API withholds every decision made after the moment. */
export function LaterDecisionsNote() {
  return (
    <Notice variant="info" compact title={null}>
      Reviewer decisions recorded later are not shown in this earlier view.
    </Notice>
  );
}
