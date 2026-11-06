'use client';

import { EVENT_TYPE_LABELS, type TimelineEvent } from '@caseguard/schemas';
import {
  Badge,
  BlurFade,
  Button,
  Card,
  Drawer,
  EmptyState,
  IconButton,
  PageHeader,
  ProvenanceBadge,
  Skeleton,
  VisuallyHidden,
  cg,
} from '@caseguard/ui';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { FlaskConicalIcon, HistoryIcon, RefreshCwIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AsOfLimited,
  asOfCall,
  asOfFresh,
  isRateLimited,
  useAsOfCursor,
} from '../../components/case/as-of';
import { caseTimeRange, useCaseDetail } from '../../components/case/case-hooks';
import { CaseNotFoundState } from '../../components/case/CaseNotFoundState';
import { NotAnalysedState, isNotAnalysedError } from '../../components/case/NotAnalysedState';
import { IdentityRequired } from '../../components/common/IdentityRequired';
import { QueryErrorState } from '../../components/common/QueryErrorState';
import { keepWithinBoundary } from '../../lib/api/boundary-placeholder';
import { useApiQuery } from '../../lib/api/hooks';
import { useApiPages } from '../../lib/api/pages';
import { useAuth } from '../../lib/auth/context';
import { useSelectionState, useUrlStates } from '../../lib/url-state';
import { VirtualRow, useNearEnd, useWindowVirtualizer } from '../../lib/virtual-list';
import { WhatWasKnownBar } from '../evidence/WhatWasKnownBar';
import { ConfidenceChart } from './ConfidenceChart';
import { EventDetail } from './EventDetail';
import { EventRow, SimulatedRow } from './EventRow';
import { FilterBar } from './FilterBar';
import { TimelineSkeleton } from './Skeleton';
import {
  TIMELINE_FILTERS,
  activeFilterCount,
  decisionWindow,
  matchesFlags,
  mergeRows,
  timelineQuery,
  type TimelineFilterValues,
} from './timeline-filters';

const useStyles = makeStyles({
  page: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
  busy: { opacity: 0.72 },
  list: { margin: 0, padding: 0, listStyle: 'none' },
  more: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[3] },
  text: { margin: 0, color: cg.textSecondary, fontSize: tokens.fontSizeBase300 },
  overlay: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: `${cg.space[2]} ${cg.space[3]}`,
    padding: `${cg.space[2]} ${cg.space[4]}`,
    borderRadius: cg.radius.md,
    border: `1px dashed ${cg.tone.simulated.border}`,
    backgroundColor: cg.tone.simulated.tint,
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase200,
  },
});

const PAGE_HELP = (
  <>
    <p>
      Every event in the case in time order, with the pauses between them, repeated diagnostics and
      key decisions marked. The chart shows how confidence in each possible cause moved as evidence
      arrived.
    </p>
    <p>
      &ldquo;What was known then&rdquo; shows the case as it stood at an earlier moment: only events
      recorded by then are shown, later ones are counted but never displayed. Open an event for its
      full text, the claims and evidence derived from it and its place in the conversation. Filters,
      zoom, the open event and the moment are all part of the address, so you can share a view.
    </p>
  </>
);

/** Estimated height of an event card before it is measured. */
const ESTIMATED_ROW = 240;

/**
 * Timeline (`/cases/[caseId]/timeline`): a virtualised, filterable, zoomable list of the events with delays and repeated
 * diagnostics marked, a compact confidence chart, the "What was known then" cursor and a drawer for the open event.
 * Nothing after the temporal boundary is requested or shown.
 */
