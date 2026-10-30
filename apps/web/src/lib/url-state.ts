'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useCallback, useMemo } from 'react';

/**
 * Shareable, typed URL query state for filters, `asOf`, selection and tabs. The URL is the source of truth, so every
 * view is deep-linkable. Updates use the History API (`replaceState` / `pushState`), which the Next.js App Router
 * observes: `useSearchParams` re-renders without a full reload and without a server round trip.
 */
export interface UrlCodec<T> {
  /** Raw query value (null when absent) to a typed value. Must be total: never throw on hostile input. */
  parse(raw: string | null): T;
  /** Value to store, or null to remove the key (use for defaults so URLs stay short and canonical). */
  serialize(value: T): string | null;
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

/** Ready-made codecs. All of them fall back to a safe default on malformed input. */
export const codecs = {
  /** Free text; the empty string is the default and is omitted from the URL. */
  string(fallback = ''): UrlCodec<string> {
    return {
      parse: (raw) => raw ?? fallback,
      serialize: (value) => (value === fallback || value === '' ? null : value),
    };
  },
  /** Free text or `null`. */
  optionalString(): UrlCodec<string | null> {
    return {
      parse: (raw) => (raw && raw.length > 0 ? raw : null),
      serialize: (value) => (value ? value : null),
    };
  },
  /** One of a fixed set of values (a tab, a mode, a status filter). Unknown values fall back. */
  enumOf<const V extends readonly string[]>(values: V, fallback: V[number]): UrlCodec<V[number]> {
    return {
      parse: (raw) =>
        raw !== null && (values as readonly string[]).includes(raw) ? raw : fallback,
      serialize: (value) => (value === fallback ? null : value),
    };
  },
  /** Integer within optional bounds. */
  integer(options: { fallback: number; min?: number; max?: number }): UrlCodec<number> {
    const { fallback, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = options;
    return {
      parse: (raw) => {
        if (raw === null || !/^-?\d{1,15}$/.test(raw)) return fallback;
        return Math.min(max, Math.max(min, Number.parseInt(raw, 10)));
      },
      serialize: (value) => (value === fallback ? null : String(value)),
    };
  },
  /** `1` / `0` flag. */
  boolean(fallback = false): UrlCodec<boolean> {
    return {
      parse: (raw) => (raw === '1' ? true : raw === '0' ? false : fallback),
      serialize: (value) => (value === fallback ? null : value ? '1' : '0'),
    };
  },
  /** A UTC ISO-8601 instant (the `asOf` time cursor). Anything else, including impossible dates, is treated as absent. */
  isoTimestamp(): UrlCodec<string | null> {
    return {
      parse: (raw) => {
        if (raw === null || !ISO_UTC.test(raw)) return null;
        const ms = Date.parse(raw);
        // `Date` rolls 30 February over to March; round-tripping the date part rejects such values.
        return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === raw.slice(0, 10)
          ? raw
          : null;
      },
      serialize: (value) => value,
    };
  },
  /** Comma-separated list (event types, roles). Empty items are dropped; the empty list is the default. */
  stringList(): UrlCodec<string[]> {
    return {
      parse: (raw) =>
        raw
          ? raw
              .split(',')
              .map((item) => item.trim())
              .filter(Boolean)
          : [],
      serialize: (value) => (value.length > 0 ? value.join(',') : null),
    };
  },
};

export interface UrlStateOptions {
  /** `replace` (default) keeps Back working per page; `push` creates a history entry (tabs, selection). */
  history?: 'replace' | 'push';
}

type Patch = Record<string, string | null>;

/** Applies a patch to the current URL's query string. Exported for tests and for non-hook callers. */
export function writeUrlState(patch: Patch, history: 'replace' | 'push' = 'replace'): void {
  const params = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) params.delete(key);
    else params.set(key, value);
  }
  const query = params.toString();
  const url = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
  if (history === 'push') window.history.pushState(null, '', url);
  else window.history.replaceState(null, '', url);
}

/** One typed query parameter. The setter accepts a value or an updater and never triggers a full page load. */
export function useUrlState<T>(
  key: string,
  codec: UrlCodec<T>,
  options: UrlStateOptions = {},
): readonly [T, (next: T | ((previous: T) => T)) => void] {
  const searchParams = useSearchParams();
  const value = useMemo(() => codec.parse(searchParams.get(key)), [codec, searchParams, key]);
  const history = options.history ?? 'replace';
  const setValue = useCallback(
    (next: T | ((previous: T) => T)) => {
      const current = codec.parse(new URLSearchParams(window.location.search).get(key));
      const resolved = typeof next === 'function' ? (next as (previous: T) => T)(current) : next;
      writeUrlState({ [key]: codec.serialize(resolved) }, history);
    },
    [codec, key, history],
  );
  return [value, setValue] as const;
}

type Schema = Record<string, UrlCodec<unknown>>;
export type UrlValues<S extends Schema> = {
  [K in keyof S]: S[K] extends UrlCodec<infer T> ? T : never;
};

/**
 * Several typed parameters at once (a filter bar). `update` changes any subset in one history operation, so
 * "set the status and reset the page cursor" is a single URL change.
 */
export function useUrlStates<S extends Schema>(
  schema: S,
  options: UrlStateOptions = {},
): readonly [UrlValues<S>, (patch: Partial<UrlValues<S>>) => void] {
  const searchParams = useSearchParams();
  const values = useMemo(() => {
    const entries = Object.entries(schema).map(
      ([key, codec]) => [key, codec.parse(searchParams.get(key))] as const,
    );
    return Object.fromEntries(entries) as UrlValues<S>;
  }, [schema, searchParams]);
  const history = options.history ?? 'replace';
  const update = useCallback(
    (patch: Partial<UrlValues<S>>) => {
      const next: Patch = {};
      for (const [key, value] of Object.entries(patch)) {
        const codec = schema[key];
        if (codec) next[key] = codec.serialize(value);
      }
      writeUrlState(next, history);
    },
    [schema, history],
  );
  return [values, update] as const;
}

const ASOF_CODEC = codecs.isoTimestamp();
const SELECTION_CODEC = codecs.optionalString();

/** `?asOf=<UTC instant>`: the temporal boundary shared by every case page. `null` means no limit. */
export function useAsOfState() {
  return useUrlState('asOf', ASOF_CODEC);
}

/** `?sel=<id>`: the selected item (a graph node, a claim). Pushes history so Back closes the side panel. */
export function useSelectionState(key = 'sel') {
  return useUrlState(key, SELECTION_CODEC, { history: 'push' });
}

/** `?tab=<name>`: the active tab, restricted to the known set. */
export function useTabState<const V extends readonly string[]>(
  tabs: V,
  fallback: V[number],
  key = 'tab',
) {
  const codec = useMemo(() => codecs.enumOf(tabs, fallback), [tabs, fallback]);
  return useUrlState(key, codec, { history: 'push' });
}

/** Current pathname and query as a single relative URL (for building share links). */
export function useCurrentUrl(): string {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const query = searchParams.toString();
  return query ? `${pathname}?${query}` : pathname;
}
