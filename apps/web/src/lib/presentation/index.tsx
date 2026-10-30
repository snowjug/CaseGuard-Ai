'use client';

import { createPersistedStore, type PersistedStore } from '@caseguard/ui';
import { useSearchParams } from 'next/navigation';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useApiQuery } from '../api/hooks';
import { useAuth } from '../auth/context';
import { useSession } from '../auth/session';

export const PRESENT_STORAGE_KEY = 'cg-present';

function sessionStorageOrUndefined(): Storage | undefined {
  return typeof window === 'undefined' ? undefined : window.sessionStorage;
}

/** Presentation mode lives for the browser tab (sessionStorage) so it survives client-side navigation. */
export function createPresentationStore(
  getStorage: () => Storage | undefined = sessionStorageOrUndefined,
): PersistedStore<boolean> {
  return createPersistedStore<boolean>({
    key: PRESENT_STORAGE_KEY,
    parse: (raw) => raw === '1',
    serialize: (value) => (value ? '1' : null),
    getStorage,
  });
}

const defaultStore = createPresentationStore();

export interface PresentationState {
  /** True while presentation mode is on: dev controls hidden, larger type, presenter strip visible. */
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  toggle: () => void;
}

const PresentationContext = createContext<PresentationState | null>(null);

/**
 * Presentation mode (`?present=1` or the header toggle). `?present=1` switches it on, `?present=0` off; the choice then
 * persists for the tab. It hides development controls, enlarges type slightly and shows the presenter strip.
 */
export function PresentationProvider({
  children,
  store = defaultStore,
}: {
  children: ReactNode;
  store?: PersistedStore<boolean>;
}) {
  const enabled = useSyncExternalStore(store.subscribe, store.get, () => false);
  const present = useSearchParams().get('present');

  useEffect(() => {
    if (present === '1') store.set(true);
    else if (present === '0') store.set(false);
  }, [present, store]);

  useEffect(() => {
    document.documentElement.dataset.cgPresent = enabled ? 'true' : 'false';
  }, [enabled]);

  const value = useMemo<PresentationState>(
    () => ({
      enabled,
      setEnabled: (next) => store.set(next),
      toggle: () => store.set(!store.get()),
    }),
    [enabled, store],
  );
  return <PresentationContext.Provider value={value}>{children}</PresentationContext.Provider>;
}

export function usePresentation(): PresentationState {
  const value = useContext(PresentationContext);
  if (!value) throw new Error('usePresentation must be used inside <PresentationProvider>');
  return value;
}

/**
 * The guided-demo state from `demo.state` while presenting (nothing is fetched otherwise, nor for a role that may not
 * read cases, which is what the route needs). It is re-read every 15 s, but not while the tab is hidden. `current` is
 * the step the presenter should do next; its `route` is highlighted in the navigation.
 */
export function usePresenterStep() {
  const { enabled } = usePresentation();
  const auth = useAuth();
  const { can } = useSession();
  const query = useApiQuery('demo.state', undefined, {
    enabled: enabled && auth.status === 'ready' && can('case:read'),
    refetchInterval: enabled ? 15_000 : false,
    refetchIntervalInBackground: false,
  });
  const steps = query.data?.steps ?? [];
  const current =
    steps.find((step) => step.isNextAction) ??
    steps.find((step) => !step.completed && step.enabled) ??
    null;
  return { query, steps, current, completed: steps.filter((step) => step.completed).length };
}

/** True when presenting and `href` is where the current demo step leads: draws the pulsing outline (reduced-motion safe). */
export function usePresenterHighlight(href: string): boolean {
  const { enabled } = usePresentation();
  const { current } = usePresenterStep();
  if (!enabled || !current) return false;
  const target = current.route.split('?')[0] ?? current.route;
  const here = href.split('?')[0] ?? href;
  return target === here || (here !== '/' && target.startsWith(`${here}/`));
}
