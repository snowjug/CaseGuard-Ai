'use client';

import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  Input,
  PageHeader,
  Select,
  cg,
  useMediaQuery,
  type SortState,
} from '@caseguard/ui';
import {
  Popover,
  PopoverSurface,
  PopoverTrigger,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { keepPreviousData } from '@tanstack/react-query';
import {
  FolderPlusIcon,
  RefreshCwIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
} from 'lucide-react';
import { useMemo } from 'react';
import { QueryBoundary } from '../../components/common/QueryBoundary';
import { describeError } from '../../lib/api/errors';
import { useApiQuery } from '../../lib/api/hooks';
import { pagedBoundary, useApiPages } from '../../lib/api/pages';
import { useAuth } from '../../lib/auth/context';
import { useSession } from '../../lib/auth/session';
import { SAMPLE_CASE_HREF } from '../../lib/nav';
import { useDebouncedValue } from '../../lib/use-debounced-value';
import { useUrlStates, useUrlTextState } from '../../lib/url-state';
import { AddCaseAction } from './AddCaseAction';
import {
  CASE_FILTERS,
  DATA_FILTERS,
  DATA_FILTER_LABELS,
  DEFAULT_SORT,
  SORT_COLUMNS,
  STATE_FILTERS,
  STATE_FILTER_LABELS,
  STATUS_FILTERS,
  STATUS_FILTER_LABELS,
  hasActiveFilters,
  matchesDataFilter,
  serverQuery,
  sortKey,
  sortOptionLabel,
} from './case-filters';
import { CaseRows } from './CaseRows';
import { CasesSkeleton } from './Skeletons';

const useStyles = makeStyles({
  page: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
  busy: { opacity: 0.72 },
  toolbar: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[3] },
  search: { flex: '1 1 280px', minWidth: 0 },
  sort: { flex: '0 1 240px', minWidth: 0 },
  filterBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[3],
    width: 'min(320px, 80vw)',
  },
  filterCaption: { margin: 0, color: cg.textMuted, fontSize: tokens.fontSizeBase200 },
  surface: {
    padding: cg.space[4],
    color: cg.text,
    backgroundColor: cg.surfaceRaised,
    border: `1px solid ${cg.glassBorder}`,
    borderRadius: cg.radius.lg,
    boxShadow: cg.shadowHigh,
  },
  summary: { color: cg.textSecondary, fontSize: tokens.fontSizeBase300 },
  more: { display: 'flex', justifyContent: 'center' },
});

const PAGE_HELP = (
  <>
    <p>Every case in this workspace, newest first. Open one to see how it went and what to fix.</p>
    <p>
      The score, the time that could have been saved and the likeliest cause are estimates from the
      analysis of each case. They help compare cases and are never a judgement of the people who
      worked on them.
    </p>
    <p>
      Search, analysis state, case status and workload are applied by the server. The data label
      filter and the sort apply to the cases loaded so far; use Load more to bring in more.
    </p>
  </>
);

/** The sort options offered by the select (every sortable column in both directions). */
const SORT_OPTIONS = SORT_COLUMNS.flatMap((column) =>
  (['ascending', 'descending'] as const).map((direction) => ({
    value: `${column}.${direction === 'ascending' ? 'asc' : 'desc'}`,
    column,
    direction,
    label: sortOptionLabel(column, direction),
  })),
);

function NoCases() {
  const { can } = useSession();
  const canAdd = can('case:ingest');
  return (
    <EmptyState
      headingLevel={2}
      icon={<FolderPlusIcon />}
      title="No cases yet"
      description={
        canAdd
          ? 'Add a case to get a score, the reason for it and the top fixes. A sample case is the quickest way to start.'
          : 'There are no cases in this workspace yet. Someone with the Engineer or Administrator role can add one.'
      }
      action={canAdd ? <AddCaseAction /> : undefined}
      secondaryAction={
        canAdd ? (
          <AddCaseAction variant="secondary" href={SAMPLE_CASE_HREF} icon={<SparklesIcon />}>
            Try a sample case
          </AddCaseAction>
        ) : undefined
      }
    />
  );
}

