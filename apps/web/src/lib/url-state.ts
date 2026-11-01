'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ChangeEvent,
  type CompositionEvent,
  type KeyboardEvent,
} from 'react';

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

/**
 * One typed query parameter. The setter accepts a value or an updater and never triggers a full page load. For text a
 * person types into an input use `useUrlTextState`, and for a choice made in a controlled control (a radio group, a tab
 * strip) use `useUrlChoiceState`: the value here follows `useSearchParams`, which reports a write a moment late.
 */
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
 * "set the status and reset the page cursor" is a single URL change. Text typed into an input is the exception: it
 * belongs to `useUrlTextState`.
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

/** Idle time after the last change before text typed into a field is written to the URL. */
export const URL_TEXT_DELAY_MS = 250;

export interface UrlTextOptions {
  /**
   * Idle time after the last change before the text is written to the URL (default 250 ms, trailing; `0` writes at every
   * change). Pressing Enter, or leaving the field, writes at once.
   */
  delayMs?: number | undefined;
}

/** What to spread onto the text input (a Fluent `Input` or a native `<input>`). */
export interface UrlTextProps {
  value: string;
  onChange: (event: ChangeEvent<HTMLInputElement>, data?: { value: string }) => void;
  onBlur: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  onCompositionStart: () => void;
  onCompositionEnd: (event: CompositionEvent<HTMLInputElement>) => void;
}

export interface UrlTextState {
  /**
   * The text of the field without an IME composition in progress: use it for the request and for "is a filter on".
   * It is what was typed, which the URL never overwrites while it is being edited.
   */
  value: string;
  inputProps: UrlTextProps;
  /** Replaces the text and the URL at once (a programmatic change, not typing). */
  set: (text: string) => void;
}

interface TextField {
  /** What the input shows. */
  text: string;
  /** `text` without an IME composition in progress: what it was when the composition began. */
  committed: string;
  composing: boolean;
  /** The URL value (raw) the field was last in step with. */
  seen: string | null;
  /** Text typed that has not reached the URL yet: waiting for the pause, or an IME composition in progress. */
  dirty: boolean;
  /** Values the field wrote to the URL whose arrival through `useSearchParams` has not been seen yet, oldest first. */
  sent: readonly (string | null)[];
}

type TextAction =
  | { type: 'type'; text: string }
  | { type: 'compose'; composing: boolean }
  | { type: 'written'; raw: string | null }
  | { type: 'settled' }
  | { type: 'url'; raw: string | null; text: string };

const MAX_SENT = 8;

function reduceText(state: TextField, action: TextAction): TextField {
  switch (action.type) {
    case 'type':
      return {
        ...state,
        text: action.text,
        committed: state.composing ? state.committed : action.text,
        dirty: true,
      };
    case 'compose':
      // Whatever the composition left in the field is committed when it ends (or the field loses focus).
      return {
        ...state,
        composing: action.composing,
        committed: action.composing ? state.committed : state.text,
      };
    case 'written':
      return { ...state, dirty: false, sent: [...state.sent, action.raw].slice(-MAX_SENT) };
    case 'settled':
      return { ...state, dirty: false };
    case 'url': {
      // The field's own write coming back, however late: the text is already there, or further on.
      const own = state.sent.indexOf(action.raw);
      if (own >= 0) return { ...state, seen: action.raw, sent: state.sent.slice(own + 1) };
      // Another reason (Back, a link, "Clear filters"): follow it, unless the person is typing, whose text stays.
      if (state.dirty || state.composing) return { ...state, seen: action.raw, sent: [] };
      return {
        text: action.text,
        committed: action.text,
        composing: false,
        seen: action.raw,
        dirty: false,
        sent: [],
      };
    }
  }
}

/**
 * A free-text parameter that a person types into (a search box, an id filter). `useUrlState` shows the URL's value,
 * which `useSearchParams` reports a moment after each write, so a field built on it re-renders with the old value
 * between two quick key presses and drops characters. This keeps the text in local state that the URL never overwrites
 * while it is being edited, and writes it to the URL when typing pauses (`delayMs`), on Enter and when the field loses
 * focus; an IME composition writes nothing until it ends. The text follows the URL again only when the URL changes for
 * another reason (Back and Forward, a link, "Clear filters", a write elsewhere) and nothing typed is waiting to be
 * written. Spread `inputProps` on the input and read `value` for everything else (the debounced request, whether a
 * filter is active). The text is kept in the codec's canonical form, so a bounded codec bounds what is typed too.
 * Selects, tabs and other choices are not typed: they stay on `useUrlState`/`useUrlStates`.
 */