export function TimelinePage({ caseId }: { caseId: string }) {
  const styles = useStyles();
  const auth = useAuth();
  const ready = auth.status === 'ready';
  const cursor = useAsOfCursor(caseId);
  const { asOf, setAsOf } = cursor;
  const [selected, select] = useSelectionState();
  // The drawer keeps showing the event it had while it slides out, instead of emptying first.
  const [lastSelected, setLastSelected] = useState(selected);
  if (selected !== null && selected !== lastSelected) setLastSelected(selected);
  const shownEvent = selected ?? lastSelected;
  const [filters, update] = useUrlStates(TIMELINE_FILTERS);
  const detail = useCaseDetail(caseId);

  const values: TimelineFilterValues = {
    types: filters.types,
    roles: filters.roles,
    category: filters.category,
    hyp: filters.hyp,
    flags: filters.flags,
    from: filters.from,
    to: filters.to,
    scenario: filters.scenario,
  };
  const { types, roles, category, hyp, flags, from, to, scenario } = filters;
  const requestQuery = useMemo(
    () => timelineQuery({ types, roles, category, hyp, flags, from, to, scenario }, asOf),
    [types, roles, category, hyp, flags, from, to, scenario, asOf],
  );
  // The answer of another moment is never served while this one loads (the page shows its loading state instead): it
  // would put the events, counts and ranges of that moment under the name of this one. Only a refetch or a change of
  // filter within the SAME moment keeps what is on screen.
  const request = { params: { caseId }, query: requestQuery };
  const pages = useApiPages(
    'timeline.get',
    { ...request, ...asOfCall(asOf) },
    {
      enabled: ready && cursor.ready,
      placeholderData: keepWithinBoundary(request),
      ...asOfFresh(asOf),
    },
  );
  const hypothesesRequest = { params: { caseId }, query: asOf ? { asOf } : {} };
  const hypotheses = useApiQuery(
    'hypotheses.list',
    { ...hypothesesRequest, ...asOfCall(asOf) },
    {
      enabled: ready && cursor.ready && pages.data !== undefined,
      placeholderData: keepWithinBoundary(hypothesesRequest),
      ...asOfFresh(asOf),
    },
  );

  const first = pages.data?.pages[0];
  const loadedEvents = useMemo(
    () => pages.data?.pages.flatMap((page) => page.events) ?? [],
    [pages.data],
  );
  const visibleEvents = useMemo(
    () => loadedEvents.filter((event) => matchesFlags(event, flags)),
    [loadedEvents, flags],
  );
  const delays = useMemo(
    () =>
      new Map(
        (pages.data?.pages ?? [])
          .flatMap((page) => page.delays)
          .map((d) => [d.toEventId, d.reason]),
      ),
    [pages.data],
  );
  const repeats = useMemo(
    () =>
      new Map(
        (pages.data?.pages ?? [])
          .flatMap((page) => page.repeats)
          .map((r) => [r.eventId, r.repeatOfEventId]),
      ),
    [pages.data],
  );
  const rows = useMemo(
    () => mergeRows(visibleEvents, first?.simulatedEvents ?? []),
    [visibleEvents, first],
  );

  const hypothesisItems = useMemo(
    () =>
      hypotheses.data?.items.map((item) => ({ id: item.id, name: item.name })) ??
      first?.hypothesisSeries.map((item) => ({ id: item.hypothesisId, name: item.name })) ??
      [],
    [hypotheses.data, first],
  );
  const nameOf = useCallback(
    (id: string): string => hypothesisItems.find((item) => item.id === id)?.name ?? id,
    [hypothesisItems],
  );
  const forkMarkers = useMemo(
    () =>
      visibleEvents
        .filter((event) => event.forkIds.length > 0)
        .map((event) => ({
          x: event.timestamp,
          label: `Key decision at ${event.title ?? event.actionLabel ?? EVENT_TYPE_LABELS[event.type]}`,
        })),
    [visibleEvents],
  );

  const getKey = useCallback((index: number) => rows[index]?.id ?? String(index), [rows]);
  const { containerRef, items, totalSize, virtualized, onMeasure, scrollToIndex } =
    useWindowVirtualizer({ count: rows.length, getKey, estimateSize: ESTIMATED_ROW });

  // A shared link may name an event far down the list: bring it into view once, after the rows exist. A row that is already
  // in view (the one that was just chosen with the pointer) stays where it is.
  const scrolledTo = useRef<string | null>(null);
  useEffect(() => {
    if (!selected || scrolledTo.current === selected) return;
    const index = rows.findIndex((row) => row.id === selected);
    if (index < 0) return;
    scrolledTo.current = selected;
    const node = document.getElementById(`event-row-${selected}`);
    const box = node?.getBoundingClientRect();
    if (box && box.top >= 0 && box.bottom <= window.innerHeight) return;
    if (virtualized) scrollToIndex(index);
    else node?.scrollIntoView({ block: 'center' });
  }, [selected, rows, virtualized, scrollToIndex]);

  // Pages are loaded by themselves (the flags below, scrolling near the end) only while nothing has failed. After a failed
  // page the Retry button asks again, once per press, instead of the page asking again in a loop.
  const { hasNextPage, isFetchingNextPage, fetchNextPage, isFetchNextPageError, refetch } = pages;
  const failed = pages.isError;
  const retryPages = useCallback(() => {
    void (isFetchNextPageError ? fetchNextPage() : refetch());
  }, [isFetchNextPageError, fetchNextPage, refetch]);

  // Flags are applied on the loaded events, so while one is on, the rest of the pages are loaded to keep that exact.
  useEffect(() => {
    if (flags.length > 0 && hasNextPage && !isFetchingNextPage && !failed) void fetchNextPage();
  }, [flags.length, hasNextPage, isFetchingNextPage, failed, fetchNextPage]);

  // Scrolling near the end of the list loads the next page.
  const loadNext = useCallback(() => {
    if (!isFetchingNextPage && !failed) void fetchNextPage();
  }, [isFetchingNextPage, failed, fetchNextPage]);
  const sentinel = useNearEnd(Boolean(hasNextPage), loadNext);

  const activeCount = activeFilterCount(values);
  const clearFilters = (): void =>
    update({ types: [], roles: [], category: 'all', hyp: null, flags: [], from: null, to: null });
  const range = caseTimeRange(detail.data);
  const known = first
    ? {
        ...first.knownAtAsOf,
        withheldFutureEventCount: first.withheldFutureEventCount,
        cutAt: first.asOf,
      }
    : null;
  // An earlier view is metered: when the budget is empty the page says so and counts down, it does not fail.
  const pagesLimited = asOf !== null && pages.isError && isRateLimited(pages.error);
  const hypothesesLimited = asOf !== null && hypotheses.isError && isRateLimited(hypotheses.error);

  const onZoom = (event: TimelineEvent): void => {
    const zoomWindow = decisionWindow(
      visibleEvents,
      visibleEvents.findIndex((item) => item.id === event.id),
    );
    if (zoomWindow) update({ from: zoomWindow.from, to: zoomWindow.to });
  };

  const header = (
    <PageHeader
      title="Timeline"
      description="See what happened and when."
      help={PAGE_HELP}
      meta={detail.data?.synthetic ? <ProvenanceBadge kind="synthetic" /> : null}
      actions={
        <IconButton
          icon={<RefreshCwIcon />}
          label="Refresh"
          disabled={!ready}
          loading={pages.isFetching && !pages.isPending}
          onClick={() => void pages.refetch()}
        />
      }
    />
  );

  if (detail.isError && detail.error.isNotFound) return <CaseNotFoundState />;

  if (pages.isError && isNotAnalysedError(pages.error)) {
    return (
      <>
        {header}
        <NotAnalysedState
          caseId={caseId}
          subject="the timeline"
          analysisState={detail.data?.analysisState}
        />
      </>
    );
  }

  if (auth.status === 'unauthenticated') {
    return (
      <>
        {header}
        <IdentityRequired />
      </>
    );
  }

  // While the chosen moment loads (or cannot be computed) the cursor bar stays where it is, since a keyboard user is in the
  // middle of the cursor, and the events give way to a skeleton or an explanation. Nothing of another moment is on screen
  // meanwhile.
  const windowPending = pages.isPending;
  const windowFailed = pages.isError && pages.data === undefined;
  const refreshing = !windowPending && (!cursor.ready || (pages.isFetching && !isFetchingNextPage));

  return (
    <>
      {header}
      <div className={styles.page}>
        <BlurFade>
          {detail.data ? (
            <WhatWasKnownBar
              caseId={caseId}
              range={range}
              asOf={asOf}
              onChange={setAsOf}
              instants={cursor.instants}
              instantsFailed={cursor.instantsFailed}
              onRetryInstants={cursor.retryInstants}
              known={known}
              loading={asOf !== null && windowPending}
              limited={windowFailed && pagesLimited}
              linkTo={['evidence', 'hypotheses']}
            />
          ) : detail.isError ? null : (
            <div role="status" aria-busy="true" aria-live="polite">
              <VisuallyHidden>Loading what was known…</VisuallyHidden>
              <Skeleton height={58} radius="lg" />
            </div>
          )}
        </BlurFade>
        <div
          className={mergeClasses(styles.page, refreshing && styles.busy)}
          aria-busy={windowPending || refreshing || undefined}
        >
          {windowPending ? (
            <TimelineSkeleton />
          ) : windowFailed && pages.error ? (
            pagesLimited ? (
              <AsOfLimited
                key={pages.errorUpdatedAt}
                error={pages.error}
                subject="the timeline"
                onRetry={retryPages}
                retrying={pages.isFetching}
                onWholeRecord={() => setAsOf(null)}
              />
            ) : (
              <QueryErrorState
                error={pages.error}
                subject="The timeline"
                onRetry={retryPages}
                retrying={pages.isFetching}
              />
            )
          ) : (
            <>
              {pages.isError && pages.error ? (
                pagesLimited ? (
                  <AsOfLimited
                    key={pages.errorUpdatedAt}
                    error={pages.error}
                    subject="more of the timeline"
                    compact
                    onRetry={retryPages}
                    retrying={pages.isFetching}
                  />
                ) : (
                  <QueryErrorState
                    error={pages.error}
                    subject="The timeline"
                    compact
                    onRetry={retryPages}
                    retrying={pages.isFetching}
                  />
                )
              ) : null}
              <BlurFade index={1}>
                <ConfidenceChart
                  series={first?.hypothesisSeries ?? []}
                  hypotheses={hypotheses.data?.items}
                  forks={forkMarkers}
                  from={from}
                  to={to}
                  asOf={asOf}
                  cutAt={first?.asOf ?? null}
                  limited={
                    hypothesesLimited && hypotheses.error ? (
                      <AsOfLimited
                        key={hypotheses.errorUpdatedAt}
                        error={hypotheses.error}
                        subject="the likely ranges and the names of the possible causes"
                        compact
                        onRetry={() => void hypotheses.refetch()}
                        retrying={hypotheses.isFetching}
                      />
                    ) : null
                  }
                />
              </BlurFade>
              <BlurFade index={2} className={styles.page}>
                {scenario ? (
                  <div className={styles.overlay}>
                    <Badge tone="simulated" dashed icon={<FlaskConicalIcon />}>
                      Simulated path overlaid
                    </Badge>
                    <span>
                      Simulated steps of one what-if path are shown between the recorded events,
                      dashed and labelled Simulated. They are estimates of what could have happened,
                      not events.
                    </span>
                    <Button variant="ghost" size="sm" onClick={() => update({ scenario: null })}>
                      Remove the overlay
                    </Button>
                  </div>
                ) : null}
                <FilterBar
                  filters={values}
                  onChange={(patch) => update(patch)}
                  onClear={clearFilters}
                  activeCount={activeCount}
                  hypotheses={hypothesisItems}
                  events={loadedEvents}
                  shown={visibleEvents.length}
                  total={first?.total}
                  hasMore={Boolean(hasNextPage)}
                />
                {rows.length === 0 ? (
                  <Card>
                    <EmptyState
                      headingLevel={2}
                      icon={<HistoryIcon />}
                      title={
                        activeCount > 0
                          ? 'No events match these filters'
                          : 'No events at this moment'
                      }
                      description={
                        activeCount > 0
                          ? 'Loosen or clear the filters to see more of the case.'
                          : asOf
                            ? 'Nothing had been recorded by the selected moment. Move the time cursor later.'
                            : 'This case has no events.'
                      }
                      action={
                        activeCount > 0 ? (
                          <Button variant="primary" onClick={clearFilters}>
                            Clear filters
                          </Button>
                        ) : asOf ? (
                          <Button variant="primary" onClick={() => setAsOf(null)}>
                            Show the whole record
                          </Button>
                        ) : undefined
                      }
                    />
                  </Card>
                ) : (
                  <ul
                    ref={containerRef}
                    className={styles.list}
                    aria-label={`Events, ${rows.length} shown`}
                    style={virtualized ? { position: 'relative', height: totalSize } : undefined}
                  >
                    {items.map((item) => {
                      const row = rows[item.index];
                      if (!row) return null;
                      const isFirst = item.index === 0;
                      const isLast = item.index === rows.length - 1;
                      return (
                        <VirtualRow
                          key={item.key}
                          itemKey={item.key}
                          index={item.index}
                          count={rows.length}
                          start={item.start}
                          virtualized={virtualized}
                          onMeasure={onMeasure}
                        >
                          {row.kind === 'event' ? (
                            <div id={`event-row-${row.event.id}`}>
                              <EventRow
                                caseId={caseId}
                                event={row.event}
                                selected={selected === row.event.id}
                                asOf={asOf}
                                delayReason={delays.get(row.event.id)}
                                repeatOf={repeats.get(row.event.id)}
                                hypothesisName={nameOf}
                                onSelect={(id) => select(id)}
                                onKnownAsOf={(event) => setAsOf(event.timestamp)}
                                onZoom={onZoom}
                                first={isFirst}
                                last={isLast}
                              />
                            </div>
                          ) : (
                            <SimulatedRow step={row.step} first={isFirst} last={isLast} />
                          )}
                        </VirtualRow>
                      );
                    })}
                  </ul>
                )}
                <div ref={sentinel} aria-hidden="true" />
                {hasNextPage ? (
                  <div className={styles.more}>
                    <Button
                      variant="secondary"
                      loading={isFetchingNextPage}
                      onClick={() => void fetchNextPage()}
                    >
                      {isFetchingNextPage ? 'Loading…' : 'Load more events'}
                    </Button>
                    <span className={styles.text}>
                      {loadedEvents.length} of {first?.total ?? loadedEvents.length} events loaded
                    </span>
                  </div>
                ) : null}
              </BlurFade>
            </>
          )}
        </div>
        <Drawer
          open={selected !== null}
          onOpenChange={(open) => {
            if (!open) select(null);
          }}
          title="Event details"
        >
          {shownEvent !== null ? (
            <EventDetail
              caseId={caseId}
              eventId={shownEvent}
              asOf={asOf}
              onClose={() => select(null)}
              onSelect={(id) => select(id)}
              onKnownAsOf={(timestamp) => setAsOf(timestamp)}
            />
          ) : null}
        </Drawer>
      </div>
    </>
  );
}
