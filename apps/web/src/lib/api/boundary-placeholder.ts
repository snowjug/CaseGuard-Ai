import type { QueryKey } from '@tanstack/react-query';

/** The request of a view of one case, as it is passed to `useApiQuery` / `useApiPages`. */
export interface BoundaryRequest {
  params?: Record<string, unknown> | undefined;
  query?: Record<string, unknown> | undefined;
}

interface KeyParts {
  params: string;
  asOf: string | undefined;
  forkId: string | undefined;
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/** A stable form of the route params (`queryKeys.request` puts them at position 3 of the key). */
function paramsText(params: unknown): string {
  if (typeof params !== 'object' || params === null) return '';
  return JSON.stringify(Object.entries(params).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function partsOfRequest(request: BoundaryRequest): KeyParts {
  return {
    params: paramsText(request.params ?? null),
    asOf: text(request.query?.asOf),
    forkId: text(request.query?.forkId),
  };
}

/** `queryKeys.request` builds `['api', identity, routeId, params, query]`; an infinite query appends `'pages'`. */
function partsOfKey(queryKey: QueryKey): KeyParts {
  const query = queryKey[4];
  const fields =
    typeof query === 'object' && query !== null ? (query as Record<string, unknown>) : {};
  return { params: paramsText(queryKey[3]), asOf: text(fields.asOf), forkId: text(fields.forkId) };
}

/**
 * True when a cached answer is about the same moment of the same case as this request: the same route params (the
 * case), the same `asOf` and the same `forkId`. Filters, sorting and cursors do not matter here.
 */
export function sameBoundary(queryKey: QueryKey, request: BoundaryRequest): boolean {
  const cached = partsOfKey(queryKey);
  const wanted = partsOfRequest(request);
  return (
    cached.params === wanted.params &&
    cached.asOf === wanted.asOf &&
    cached.forkId === wanted.forkId
  );
}

/**
 * `placeholderData` for a read of a case at a moment (`asOf`, `forkId`). TanStack's `keepPreviousData` serves the
 * previous request's answer while the next one loads, whatever that request was about: the whole record under a window
 * the person just chose, or a later window under an earlier one. Every number and sentence on the page would then
 * describe a moment other than the one named above it. This keeps the answer on screen only while the SAME moment is
 * refetched or re-filtered; across a boundary the query is pending, so the page shows its loading state.
 */
export function keepWithinBoundary<T>(request: BoundaryRequest) {
  return (
    previous: T | undefined,
    previousQuery: { queryKey: QueryKey } | undefined,
  ): T | undefined =>
    previousQuery !== undefined && sameBoundary(previousQuery.queryKey, request)
      ? previous
      : undefined;
}
