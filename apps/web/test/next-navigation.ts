import { useMemo, useSyncExternalStore } from 'react';
import { vi } from 'vitest';

/**
 * In-memory stand-in for `next/navigation`, backed by `window.history` so the URL-state hooks behave as they do in the
 * App Router: writing the URL with `history.replaceState` re-renders every `useSearchParams` reader.
 */

const EVENT = 'cg-test-navigation';
const notify = (): void => {
  window.dispatchEvent(new Event(EVENT));
};

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
}

function subscribe(listener: () => void): () => void {
  window.addEventListener(EVENT, listener);
  window.addEventListener('popstate', listener);
  return () => {
    window.removeEventListener(EVENT, listener);
    window.removeEventListener('popstate', listener);
  };
}

export function useSearchParams(): URLSearchParams {
  const search = useSyncExternalStore(
    subscribe,
    () => window.location.search,
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
