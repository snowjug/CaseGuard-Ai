'use client';

import { type EvidenceCategory } from '@caseguard/schemas';
import {
  EmptyState,
  LoadingSkeleton,
  Notice,
  PageHeader,
  ProvenanceBadge,
  cg,
  useMediaQuery,
} from '@caseguard/ui';
import {
  Button,
  DrawerBody,
  Field,
  Input,
  OverlayDrawer,
  Select,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { ArrowSyncRegular, DocumentBulletListRegular, SearchRegular } from '@fluentui/react-icons';
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { AsOfPanel } from '../../components/case/AsOfPanel';
import {
  AsOfLimited,
  LaterDecisionsNote,
  asOfCall,
  asOfFresh,
  isRateLimited,
  useAsOfCursor,
} from '../../components/case/as-of';
import { caseTimeRange, useCaseDetail, useKnownAt } from '../../components/case/case-hooks';
import { CaseNotFoundState } from '../../components/case/CaseNotFoundState';
import { NotAnalysedState, isNotAnalysedError } from '../../components/case/NotAnalysedState';
import { IdentityRequired } from '../../components/common/IdentityRequired';
import { LinkButton } from '../../components/common/LinkButton';
import { QueryErrorState } from '../../components/common/QueryErrorState';
import { keepWithinBoundary } from '../../lib/api/boundary-placeholder';
import { useApiQuery } from '../../lib/api/hooks';
import { useApiPages } from '../../lib/api/pages';
import { useAuth } from '../../lib/auth/context';
import { caseHref } from '../../lib/deep-links';
import { useDebouncedValue } from '../../lib/use-debounced-value';
import { useSelectionState, useUrlStates, useUrlTextState } from '../../lib/url-state';
import { VirtualRow, useNearEnd, useWindowVirtualizer } from '../../lib/virtual-list';
import { CategoryTiles } from './CategoryTiles';
import { ClaimDetail, ClaimMissing } from './ClaimDetail';
import { ClaimRow } from './ClaimRow';
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

const useStyles = makeStyles({
  layout: {
    display: 'grid',
    gap: cg.space[4],
    gridTemplateColumns: 'minmax(0, 1fr)',
    alignItems: 'start',
    '@media (min-width: 1100px)': {
      gridTemplateColumns: 'minmax(0, 1fr) 380px',
      gridTemplateAreas: '"main aside"',
    },
  },
  busy: { opacity: 0.72 },
  main: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[4],
    minWidth: 0,
    '@media (min-width: 1100px)': { gridArea: 'main' },
  },
  aside: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[4],
    minWidth: 0,
    '@media (min-width: 1100px)': {
      gridArea: 'aside',
      position: 'sticky',
      top: 'calc(var(--cg-shell-top, 84px) + 16px)',
      maxHeight: 'calc(100dvh - var(--cg-shell-top, 84px) - 32px)',
      overflowY: 'auto',
      paddingRight: cg.space[1],
    },
  },
  filters: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'flex-end',
    gap: cg.space[3],
    padding: cg.space[3],
    borderRadius: cg.radius.lg,
    border: `1px solid ${cg.borderSubtle}`,
    backgroundColor: cg.surface,
  },
  search: { flex: '2 1 240px', minWidth: 0 },
  // A native select is as wide as its longest option unless it is told to fit its field (hypothesis names are long).
  field: { flex: '1 1 180px', minWidth: 0, '& .fui-Select': { width: '100%', minWidth: 0 } },
  status: { margin: 0, color: cg.textSecondary, fontSize: tokens.fontSizeBase300 },
  list: { margin: 0, padding: 0, listStyle: 'none' },
  more: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[3] },
  actions: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
});

const PAGE_HELP = (
  <>
    <p>
      The ledger separates what is known from what is assumed. Every statement in the case is
      classified into one of eight categories: confirmed fact, customer-reported observation,
      engineer assumption, diagnostic evidence, AI inference, conflicting evidence, missing evidence
      and simulated outcome. Each claim shows its source, the evidence that supports it and the
      evidence that contradicts it.
    </p>
    <p>
      The classification is a proposal made by rules over the case text. A reviewer can confirm or
      correct it; the original proposal is never overwritten and every decision is audited. With the
      time cursor set, only what was known at that moment is shown.
    </p>
  </>
);

/** Estimated height of a claim card before it is measured. */
const ESTIMATED_ROW = 210;

/**
 * Evidence Ledger (`/cases/[caseId]/evidence`): the claims of the case in eight categories, with filters, the evidence
 * each claim rests on, and reviewer correction that preserves the original AI classification. Filters, the selected
 * claim and the time cursor are in the URL; nothing recorded after the cursor is requested or shown.
 */
