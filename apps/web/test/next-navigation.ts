import { useMemo, useSyncExternalStore } from 'react';
import { vi } from 'vitest';

/**
 * In-memory stand-in for `next/navigation`, backed by `window.history` so the URL-state hooks behave as they do in the
 * App Router: writing the URL with `history.replaceState` re-renders every `useSearchParams` reader. The real router
 * reports a new URL a moment after it was written; `setNavigationLatency` makes this one do the same, so a test can
 * type faster than the router answers.
 */

const EVENT = 'cg-test-navigation';

let latencyMs = 0;
/** What the router reports while it lags: the URL as of its last publication. Without latency the URL itself is read. */
let published = '';
/** Changes with every latency setting, so a report still on its way from before it is dropped. */
let generation = 0;

function publish(search: string): void {
  published = search;
  window.dispatchEvent(new Event(EVENT));
}

// Like the App Router, the router reports the URL as it was when it was written, in order, a moment later.
const notify = (): void => {
  const search = window.location.search;
  if (latencyMs <= 0) {
    publish(search);
    return;
  }
  const mine = generation;
  setTimeout(() => {
    if (mine === generation) publish(search);
  }, latencyMs);
};

/** Makes `useSearchParams` report each change `ms` milliseconds after the URL was written (0: at once, the default). */
export function setNavigationLatency(ms: number): void {
  generation += 1;
  latencyMs = ms;
  published = window.location.search;
}

let patched = false;
export function patchHistory(): void {
  if (patched) return;
  patched = true;
  for (const method of ['pushState', 'replaceState'] as const) {
    const original = window.history[method].bind(window.history);
    window.history[method] = (data: unknown, unused: string, url?: string | URL | null) => {
      original(data, unused, url);
      notify();
    };
  }
  window.addEventListener('popstate', notify);
}

function subscribe(listener: () => void): () => void {
  window.addEventListener(EVENT, listener);
  return () => {
    window.removeEventListener(EVENT, listener);
  };
}

export function useSearchParams(): URLSearchParams {
  const search = useSyncExternalStore(
    subscribe,
    () => (latencyMs > 0 ? published : window.location.search),
    () => '',
  );
  return useMemo(() => new URLSearchParams(search), [search]);
}

export function usePathname(): string {
  return useSyncExternalStore(
    subscribe,
    () => window.location.pathname,
    () => '/',
  );
}

export const router = {
  push: vi.fn((url: string) => window.history.pushState(null, '', url)),
  replace: vi.fn((url: string) => window.history.replaceState(null, '', url)),
  back: vi.fn(),
  forward: vi.fn(),
  refresh: vi.fn(),
  prefetch: vi.fn(),
};

export function useRouter(): typeof router {
  return router;
}

export function useServerInsertedHTML(): void {
  // Nothing to flush in tests.
}

export const notFound = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND');
});
export const redirect = vi.fn();

/** Moves the fake browser to a URL without a reload. */
export function navigateTo(url: string): void {
  window.history.replaceState(null, '', url);
}
