'use client';

import { type EvidenceCategory } from '@caseguard/schemas';
import {
  Accordion,
  BlurFade,
  Button,
  Card,
  Drawer,
  EmptyState,
  Field,
  IconButton,
  Input,
  LoadingSkeleton,
  PageHeader,
  ProvenanceBadge,
  Select,
  Skeleton,
  VisuallyHidden,
  cg,
} from '@caseguard/ui';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { FileSearchIcon, RefreshCwIcon, RotateCwIcon, SearchIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AsOfLimited,
  asOfCall,
  asOfFresh,
  isRateLimited,
  useAsOfCursor,
} from '../../components/case/as-of';
import { caseTimeRange, useCaseDetail, useKnownAt } from '../../components/case/case-hooks';
import { CaseNotFoundState } from '../../components/case/CaseNotFoundState';
import { NotAnalysedState, isNotAnalysedError } from '../../components/case/NotAnalysedState';
import { IdentityRequired } from '../../components/common/IdentityRequired';
import { QueryErrorState } from '../../components/common/QueryErrorState';
import { keepWithinBoundary } from '../../lib/api/boundary-placeholder';
import { useApiQuery } from '../../lib/api/hooks';
import { useApiPages } from '../../lib/api/pages';
import { useAuth } from '../../lib/auth/context';
import { useDebouncedValue } from '../../lib/use-debounced-value';
import { useSelectionState, useUrlStates, useUrlTextState } from '../../lib/url-state';
import { VirtualRow, useNearEnd, useWindowVirtualizer } from '../../lib/virtual-list';
import { ClaimDetail, ClaimMissing } from './ClaimDetail';
import { ClaimRow } from './ClaimRow';
import { CoverageBar } from './CoverageBar';
import { FilterPopover } from './FilterPopover';
import {
  LEDGER_FILTERS,
  REVIEW_FILTERS,
  REVIEW_FILTER_LABELS,
  activeLedgerFilters,
  claimAsKnown,
  ledgerQuery,
  type LedgerFilterValues,
} from './ledger-filters';
import { MissingEvidencePanel } from './MissingEvidencePanel';
import { RecordFindingsSection } from './RecordFindingsPanel';
import { LedgerSkeleton } from './Skeleton';
import { LaterDecisionsCaption, WhatWasKnownBar } from './WhatWasKnownBar';

const useStyles = makeStyles({
  page: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
  busy: { opacity: 0.72 },
  filters: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: cg.space[2],
    margin: 0,
  },
  search: { flex: '1 1 260px', minWidth: 0 },
  status: { margin: 0, color: cg.textSecondary, fontSize: tokens.fontSizeBase200 },
  list: {
    margin: 0,
    padding: 0,
    listStyle: 'none',
    overflow: 'hidden',
    borderRadius: cg.radius.lg,
    border: `1px solid ${cg.glassBorder}`,
    backgroundColor: cg.surface,
  },
  item: { '&:not([aria-posinset="1"])': { borderTop: `1px solid ${cg.borderSubtle}` } },
  more: { display: 'flex', justifyContent: 'center' },
});

const PAGE_HELP = (
  <>
    <p>
      Every statement in the case is classified into one of eight categories: confirmed fact,
      customer-reported observation, engineer assumption, diagnostic evidence, AI inference,
      conflicting evidence, missing evidence and simulated outcome. Each claim shows its source, the
      evidence that supports it and the evidence that contradicts it.
    </p>
    <p>
      The classification is a proposal made by rules over the case text. A reviewer can confirm or
      correct it; the original proposal is never overwritten and every decision is audited. With
      &ldquo;What was known then&rdquo; set, only what was known at that moment is shown.
    </p>
  </>
);

/** Estimated height of a claim row before it is measured. */
const ESTIMATED_ROW = 150;

/**
 * Evidence (`/cases/[caseId]/evidence`): the claims of the case in eight categories, what each rests on, and reviewer
 * correction that preserves the original AI classification. The coverage bar, the filters, the selected claim and the
 * time cursor are all in the URL; nothing recorded after the cursor is requested or shown.
 */
