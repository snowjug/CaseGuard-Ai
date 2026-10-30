import { useCallback, useSyncExternalStore } from 'react';

/**
 * Subscribes to a CSS media query. `serverDefault` is used during server rendering and the first hydration pass,
 * so markup never mismatches; React re-renders immediately afterwards if the real value differs.
 */
export function useMediaQuery(query: string, serverDefault = false): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return () => undefined;
      }
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query],
  );
  const getSnapshot = useCallback(
    () =>
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia(query).matches
        : serverDefault,
    [query, serverDefault],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => serverDefault);
}
