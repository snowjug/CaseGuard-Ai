import { useSyncExternalStore } from 'react';
import { createPersistedStore, type PersistedStore } from './persisted-store';
import { useMediaQuery } from '../hooks/useMediaQuery';

/** `system` follows the OS setting; `reduce` / `allow` are manual overrides persisted in localStorage. */
export type ReducedMotionPreference = 'system' | 'reduce' | 'allow';

export const REDUCED_MOTION_STORAGE_KEY = 'cg-reduced-motion';

export function parseReducedMotionPreference(raw: string | null): ReducedMotionPreference {
  return raw === 'reduce' || raw === 'allow' ? raw : 'system';
}

/** Creates the preference store; exported so tests (and apps) can inject their own storage. */
export function createReducedMotionStore(
  getStorage?: () => Storage | undefined,
): PersistedStore<ReducedMotionPreference> {
  return createPersistedStore<ReducedMotionPreference>({
    key: REDUCED_MOTION_STORAGE_KEY,
    parse: parseReducedMotionPreference,
    serialize: (value) => (value === 'system' ? null : value),
    ...(getStorage ? { getStorage } : {}),
  });
}

/** The app-wide store used by the hooks below. */
export const reducedMotionStore = createReducedMotionStore();

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** The stored manual preference (`system` until the user chooses). */
export function useReducedMotionPreference(): [
  ReducedMotionPreference,
  (next: ReducedMotionPreference) => void,
] {
  const preference = useSyncExternalStore(
    reducedMotionStore.subscribe,
    reducedMotionStore.get,
    () => 'system' as const,
  );
  return [preference, reducedMotionStore.set];
}

/**
 * True when animation must be suppressed: the OS asks for reduced motion (and the user has not overridden it),
 * or the user switched reduced motion on in settings.
 */
export function useReducedMotion(): boolean {
  const [preference] = useReducedMotionPreference();
  const systemReduces = useMediaQuery(REDUCED_MOTION_QUERY, false);
  if (preference === 'reduce') return true;
  if (preference === 'allow') return false;
  return systemReduces;
}