/**
 * Cases (`/cases`): every case with its analysis summary. Filters, sort and the data-label filter live in the URL.
 * Search, analysis state, status and workload are server filters (`cases.list`); results are loaded page by page with
 * an explicit "Load more" so nothing is fetched that is not asked for.
 */
export function CasesPage() {
  const styles = useStyles();
  const auth = useAuth();
  const compact = useMediaQuery('(max-width: 1279px)');
  const [filters, update] = useUrlStates(CASE_FILTERS);
  // The search text is typed, so it lives in the field and reaches the URL when typing pauses (see `useUrlTextState`).
  const searchField = useUrlTextState('q', CASE_FILTERS.q);
  const q = searchField.value;
  const search = useDebouncedValue(q.trim(), 300);
  const { state, status, workload, data: dataFilter, sort } = filters;
  const params = useMemo(
    () => serverQuery({ q, state, status, workload, data: dataFilter }, search),
    [q, state, status, workload, dataFilter, search],
  );
  const pages = useApiPages(
    'cases.list',
    { query: params },
    { enabled: auth.status === 'ready', placeholderData: keepPreviousData },
  );
  // The same request Home and the palette make, so the workload options cost nothing extra.
  const everyCase = useApiQuery(
    'cases.list',
    { query: { limit: 100 } },
    { enabled: auth.status === 'ready', staleTime: 30_000 },
  );
  const workloads = useMemo(() => {
    const names = new Set((everyCase.data?.items ?? []).map((item) => item.workload));
    if (workload) names.add(workload);
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [everyCase.data, workload]);

  const active = hasActiveFilters({ q, state, status, workload, data: dataFilter });
  // What the answer on screen was asked for: the search text is sent after a pause, the other filters at once.
  const asked = hasActiveFilters({ q: search, state, status, workload, data: dataFilter });
  // The filters in the popover (the search box is always visible, so it is not counted).
  const filterCount = [
    state !== 'all',
    status !== 'all',
    workload !== '',
    dataFilter !== 'all',
  ].filter(Boolean).length;
  const loaded = useMemo(() => pages.data?.pages.flatMap((page) => page.items) ?? [], [pages.data]);
  const visible = useMemo(
    () => loaded.filter((item) => matchesDataFilter(item, dataFilter)),
    [loaded, dataFilter],
  );

  const clearFilters = (): void => {
    searchField.set('');
    update({ state: 'all', status: 'all', workload: '', data: 'all' });
  };
  const changeSort = (next: SortState | null): void => update({ sort: next ?? DEFAULT_SORT });

  return (
    <>
      <PageHeader
        title="Cases"
        description="Find a case and open its review."
        help={PAGE_HELP}
        actions={
          <>
            <IconButton
              icon={<RefreshCwIcon />}
              label="Refresh"
              disabled={auth.status !== 'ready' || pages.isFetching}
              onClick={() => void pages.refetch()}
            />
            <AddCaseAction />
          </>
        }
      />
      <QueryBoundary
        query={pagedBoundary(pages)}
        subject="The case list"
        skeleton={<CasesSkeleton />}
        // "No cases yet" is for the answer to an unfiltered request. While the answer of a search that found nothing is
        // still on screen (just cleared, the full list on its way) the form must stay, or it is gone while typing.
        isEmpty={(value) =>
          !asked && !pages.isPlaceholderData && (value.pages[0]?.items.length ?? 0) === 0
        }
        empty={<NoCases />}
      >
        {(_data, meta) => (
          <div className={mergeClasses(styles.page, meta.isRefreshing && styles.busy)}>
            <form
              role="search"
              aria-label="Filter and sort cases"
              className={styles.toolbar}
              onSubmit={(event) => event.preventDefault()}
            >
              <Input
                {...searchField.inputProps}
                type="search"
                aria-label="Search"
                placeholder="Search by reference, title, product or customer"
                startIcon={<SearchIcon />}
                maxLength={200}
                wrapperClassName={styles.search}
              />
              <Popover positioning="below-start">
                <PopoverTrigger disableButtonEnhancement>
                  <Button variant="secondary" icon={<SlidersHorizontalIcon />}>
                    Filters
                    {filterCount > 0 ? (
                      <Badge tone="brand" size="sm">
                        <span className="cg-sr-only">Active: </span>
                        {filterCount}
                      </Badge>
                    ) : null}
                  </Button>
                </PopoverTrigger>
                <PopoverSurface className={styles.surface} aria-label="Filters">
                  <div className={styles.filterBody}>
                    <Field label="Analysis state">
                      <Select
                        value={state}
                        onChange={(event) =>
                          update({ state: event.target.value as (typeof STATE_FILTERS)[number] })
                        }
                      >
                        {STATE_FILTERS.map((value) => (
                          <option key={value} value={value}>
                            {STATE_FILTER_LABELS[value]}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Case status">
                      <Select
                        value={status}
                        onChange={(event) =>
                          update({ status: event.target.value as (typeof STATUS_FILTERS)[number] })
                        }
                      >
                        {STATUS_FILTERS.map((value) => (
                          <option key={value} value={value}>
                            {STATUS_FILTER_LABELS[value]}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Workload">
                      <Select
                        value={workload}
                        onChange={(event) => update({ workload: event.target.value })}
                      >
                        <option value="">Any workload</option>
                        {workloads.map((value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Data label">
                      <Select
                        value={dataFilter}
                        onChange={(event) =>
                          update({ data: event.target.value as (typeof DATA_FILTERS)[number] })
                        }
                      >
                        {DATA_FILTERS.map((value) => (
                          <option key={value} value={value}>
                            {DATA_FILTER_LABELS[value]}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <p className={styles.filterCaption}>
                      The data label filter and the sort apply to the cases loaded so far.
                    </p>
                  </div>
                </PopoverSurface>
              </Popover>
              <Select
                aria-label="Sort by"
                wrapperClassName={styles.sort}
                value={sortKey(sort)}
                onChange={(event) => {
                  const option = SORT_OPTIONS.find(
                    (candidate) => candidate.value === event.target.value,
                  );
                  if (option)
                    update({ sort: { columnId: option.column, direction: option.direction } });
                }}
              >
                {SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
              <Button variant="ghost" disabled={!active} onClick={clearFilters}>
                Clear filters
              </Button>
            </form>

            <span className={styles.summary} role="status" aria-live="polite">
              {visible.length === 0
                ? 'No loaded case matches.'
                : `Showing ${visible.length} ${visible.length === 1 ? 'case' : 'cases'}${
                    dataFilter !== 'all' && visible.length !== loaded.length
                      ? ` of the ${loaded.length} loaded`
                      : ''
                  }${pages.hasNextPage ? '. More are available.' : '.'}`}
            </span>

            {visible.length === 0 ? (
              <EmptyState
                headingLevel={2}
                icon={<SearchIcon />}
                title={active ? 'No cases match these filters' : 'No cases to show'}
                description={
                  pages.hasNextPage
                    ? 'None of the cases loaded so far match. Load more cases, or loosen the filters.'
                    : 'Loosen or clear the filters to see more cases.'
                }
                action={
                  <Button variant="secondary" onClick={clearFilters} disabled={!active}>
                    Clear filters
                  </Button>
                }
              />
            ) : (
              <CaseRows rows={visible} sort={sort} onSortChange={changeSort} compact={compact} />
            )}

            {pages.isFetchNextPageError ? (
              <ErrorState
                compact
                title="More cases could not be loaded"
                description={describeError(pages.error)}
                onRetry={() => void pages.fetchNextPage()}
                retrying={pages.isFetchingNextPage}
              />
            ) : null}
            {pages.hasNextPage ? (
              <div className={styles.more}>
                <Button
                  variant="secondary"
                  disabled={pages.isFetchingNextPage}
                  onClick={() => void pages.fetchNextPage()}
                >
                  {pages.isFetchingNextPage ? 'Loading…' : 'Load more cases'}
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </QueryBoundary>
    </>
  );
}