export function EvidenceLedgerPage({ caseId }: { caseId: string }) {
  const styles = useStyles();
  const auth = useAuth();
  const ready = auth.status === 'ready';
  const wide = useMediaQuery('(min-width: 1100px)', true);
  const cursor = useAsOfCursor(caseId);
  const { asOf, setAsOf } = cursor;
  const [selected, select] = useSelectionState();
  const [filters, update] = useUrlStates(LEDGER_FILTERS);
  const { category, review, hyp } = filters;
  // The search text is typed, so it lives in the field and reaches the URL when typing pauses (see `useUrlTextState`).
  const searchField = useUrlTextState('q', LEDGER_FILTERS.q);
  const q = searchField.value;
  const search = useDebouncedValue(q.trim(), 300);
  const detail = useCaseDetail(caseId);

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

  const getKey = useCallback((index: number) => claims[index]?.id ?? String(index), [claims]);
  const { containerRef, items, totalSize, virtualized, onMeasure, scrollToIndex } =
    useWindowVirtualizer({
      count: claims.length,
      getKey,
      estimateSize: ESTIMATED_ROW,
    });

  // A shared link may name a claim far down the list: bring it into view once, after the rows exist.
  const scrolledTo = useRef<string | null>(null);
  useEffect(() => {
    if (!selected || scrolledTo.current === selected) return;
    const index = claims.findIndex((claim) => claim.id === selected);
    if (index < 0) return;
    scrolledTo.current = selected;
    if (virtualized) scrollToIndex(index);
    else document.getElementById(`claim-row-${selected}`)?.scrollIntoView({ block: 'center' });
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

  const header = (
    <PageHeader
      title="Evidence Ledger"
      description={
        detail.data
          ? `${detail.data.reference} · ${detail.data.title}`
          : 'Claims classified into eight evidence categories.'
      }
      help={PAGE_HELP}
      meta={detail.data?.synthetic ? <ProvenanceBadge kind="synthetic" /> : null}
      actions={
        <div className={styles.actions}>
          <Button
            appearance="outline"
            icon={<ArrowSyncRegular />}
            disabled={!ready || pages.isFetching}
            onClick={() => void pages.refetch()}
          >
            {pages.isFetching && !pages.isPending ? 'Refreshing…' : 'Refresh'}
          </Button>
          <LinkButton href={caseHref(caseId)} appearance="outline">
            Case overview
          </LinkButton>
        </div>
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
          subject="the evidence ledger"
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

  // While the chosen moment loads (or cannot be computed) the cursor and the panel beside it stay where they are, since a
  // keyboard user is in the middle of the cursor, and the claims give way to a skeleton or an explanation. Nothing of
  // another moment is on screen meanwhile.
  const windowPending = pages.isPending;
  const windowFailed = pages.isError && pages.data === undefined;
  const windowLimited = windowFailed && pagesLimited;
  const refreshing = !windowPending && (!cursor.ready || (pages.isFetching && !isFetchingNextPage));

  let detailPanel: ReactNode;
  if (!selected) {
    detailPanel = (
      <Notice variant="info" compact title={null}>
        Select a claim to see what supports and contradicts it, how it was classified, and to record
        a reviewer decision.
      </Notice>
    );
  } else if (selectedClaim) {
    detailPanel = (
      <ClaimDetail
        caseId={caseId}
        claim={selectedClaim}
        evidenceById={evidenceById}
        missing={first?.missing ?? []}
        asOf={asOf}
        hypothesisName={nameOf}
        onClose={() => select(null)}
        onShowWholeRecord={() => setAsOf(null)}
      />
    );
  } else if (windowPending) {
    detailPanel = <LoadingSkeleton variant="card" label="Loading the claim" />;
  } else if (windowFailed) {
    detailPanel = null;
  } else if (failed && hasNextPage) {
    // The search for the claim has stopped at the page that failed; it resumes when Retry succeeds.
    detailPanel = (
      <Notice variant="info" compact title={null}>
        This claim may be on a page of the ledger that could not be loaded. Use Retry, and it will
        open here.
      </Notice>
    );
  } else {
    detailPanel = <ClaimMissing onClose={() => select(null)} searching={Boolean(hasNextPage)} />;
  }

  return (
    <>
      {header}
      <div className={mergeClasses(styles.layout, refreshing && styles.busy)}>
        <aside
          className={styles.aside}
          aria-label="What was known, and the selected claim"
          {...(wide ? { tabIndex: 0 } : {})}
        >
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
            <AsOfPanel
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
          ) : (
            <LoadingSkeleton variant="card" label="Loading what was known" />
          )}
          {wide ? detailPanel : null}
        </aside>
        <div className={styles.main} aria-busy={windowPending || refreshing || undefined}>
          {windowPending ? (
            <LedgerSkeleton />
          ) : windowFailed && pages.error ? (
            windowLimited ? (
              <AsOfLimited
                key={pages.errorUpdatedAt}
                error={pages.error}
                subject="the evidence ledger"
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
                subject="The evidence ledger"
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
                    subject="more of the ledger"
                    compact
                    onRetry={retryPages}
                    retrying={pages.isFetching}
                  />
                ) : (
                  <QueryErrorState
                    error={pages.error}
                    subject="The evidence ledger"
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
                  subject="the hypothesis names"
                  compact
                  onRetry={() => void hypotheses.refetch()}
                  retrying={hypotheses.isFetching}
                />
              ) : null}
              <CategoryTiles
                counts={first?.counts ?? {}}
                selected={category}
                onSelect={(next: 'all' | EvidenceCategory) => update({ category: next })}
              />
              <form
                role="search"
                aria-label="Filter claims"
                className={styles.filters}
                onSubmit={(event) => event.preventDefault()}
              >
                <Field label="Search claims" className={styles.search}>
                  <Input
                    {...searchField.inputProps}
                    type="search"
                    placeholder="Words in the claim or its subject"
                    contentBefore={<SearchRegular aria-hidden="true" />}
                    maxLength={200}
                  />
                </Field>
                <Field label="Review state" className={styles.field}>
                  <Select
                    value={review}
                    onChange={(_event, next) =>
                      update({ review: next.value as (typeof REVIEW_FILTERS)[number] })
                    }
                  >
                    {REVIEW_FILTERS.map((value) => (
                      <option key={value} value={value}>
                        {REVIEW_FILTER_LABELS[value]}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Related hypothesis" className={styles.field}>
                  <Select
                    value={hyp ?? ''}
                    onChange={(_event, next) => update({ hyp: next.value || null })}
                  >
                    <option value="">Any hypothesis</option>
                    {hypothesisItems.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Button appearance="subtle" disabled={activeCount === 0} onClick={clearFilters}>
                  Clear filters
                </Button>
              </form>
              <p className={styles.status} role="status" aria-live="polite">
                {claims.length === 0
                  ? 'No claims to show.'
                  : `Showing ${claims.length} ${claims.length === 1 ? 'claim' : 'claims'}${
                      hasNextPage ? ' so far; more load as you scroll' : ''
                    }${activeCount > 0 ? `, ${activeCount} ${activeCount === 1 ? 'filter' : 'filters'} on` : ''}.`}
              </p>
              {asOf ? <LaterDecisionsNote /> : null}
              <MissingEvidencePanel items={first?.missing ?? []} asOf={asOf} />
              <RecordFindingsSection
                caseId={caseId}
                asOf={asOf}
                enabled={ready && cursor.ready && pages.data !== undefined}
              />
              {claims.length === 0 ? (
                <EmptyState
                  headingLevel={2}
                  icon={<DocumentBulletListRegular />}
                  title={
                    activeCount > 0 ? 'No claims match these filters' : 'No claims at this moment'
                  }
                  description={
                    activeCount > 0
                      ? 'Loosen or clear the filters to see more of the ledger.'
                      : asOf
                        ? 'Nothing had been classified by the selected moment. Move the time cursor later.'
                        : 'The analysis found no claims in this case.'
                  }
                  action={
                    activeCount > 0 ? (
                      <Button appearance="primary" onClick={clearFilters}>
                        Clear filters
                      </Button>
                    ) : asOf ? (
                      <Button appearance="primary" onClick={() => setAsOf(null)}>
                        Show the whole record
                      </Button>
                    ) : undefined
                  }
                />
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
                      >
                        <div id={`claim-row-${claim.id}`}>
                          <ClaimRow
                            caseId={caseId}
                            claim={claim}
                            selected={selected === claim.id}
                            asOf={asOf}
                            hypothesisName={nameOf}
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
                    appearance="outline"
                    disabled={isFetchingNextPage}
                    onClick={() => void fetchNextPage()}
                  >
                    {isFetchingNextPage ? 'Loading…' : 'Load more claims'}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>
        {!wide ? (
          <OverlayDrawer
            open={selected !== null}
            position="end"
            size="medium"
            onOpenChange={(_event, data) => {
              if (!data.open) select(null);
            }}
            aria-label="Claim details"
          >
            <DrawerBody>{detailPanel}</DrawerBody>
          </OverlayDrawer>
        ) : null}
      </div>
    </>
  );
}
