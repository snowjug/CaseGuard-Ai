import type { AnalysisState, CaseStatus, CaseSummary } from '@caseguard/schemas';
import type { SortState } from '@caseguard/ui';
import { boundedString } from '../../lib/url-codecs';
import { codecs, type UrlCodec } from '../../lib/url-state';

/** Page size of the case list. */
export const PAGE_SIZE = 25;

export const STATE_FILTERS = [
  'all',
  'not_analyzed',
  'queued',
  'running',
  'analyzed',
  'failed',
] as const;
export const STATUS_FILTERS = ['all', 'open', 'resolved', 'closed'] as const;
export const DATA_FILTERS = ['all', 'synthetic', 'not_synthetic'] as const;

export const STATE_FILTER_LABELS: Record<(typeof STATE_FILTERS)[number], string> = {
  all: 'Any analysis state',
  not_analyzed: 'Not analysed',
  queued: 'Queued',
  running: 'Analysing',
  analyzed: 'Analysed',
  failed: 'Analysis failed',
};
export const STATUS_FILTER_LABELS: Record<(typeof STATUS_FILTERS)[number], string> = {
  all: 'Any case status',
  open: 'Open',
  resolved: 'Resolved',
  closed: 'Closed',
};
export const DATA_FILTER_LABELS: Record<(typeof DATA_FILTERS)[number], string> = {
  all: 'Any data label',
  synthetic: 'Synthetic only',
  not_synthetic: 'Not synthetic',
};

export const SORT_COLUMNS = [
  'opened',
  'reference',
  'quality',
  'effort',
  'events',
  'warnings',
] as const;
export type SortColumn = (typeof SORT_COLUMNS)[number];

export const SORT_COLUMN_LABELS: Record<SortColumn, string> = {
  opened: 'Opened',
  reference: 'Reference',
  quality: 'Quality',
  effort: 'Avoidable effort',
  events: 'Events',
  warnings: 'Open warnings',
};

/** The server's own order (newest opened first), used when no sort is chosen. */
export const DEFAULT_SORT: SortState = { columnId: 'opened', direction: 'descending' };

const SORT_PATTERN = /^([a-z]+)\.(asc|desc)$/;

/** `?sort=quality.asc`; anything unknown falls back to the default (newest first), which is omitted from the URL. */
export const sortCodec: UrlCodec<SortState> = {
  parse: (raw) => {
    const match = raw ? SORT_PATTERN.exec(raw) : null;
    const column = match?.[1];
    if (!match || !column || !(SORT_COLUMNS as readonly string[]).includes(column)) {
      return DEFAULT_SORT;
    }
    return { columnId: column, direction: match[2] === 'asc' ? 'ascending' : 'descending' };
  },
  serialize: (value) =>
    value.columnId === DEFAULT_SORT.columnId && value.direction === DEFAULT_SORT.direction
      ? null
      : `${value.columnId}.${value.direction === 'ascending' ? 'asc' : 'desc'}`,
};

export const CASE_FILTERS = {
  q: boundedString(200),
  state: codecs.enumOf(STATE_FILTERS, 'all'),
  status: codecs.enumOf(STATUS_FILTERS, 'all'),
  workload: boundedString(80),
  data: codecs.enumOf(DATA_FILTERS, 'all'),
  sort: sortCodec,
} as const;

export interface CaseFilterValues {
  q: string;
  state: (typeof STATE_FILTERS)[number];
  status: (typeof STATUS_FILTERS)[number];
  workload: string;
  data: (typeof DATA_FILTERS)[number];
}

/** True when any filter (not the sort) narrows the list. */
export function hasActiveFilters(filters: CaseFilterValues): boolean {
  return (
    filters.q.trim() !== '' ||
    filters.state !== 'all' ||
    filters.status !== 'all' ||
    filters.workload !== '' ||
    filters.data !== 'all'
  );
}

/** The filters the API understands (`cases.list`). The synthetic label has no server filter, see `matchesDataFilter`. */
export function serverQuery(
  filters: CaseFilterValues,
  search: string,
): {
  limit: number;
  status?: CaseStatus;
  analysisState?: AnalysisState;
  workload?: string;
  q?: string;
} {
  return {
    limit: PAGE_SIZE,
    ...(filters.status !== 'all' ? { status: filters.status } : {}),
    ...(filters.state !== 'all' ? { analysisState: filters.state } : {}),
    ...(filters.workload ? { workload: filters.workload } : {}),
    ...(search ? { q: search } : {}),
  };
}

/** Client-side filter on the synthetic label: the API has no such parameter, so it applies to the cases loaded so far. */
export function matchesDataFilter(item: Pick<CaseSummary, 'synthetic'>, data: string): boolean {
  if (data === 'synthetic') return item.synthetic;
  if (data === 'not_synthetic') return !item.synthetic;
  return true;
}

/** Sort-value of a case for one sortable column (`null` sorts last). */
export function sortValueOf(item: CaseSummary, column: string): string | number | null {
  switch (column) {
    case 'opened':
      return Date.parse(item.openedAt);
    case 'reference':
      return item.reference;
    case 'quality':
      return item.qualityIndex;
    case 'effort':
      return item.avoidableEffortPct;
    case 'events':
      return item.eventCount;
    case 'warnings':
      return item.openWarningCount;
    default:
      return null;
  }
}

/** `quality.asc`: the value of the sort select and of the `?sort=` parameter. */
export function sortKey(sort: SortState): string {
  const column = (SORT_COLUMNS as readonly string[]).includes(sort.columnId)
    ? sort.columnId
    : DEFAULT_SORT.columnId;
  return `${column}.${sort.direction === 'ascending' ? 'asc' : 'desc'}`;
}

/** Human name of the sorted column. */
export function sortColumnLabel(sort: SortState): string {
  return SORT_COLUMN_LABELS[sort.columnId as SortColumn] ?? SORT_COLUMN_LABELS.opened;
}

/** `Opened: newest first` style option labels for the sort select. */
export function sortOptionLabel(column: SortColumn, direction: SortState['direction']): string {
  const asc = direction === 'ascending';
  switch (column) {
    case 'opened':
      return asc ? 'Opened: oldest first' : 'Opened: newest first';
    case 'reference':
      return asc ? 'Reference: A to Z' : 'Reference: Z to A';
    case 'quality':
      return asc ? 'Quality: lowest first' : 'Quality: highest first';
    case 'effort':
      return asc ? 'Avoidable effort: lowest first' : 'Avoidable effort: highest first';
    case 'events':
      return asc ? 'Events: fewest first' : 'Events: most first';
    case 'warnings':
      return asc ? 'Open warnings: fewest first' : 'Open warnings: most first';
  }
}