export function useUrlTextState(
  key: string,
  codec: UrlCodec<string>,
  options: UrlTextOptions = {},
): UrlTextState {
  const searchParams = useSearchParams();
  const raw = searchParams.get(key);
  const delayMs = options.delayMs ?? URL_TEXT_DELAY_MS;
  const [field, dispatch] = useReducer(reduceText, undefined, (): TextField => {
    const text = codec.parse(raw);
    return { text, committed: text, composing: false, seen: raw, dirty: false, sent: [] };
  });
  if (field.seen !== raw) dispatch({ type: 'url', raw, text: codec.parse(raw) });

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const composing = useRef(false);
  /** The text typed and not written yet, or null. */
  const typed = useRef<string | null>(null);
  // A pause that is still running when the page goes away must not write into whatever URL is shown by then.
  useEffect(() => () => clearTimeout(timer.current), []);

  const write = useCallback(
    (text: string): void => {
      clearTimeout(timer.current);
      timer.current = undefined;
      typed.current = null;
      const next = codec.serialize(text);
      if (next === new URLSearchParams(window.location.search).get(key)) {
        dispatch({ type: 'settled' });
        return;
      }
      writeUrlState({ [key]: next });
      dispatch({ type: 'written', raw: next });
    },
    [codec, key],
  );

  const compose = useCallback((on: boolean): void => {
    composing.current = on;
    dispatch({ type: 'compose', composing: on });
    if (on) {
      clearTimeout(timer.current);
      timer.current = undefined;
    }
  }, []);

  const edit = useCallback(
    (input: string): void => {
      const text = codec.parse(codec.serialize(input));
      typed.current = text;
      dispatch({ type: 'type', text });
      clearTimeout(timer.current);
      timer.current = undefined;
      if (composing.current) return;
      if (delayMs <= 0) write(text);
      else timer.current = setTimeout(() => write(text), delayMs);
    },
    [codec, delayMs, write],
  );

  const flush = useCallback((): void => {
    if (composing.current) compose(false);
    if (typed.current !== null) write(typed.current);
  }, [compose, write]);

  const set = useCallback(
    (input: string): void => {
      if (composing.current) compose(false);
      const text = codec.parse(codec.serialize(input));
      dispatch({ type: 'type', text });
      write(text);
    },
    [codec, compose, write],
  );

  const inputProps: UrlTextProps = {
    value: field.text,
    onChange: (event, data) => edit(data?.value ?? event.target.value),
    onBlur: flush,
    onKeyDown: (event) => {
      // Enter that confirms an IME candidate is not a request to search.
      if (event.key === 'Enter' && !composing.current && !event.nativeEvent.isComposing) flush();
    },
    onCompositionStart: () => compose(true),
    onCompositionEnd: (event) => {
      compose(false);
      edit(event.currentTarget.value);
    },
  };
  return { value: field.committed, inputProps, set };
}

interface ChoiceField {
  /** What the control shows, as the URL's raw value: the choice made last, or the URL's after it changed for another reason. */
  raw: string | null;
  /** The URL value (raw) the field was last in step with. */
  seen: string | null;
  /** Values the field wrote to the URL whose arrival through `useSearchParams` has not been seen yet, oldest first. */
  sent: readonly (string | null)[];
}

type ChoiceAction =
  { type: 'choose'; raw: string | null; written: boolean } | { type: 'url'; raw: string | null };

function reduceChoice(state: ChoiceField, action: ChoiceAction): ChoiceField {
  switch (action.type) {
    case 'choose':
      return {
        ...state,
        raw: action.raw,
        sent: action.written ? [...state.sent, action.raw].slice(-MAX_SENT) : state.sent,
      };
    case 'url': {
      // The field's own write coming back, however late: the choice is already shown, or a later one is.
      const own = state.sent.indexOf(action.raw);
      if (own >= 0) return { ...state, seen: action.raw, sent: state.sent.slice(own + 1) };
      // Another reason (Back, a link, a write elsewhere): follow the URL.
      return { raw: action.raw, seen: action.raw, sent: [] };
    }
  }
}

/**
 * One typed choice whose value lives in the URL (a radio group, a tab strip, a select). `useUrlState` shows the URL's
 * value, which `useSearchParams` reports a moment after each write, so a controlled control built on it springs back to
 * the old choice right after a click (React restores a controlled input whose handler changed no state) and moves on
 * only when the router answers: for that moment the click has changed nothing, to a script or a slow machine as much as
 * to a person. This keeps the choice in local state that changes at once and writes it to the URL for deep links. The
 * choice follows the URL again when the URL changes for another reason (Back and Forward, a link, a write elsewhere);
 * the router's late report of the hook's own writes changes nothing. Typed text belongs to `useUrlTextState`.
 */
export function useUrlChoiceState<T>(
  key: string,
  codec: UrlCodec<T>,
  options: UrlStateOptions = {},
): readonly [T, (next: T) => void] {
  const searchParams = useSearchParams();
  const raw = searchParams.get(key);
  const history = options.history ?? 'replace';
  const [field, dispatch] = useReducer(reduceChoice, { raw, seen: raw, sent: [] });
  if (field.seen !== raw) dispatch({ type: 'url', raw });
  const value = useMemo(() => codec.parse(field.raw), [codec, field.raw]);
  const set = useCallback(
    (next: T): void => {
      const serialized = codec.serialize(next);
      const written = serialized !== new URLSearchParams(window.location.search).get(key);
      // The choice is shown before the URL is written, so no report of the write can arrive ahead of it.
      dispatch({ type: 'choose', raw: serialized, written });
      if (written) writeUrlState({ [key]: serialized }, history);
    },
    [codec, key, history],
  );
  return [value, set] as const;
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