export function EvidenceLedgerPage({ caseId }: { caseId: string }) {
  const styles = useStyles();
  const auth = useAuth();
  const ready = auth.status === 'ready';
  const cursor = useAsOfCursor(caseId);
  const { asOf, setAsOf } = cursor;
  const [selected, select] = useSelectionState();
  // The drawer keeps showing the claim it had while it slides out, instead of emptying first.
  const [lastSelected, setLastSelected] = useState(selected);
  if (selected !== null && selected !== lastSelected) setLastSelected(selected);
  const shownId = selected ?? lastSelected;
  const [filters, update] = useUrlStates(LEDGER_FILTERS);
  const { category, review, hyp } = filters;
  // The search text is typed, so it lives in the field and reaches the URL when typing pauses (see `useUrlTextState`).
  const searchField = useUrlTextState('q', LEDGER_FILTERS.q);
  const q = searchField.value;
  const search = useDebouncedValue(q.trim(), 300);
  const detail = useCaseDetail(caseId);
  const [missingOpen, setMissingOpen] = useState(false);

  const values: LedgerFilterValues = { category, review, hyp, q };
  const requestQuery = useMemo(
    () => ledgerQuery({ category, review, hyp, q: '' }, search, asOf),
    [category, review, hyp, search, asOf],
  );
  // The answer of another moment is never served while this one loads (the page shows its loading state instead): it
  // would put the claims, counts and decisions of that moment under the name of this one. Only a refetch or a change of
  // filter within the SAME moment keeps what is on screen.
  const request = { params: { caseId }, query: requestQuery };
  const pages = useApiPages(
    'evidence.list',
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
  const { hasNextPage, isFetchingNextPage, fetchNextPage, isFetchNextPageError, refetch } = pages;
  const failed = pages.isError;
  // After a failed page the Retry button asks again, once per press; nothing loads pages in a loop (see below).
  const retryPages = useCallback(() => {
    void (isFetchNextPageError ? fetchNextPage() : refetch());
  }, [isFetchNextPageError, fetchNextPage, refetch]);

  const first = pages.data?.pages[0];
  const claims = useMemo(
    () =>
      (pages.data?.pages.flatMap((page) => page.items) ?? []).map((claim) =>
        claimAsKnown(claim, asOf),
      ),
    [pages.data, asOf],
  );
  const evidenceById = useMemo(
    () =>
      new Map(
        (pages.data?.pages.flatMap((page) => page.evidence) ?? []).map((item) => [item.id, item]),
      ),
    [pages.data],
  );
  const hypothesisItems = useMemo(
    () =>
      hypotheses.data?.items.map((item) => ({ id: item.id, key: item.key, name: item.name })) ?? [],
    [hypotheses.data],
  );
  const nameOf = useCallback(
    (id: string): string =>
      hypothesisItems.find((item) => item.id === id || item.key === id)?.name ?? id,
    [hypothesisItems],
  );
  const selectedClaim = selected ? claims.find((claim) => claim.id === selected) : undefined;
  const shownClaim = shownId ? claims.find((claim) => claim.id === shownId) : undefined;

  const getKey = useCallback((index: number) => claims[index]?.id ?? String(index), [claims]);
  const { containerRef, items, totalSize, virtualized, onMeasure, scrollToIndex } =
    useWindowVirtualizer({
      count: claims.length,
      getKey,
      estimateSize: ESTIMATED_ROW,
    });

  // A shared link may name a claim far down the list: bring it into view once, after the rows exist. A row that is already
  // in view (the one that was just chosen with the pointer) stays where it is.
  const scrolledTo = useRef<string | null>(null);
  useEffect(() => {
    if (!selected || scrolledTo.current === selected) return;
    const index = claims.findIndex((claim) => claim.id === selected);
    if (index < 0) return;
    scrolledTo.current = selected;
    const node = document.getElementById(`claim-row-${selected}`);
    const box = node?.getBoundingClientRect();
    if (box && box.top >= 0 && box.bottom <= window.innerHeight) return;
    if (virtualized) scrollToIndex(index);
    else node?.scrollIntoView({ block: 'center' });
  }, [selected, claims, virtualized, scrollToIndex]);

  // The selected claim may be on a page that has not been loaded yet (a shared link): load pages until it is found, and
  // stop at the first page that fails.
  useEffect(() => {
    if (selected && !selectedClaim && hasNextPage && !isFetchingNextPage && !failed)
      void fetchNextPage();
  }, [selected, selectedClaim, hasNextPage, isFetchingNextPage, failed, fetchNextPage]);

  const loadNext = useCallback(() => {
    if (!isFetchingNextPage && !failed) void fetchNextPage();
  }, [isFetchingNextPage, failed, fetchNextPage]);
  const sentinel = useNearEnd(Boolean(hasNextPage), loadNext);

  const activeCount = activeLedgerFilters(values);
  // The filters inside the popover; the category is the coverage bar's and the search is the row's own.
  const popoverCount = (review !== 'all' ? 1 : 0) + (hyp ? 1 : 0);
  const clearFilters = (): void => {
    searchField.set('');
    update({ category: 'all', review: 'all', hyp: null });
  };
  const known = useKnownAt(caseId, asOf, cursor.ready);
  const knownSummary = known.data
    ? {
        ...known.data.knownAtAsOf,
        withheldFutureEventCount: known.data.withheldFutureEventCount,
        cutAt: first?.asOf ?? known.data.asOf,
      }
    : null;
  const range = caseTimeRange(detail.data);
  // An earlier view is metered: when the budget is empty the page says so and counts down, it does not fail.
  const pagesLimited = asOf !== null && pages.isError && isRateLimited(pages.error);
  const hypothesesLimited = asOf !== null && hypotheses.isError && isRateLimited(hypotheses.error);
  const knownLimited = asOf !== null && known.isError && isRateLimited(known.error);

  const requirements = first?.missing ?? [];
  const stillOpen = requirements.filter((item) => item.resolvedAt === null);

  const header = (
    <PageHeader
      title="Evidence"
      description="Check what each claim is based on."
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
          subject="the evidence"
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

  // While the chosen moment loads (or cannot be computed) the cursor bar stays where it is, since a keyboard user is in
  // the middle of the cursor, and the claims give way to a skeleton or an explanation. Nothing of another moment is on
  // screen meanwhile.
  const windowPending = pages.isPending;
  const windowFailed = pages.isError && pages.data === undefined;
  const windowLimited = windowFailed && pagesLimited;
  const refreshing = !windowPending && (!cursor.ready || (pages.isFetching && !isFetchingNextPage));

  let drawerBody: ReactNode = null;
  if (shownId) {
    if (shownClaim) {
      drawerBody = (
        <ClaimDetail
          caseId={caseId}
          claim={shownClaim}
          evidenceById={evidenceById}
          missing={requirements}
          asOf={asOf}
          hypothesisName={nameOf}
          onShowWholeRecord={() => setAsOf(null)}
        />
      );
    } else if (windowPending) {
      drawerBody = <LoadingSkeleton variant="card" label="Loading the claim" />;
    } else if (windowFailed) {
      drawerBody = (
        <EmptyState
          compact
          headingLevel={3}
          icon={<FileSearchIcon />}
          title="This claim cannot be shown yet"
          description="The evidence did not load. Close this panel and use Retry on the page."
        />
      );
    } else if (failed && hasNextPage) {
      // The search for the claim has stopped at the page that failed; it resumes when Retry succeeds. The drawer is a
      // modal, so the Retry of the page is behind it: it carries its own.
      drawerBody = (
        <>
          <p className={styles.status}>
            This claim may be on a page of the ledger that could not be loaded. Use Retry, and it
            will open here.
          </p>
          <div>
            <Button
              variant="secondary"
              icon={<RotateCwIcon />}
              loading={pages.isFetching}
              onClick={retryPages}
            >
              Retry
            </Button>
          </div>
        </>
      );
    } else {
      drawerBody = <ClaimMissing onClose={() => select(null)} searching={Boolean(hasNextPage)} />;
    }
  }

  return (
    <>
      {header}
      <div className={styles.page}>
        <BlurFade className={styles.page}>
          {knownLimited && !windowLimited && known.error ? (
            <AsOfLimited
              key={known.errorUpdatedAt}
              error={known.error}
              subject="what was known"
              compact
              onRetry={() => void known.refetch()}
              retrying={known.isFetching}
              onWholeRecord={() => setAsOf(null)}
            />
          ) : null}
          {detail.data ? (
            <WhatWasKnownBar
              caseId={caseId}
              range={range}
              asOf={asOf}
              onChange={setAsOf}
              instants={cursor.instants}
              instantsFailed={cursor.instantsFailed}
              onRetryInstants={cursor.retryInstants}
              known={knownSummary}
              loading={known.isPending && asOf !== null}
              limited={knownLimited || windowLimited}
              decisionsNote={false}
              linkTo={['timeline', 'hypotheses']}
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
            <LedgerSkeleton />
          ) : windowFailed && pages.error ? (
            windowLimited ? (
              <AsOfLimited
                key={pages.errorUpdatedAt}
                error={pages.error}
                subject="the evidence"
                onRetry={() => {
                  void refetch();
                  void known.refetch();
                }}
                retrying={pages.isFetching || known.isFetching}
                onWholeRecord={() => setAsOf(null)}
              />
            ) : (
              <QueryErrorState
                error={pages.error}
                subject="The evidence"
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
                    subject="more of the evidence"
                    compact
                    onRetry={retryPages}
                    retrying={pages.isFetching}
                  />
                ) : (
                  <QueryErrorState
                    error={pages.error}
                    subject="The evidence"
                    compact
                    onRetry={retryPages}
                    retrying={pages.isFetching}
                  />
                )
              ) : null}
              {hypothesesLimited && hypotheses.error ? (
                <AsOfLimited
                  key={hypotheses.errorUpdatedAt}
                  error={hypotheses.error}
                  subject="the names of the possible causes"
                  compact
                  onRetry={() => void hypotheses.refetch()}
                  retrying={hypotheses.isFetching}
                />
              ) : null}
              <BlurFade index={1}>
                <CoverageBar
                  counts={first?.counts ?? {}}
                  selected={category}
                  onSelect={(next: 'all' | EvidenceCategory) => update({ category: next })}
                  missingOpen={stillOpen.length}
                  missingCritical={
                    stillOpen.filter((item) => item.criticality === 'critical').length
                  }
                  missingTotal={requirements.length}
                  onShowMissing={() => setMissingOpen(true)}
                >
                  <Accordion>
                    <MissingEvidencePanel
                      items={requirements}
                      asOf={asOf}
                      open={missingOpen}
                      onOpenChange={setMissingOpen}
                    />
                    <RecordFindingsSection
                      caseId={caseId}
                      asOf={asOf}
                      enabled={ready && cursor.ready && pages.data !== undefined}
                    />
                  </Accordion>
                </CoverageBar>
              </BlurFade>
              <BlurFade index={2} className={styles.page}>
                <form
                  role="search"
                  aria-label="Filter claims"
                  className={styles.filters}
                  onSubmit={(event) => event.preventDefault()}
                >
                  <Input
                    {...searchField.inputProps}
                    type="search"
                    aria-label="Search claims"
                    placeholder="Search claims"
                    startIcon={<SearchIcon />}
                    maxLength={200}
                    wrapperClassName={styles.search}
                  />
                  <FilterPopover activeCount={popoverCount}>
                    <Field label="Review state">
                      <Select
                        value={review}
                        onChange={(event) =>
                          update({ review: event.target.value as (typeof REVIEW_FILTERS)[number] })
                        }
                      >
                        {REVIEW_FILTERS.map((value) => (
                          <option key={value} value={value}>
                            {REVIEW_FILTER_LABELS[value]}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Related cause">
                      <Select
                        value={hyp ?? ''}
                        onChange={(event) => update({ hyp: event.target.value || null })}
                      >
                        <option value="">Any cause</option>
                        {hypothesisItems.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </FilterPopover>
                  {activeCount > 0 ? (
                    <Button variant="ghost" onClick={clearFilters}>
                      Clear filters
                    </Button>
                  ) : null}
                </form>
                <p className={styles.status} role="status" aria-live="polite">
                  {claims.length === 0
                    ? 'No claims to show.'
                    : `Showing ${claims.length} ${claims.length === 1 ? 'claim' : 'claims'}${
                        hasNextPage ? ' so far; more load as you scroll' : ''
                      }${activeCount > 0 ? `, ${activeCount} ${activeCount === 1 ? 'filter' : 'filters'} on` : ''}.`}
                </p>
                {asOf ? <LaterDecisionsCaption /> : null}
                {claims.length === 0 ? (
                  <Card>
                    <EmptyState
                      headingLevel={2}
                      icon={<FileSearchIcon />}
                      title={
                        activeCount > 0
                          ? 'No claims match these filters'
                          : 'No claims at this moment'
                      }
                      description={
                        activeCount > 0
                          ? 'Loosen or clear the filters to see more claims.'
                          : asOf
                            ? 'Nothing had been classified by the selected moment. Move the time cursor later.'
                            : 'The analysis found no claims in this case.'
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
                    aria-label={`Claims, ${claims.length} shown`}
                    style={virtualized ? { position: 'relative', height: totalSize } : undefined}
                  >
                    {items.map((item) => {
                      const claim = claims[item.index];
                      if (!claim) return null;
                      return (
                        <VirtualRow
                          key={item.key}
                          itemKey={item.key}
                          index={item.index}
                          count={claims.length}
                          start={item.start}
                          virtualized={virtualized}
                          onMeasure={onMeasure}
                          className={styles.item}
                        >
                          <div id={`claim-row-${claim.id}`}>
                            <ClaimRow
                              caseId={caseId}
                              claim={claim}
                              selected={selected === claim.id}
                              asOf={asOf}
                              onSelect={(id) => select(id)}
                            />
                          </div>
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
                      {isFetchingNextPage ? 'Loading…' : 'Load more claims'}
                    </Button>
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
          title="Claim details"
        >
          {drawerBody}
        </Drawer>
      </div>
    </>
  );
}
