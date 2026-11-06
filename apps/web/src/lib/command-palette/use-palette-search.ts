import type { SearchResult } from '@caseguard/schemas';
import { useMemo } from 'react';
import { useApiQuery } from '../api/hooks';
import { useAuth } from '../auth/context';
import { safeInternalHref } from '../safe-href';
import { useDebouncedValue } from '../use-debounced-value';

const TYPE_LABELS: Record<SearchResult['type'], string> = {
  case: 'Cases',
  claim: 'Claims',
  hypothesis: 'Possible causes',
  skill: 'Skills',
  warning: 'Warnings',
  event: 'Events',
};
const TYPE_ORDER: readonly SearchResult['type'][] = [
  'case',
  'hypothesis',
  'claim',
  'skill',
  'warning',
  'event',
];

export interface ResultGroup {
  type: SearchResult['type'];
  label: string;
  items: SearchResult[];
}

/** Groups results by type in a fixed order (the order of the groups is the keyboard order). Links that leave the app are dropped. */
export function groupResults(items: readonly SearchResult[]): ResultGroup[] {
  return TYPE_ORDER.map((type) => ({
    type,
    label: TYPE_LABELS[type],
    items: items.filter((item) => item.type === type && safeInternalHref(item.href) !== null),
  })).filter((group) => group.items.length > 0);
}

export interface PaletteSearch {
  groups: ResultGroup[];
  /** True while the query is still being typed or the request is in flight. */
  pending: boolean;
  error: unknown;
}

/**
 * The server-side search behind the command palette: from two characters on, debounced, tenant-scoped on the server
 * (`search.global`). It only runs while the palette is open and a person is signed in.
 */
export function usePaletteSearch(query: string, open: boolean): PaletteSearch {
  const auth = useAuth();
  const trimmed = query.trim();
  const debounced = useDebouncedValue(trimmed, 250);
  const ready = open && auth.status === 'ready' && debounced.length >= 2;
  const results = useApiQuery(
    'search.global',
    { query: { q: debounced, limit: 10 } },
    { enabled: ready, staleTime: 30_000 },
  );
  const groups = useMemo(
    () => (trimmed.length >= 2 ? groupResults(results.data?.items ?? []) : []),
    [results.data, trimmed],
  );
  return {
    groups,
    pending:
      open &&
      auth.status === 'ready' &&
      trimmed.length >= 2 &&
      (trimmed !== debounced || results.isFetching),
    error: ready && results.isError ? results.error : null,
  };
}
