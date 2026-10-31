'use client';

import {
  EmptyState,
  ErrorState,
  Notice,
  PageHeader,
  useMediaQuery,
  cg,
  type SortState,
} from '@caseguard/ui';
import {
  Button,
  Field,
  Input,
  Select,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { AddRegular, ArrowSyncRegular, FolderRegular, SearchRegular } from '@fluentui/react-icons';
import { keepPreviousData } from '@tanstack/react-query';
import { useMemo } from 'react';
import { LinkButton } from '../../components/common/LinkButton';
import { QueryBoundary } from '../../components/common/QueryBoundary';
import { describeError } from '../../lib/api/errors';
import { useApiQuery } from '../../lib/api/hooks';
import { pagedBoundary, useApiPages } from '../../lib/api/pages';
import { useAuth } from '../../lib/auth/context';
import { GatedAction, useSession } from '../../lib/auth/session';
import { useDebouncedValue } from '../../lib/use-debounced-value';
import { useUrlStates, useUrlTextState } from '../../lib/url-state';
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
  sortColumnLabel,
  sortKey,
  sortOptionLabel,
} from './case-filters';
import { CaseRows } from './CaseRows';
import { CasesSkeleton } from './Skeletons';

const useStyles = makeStyles({
  page: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
  busy: { opacity: 0.72 },
  toolbar: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'flex-end',
    gap: cg.space[3],
    padding: cg.space[3],
    borderRadius: cg.radius.lg,
    border: `1px solid ${cg.borderSubtle}`,
    backgroundColor: cg.surface,
  },
  field: { flex: '1 1 160px', minWidth: 0, '& .fui-Select': { width: '100%', minWidth: 0 } },
  search: { flex: '2 1 260px', minWidth: 0 },
  summary: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: cg.space[2],
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase300,
  },
  more: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[3] },
  actions: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
});

const PAGE_HELP = (
  <>
    <p>
      Every case ingested into this workspace, newest first. The analysis state says whether
      CaseGuard has reconstructed the timeline and weighed the hypotheses yet.
    </p>
    <p>
      Quality, avoidable effort and the leading hypothesis are estimates produced by the analysis of
      each case. They help compare cases and are never a judgement of the people who worked on them.
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
  return (
    <EmptyState
      headingLevel={2}
      icon={<FolderRegular />}
      title="No cases yet"
      description={
        can('case:ingest')
          ? 'Ingest a case to see CaseGuard rebuild its timeline, separate facts from assumptions and weigh competing hypotheses. A built-in synthetic sample is the quickest way to start.'
          : 'There are no cases in this workspace yet. Someone with the Engineer or Administrator role can ingest one, for example a built-in synthetic sample.'
      }
      action={
        <GatedAction permission="case:ingest">
          <LinkButton href="/cases/new" appearance="primary" icon={<AddRegular />}>
            Ingest a case
          </LinkButton>
        </GatedAction>
      }
      secondaryAction={
        <GatedAction permission="case:ingest">
          <LinkButton href="/cases/new?source=sample" appearance="outline">
            Use a sample
          </LinkButton>
        </GatedAction>
      }
    />
  );
}

/**
 * Cases (`/cases`): every ingested case with its analysis summary. Filters, sort and the data-label filter live in the
 * URL. Search, analysis state, status and workload are server filters (`cases.list`); results are loaded page by page
 * with an explicit "Load more" so nothing is fetched that is not asked for.
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
  // The same request the header's case switcher makes, so the options cost nothing extra.
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
        description="Browse the support cases in this workspace and open one to investigate it."
        help={PAGE_HELP}
        actions={
          <div className={styles.actions}>
            <Button
              appearance="outline"
              icon={<ArrowSyncRegular />}
              disabled={auth.status !== 'ready' || pages.isFetching}
              onClick={() => void pages.refetch()}
            >
              {pages.isFetching && !pages.isPending ? 'Refreshing…' : 'Refresh'}
            </Button>
            <GatedAction permission="case:ingest">
              <LinkButton href="/cases/new" appearance="primary" icon={<AddRegular />}>
                Ingest a case
              </LinkButton>
            </GatedAction>
          </div>
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
              <Field label="Search" className={styles.search}>
                <Input
                  {...searchField.inputProps}
                  type="search"
                  placeholder="Reference, title, product or customer"
                  contentBefore={<SearchRegular aria-hidden="true" />}
                  maxLength={200}
                />
              </Field>
              <Field label="Analysis state" className={styles.field}>
                <Select
                  value={state}
                  onChange={(_event, next) =>
                    update({ state: next.value as (typeof STATE_FILTERS)[number] })
                  }
                >
                  {STATE_FILTERS.map((value) => (
                    <option key={value} value={value}>
                      {STATE_FILTER_LABELS[value]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Case status" className={styles.field}>
                <Select
                  value={status}
                  onChange={(_event, next) =>
                    update({ status: next.value as (typeof STATUS_FILTERS)[number] })
                  }
                >
                  {STATUS_FILTERS.map((value) => (
                    <option key={value} value={value}>
                      {STATUS_FILTER_LABELS[value]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Workload" className={styles.field}>
                <Select
                  value={workload}
                  onChange={(_event, next) => update({ workload: next.value })}
                >
                  <option value="">Any workload</option>
                  {workloads.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Data label" className={styles.field}>
                <Select
                  value={dataFilter}
                  onChange={(_event, next) =>
                    update({ data: next.value as (typeof DATA_FILTERS)[number] })
                  }
                >
                  {DATA_FILTERS.map((value) => (
                    <option key={value} value={value}>
                      {DATA_FILTER_LABELS[value]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Sort by" className={styles.field}>
                <Select
                  value={sortKey(sort)}
                  onChange={(_event, next) => {
                    const option = SORT_OPTIONS.find((candidate) => candidate.value === next.value);
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
              </Field>
              <Button appearance="subtle" disabled={!active} onClick={clearFilters}>
                Clear filters
              </Button>
            </form>

            <Notice variant="model-estimate" compact title="Estimates">
              Quality, avoidable effort and hypothesis confidence are estimates from the analysis of
              each case. They compare cases and processes; they are not a rating of any person.
            </Notice>

            <div className={styles.summary}>
              <span role="status" aria-live="polite">
                {visible.length === 0
                  ? 'No loaded case matches.'
                  : `Showing ${visible.length} ${visible.length === 1 ? 'case' : 'cases'}${
                      dataFilter !== 'all' && visible.length !== loaded.length
                        ? ` of the ${loaded.length} loaded`
                        : ''
                    }${pages.hasNextPage ? '. More are available.' : '.'}`}
              </span>
              <span>
                Sorted by {sortColumnLabel(sort).toLowerCase()}. The data label filter and the sort
                apply to the cases loaded so far.
              </span>
            </div>

            {visible.length === 0 ? (
              <EmptyState
                headingLevel={2}
                icon={<SearchRegular />}
                title={active ? 'No cases match these filters' : 'No cases to show'}
                description={
                  pages.hasNextPage
                    ? 'None of the cases loaded so far match. Load more cases, or loosen the filters.'
                    : 'Loosen or clear the filters to see more cases.'
                }
                action={
                  <Button appearance="primary" onClick={clearFilters} disabled={!active}>
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
                  appearance="outline"
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
