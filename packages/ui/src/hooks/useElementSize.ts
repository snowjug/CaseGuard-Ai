'use client';

import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';

export interface ElementSize {
  width: number;
  height: number;
}

/**
 * Observes an element's content box without setting state in an effect (`useSyncExternalStore`).
 * Returns `fallback` during SSR, before the first measurement and where ResizeObserver or layout is unavailable.
 */
export function useElementSize<T extends HTMLElement>(
  fallback: ElementSize,
): [(node: T | null) => void, ElementSize] {
  const [node, setNode] = useState<T | null>(null);
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!node || typeof ResizeObserver === 'undefined') return () => undefined;
      const observer = new ResizeObserver(onChange);
      observer.observe(node);
      return () => observer.disconnect();
    },
    [node],
  );
  const fallbackKey = `${fallback.width}x${fallback.height}`;
  // A string snapshot keeps the value referentially stable between reads.
  const key = useSyncExternalStore(
    subscribe,
    () =>
      node && node.clientWidth > 0 && node.clientHeight > 0
        ? `${node.clientWidth}x${node.clientHeight}`
        : fallbackKey,
    () => fallbackKey,
  );
  const size = useMemo<ElementSize>(() => {
    const [w, h] = key.split('x').map(Number);
    return { width: w ?? fallback.width, height: h ?? fallback.height };
  }, [key, fallback.width, fallback.height]);
  return [setNode, size];
}
