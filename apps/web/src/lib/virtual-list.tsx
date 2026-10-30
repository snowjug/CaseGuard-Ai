'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';

/** Index range `[start, end)` of the rows that intersect the viewport, widened by `overscan` rows on each side. */
export function visibleRange(
  offsets: readonly number[],
  viewTop: number,
  viewBottom: number,
  overscan: number,
): { start: number; end: number } {
  const count = offsets.length - 1;
  if (count <= 0) return { start: 0, end: 0 };
  // First row whose bottom edge is below the top of the viewport (binary search over the prefix sums).
  let low = 0;
  let high = count - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((offsets[mid + 1] ?? 0) > viewTop) high = mid;
    else low = mid + 1;
  }
  let end = low;
  while (end < count && (offsets[end] ?? 0) < viewBottom) end += 1;
  return {
    start: Math.max(0, low - overscan),
    end: Math.min(count, Math.max(end, low + 1) + overscan),
  };
}

export interface VirtualItem {
  index: number;
  key: string;
  /** Distance from the top of the list in pixels (only meaningful while `virtualized`). */
  start: number;
}

export interface WindowVirtualizerOptions {
  count: number;
  /** Stable identity of the row at `index`; measured heights follow it when the list is filtered or re-sorted. */
  getKey: (index: number) => string;
  /** Height assumed for a row until it has been measured. */
  estimateSize: number;
  /** Extra rows rendered above and below the viewport (default 6). */
  overscan?: number;
  /** Lists with at most this many rows are rendered in full, without windowing (default 60). */
  threshold?: number;
}

export interface WindowVirtualizer {
  /** Attach to the element that contains the rows. */
  containerRef: (node: HTMLElement | null) => void;
  items: readonly VirtualItem[];
  /** Total height of the list in pixels while windowed. */
  totalSize: number;
  virtualized: boolean;
  /** Called by a row with its measured height. */
  onMeasure: (key: string, height: number) => void;
  /** Scrolls the page so the row at `index` is near the top (below the sticky header). */
  scrollToIndex: (index: number, headerOffset?: number) => void;
}

/**
 * Windowing for long lists that scroll with the page (no nested scroll area): only the rows near the viewport are
 * rendered. Row heights are measured (`VirtualRow`) so rows may wrap; until then `estimateSize` is used. Short lists
 * are rendered in full, which keeps find-in-page and the tab order complete where windowing is not needed.
 */
export function useWindowVirtualizer({
  count,
  getKey,
  estimateSize,
  overscan = 6,
  threshold = 60,
}: WindowVirtualizerOptions): WindowVirtualizer {
  const element = useRef<HTMLElement | null>(null);
  const [sizes, setSizes] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [viewport, setViewport] = useState({ top: 0, bottom: 1200 });
  const virtualized = count > threshold;

  const update = useCallback(() => {
    const node = element.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const next = {
      top: Math.max(0, -rect.top),
      bottom: Math.max(0, window.innerHeight - rect.top),
    };
    setViewport((previous) =>
      previous.top === next.top && previous.bottom === next.bottom ? previous : next,
    );
  }, []);

  useEffect(() => {
    if (!virtualized) return undefined;
    let frame = 0;
    const schedule = (): void => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        update();
      });
    };
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    schedule();
    return () => {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, [virtualized, update, count]);

  const containerRef = useCallback(
    (node: HTMLElement | null) => {
      element.current = node;
      if (node) window.requestAnimationFrame(update);
    },
    [update],
  );

  const onMeasure = useCallback((key: string, height: number) => {
    const rounded = Math.round(height);
    if (rounded <= 0) return;
    setSizes((previous) => {
      const known = previous.get(key);
      if (known !== undefined && Math.abs(known - rounded) < 1) return previous;
      return new Map(previous).set(key, rounded);
    });
  }, []);

  const offsets = useMemo(() => {
    const out: number[] = new Array<number>(count + 1);
    out[0] = 0;
    for (let index = 0; index < count; index += 1) {
      out[index + 1] = (out[index] ?? 0) + (sizes.get(getKey(index)) ?? estimateSize);
    }
    return out;
  }, [count, getKey, sizes, estimateSize]);

  const items = useMemo<VirtualItem[]>(() => {
    const range = virtualized
      ? visibleRange(offsets, viewport.top, viewport.bottom, overscan)
      : { start: 0, end: count };
    const out: VirtualItem[] = [];
    for (let index = range.start; index < range.end; index += 1) {
      out.push({ index, key: getKey(index), start: offsets[index] ?? 0 });
    }
    return out;
  }, [virtualized, offsets, viewport, overscan, count, getKey]);

  const scrollToIndex = useCallback(
    (index: number, headerOffset = 96) => {
      const node = element.current;
      if (!node) return;
      const top = node.getBoundingClientRect().top + window.scrollY + (offsets[index] ?? 0);
      window.scrollTo({ top: Math.max(0, top - headerOffset), behavior: 'auto' });
    },
    [offsets],
  );

  return {
    containerRef,
    items,
    totalSize: offsets[count] ?? 0,
    virtualized,
    onMeasure,
    scrollToIndex,
  };
}

/**
 * Calls `onNearEnd` when the returned element comes within a screen of the viewport (infinite scrolling). Attach the
 * returned ref to an empty element after the list. The observer lives as long as `enabled` and the element do: a new
 * `onNearEnd` is picked up without rebuilding it (a rebuilt observer reports at once, which would repeat a request that
 * had just failed, in a loop). A caller that must not load while a request runs or after one failed ignores the call
 * (or passes `enabled` false); it asks again from a Retry button, not from here.
 */
export function useNearEnd(
  enabled: boolean,
  onNearEnd: () => void,
): (node: HTMLElement | null) => void {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const latest = useRef(onNearEnd);
  useEffect(() => {
    latest.current = onNearEnd;
  }, [onNearEnd]);
  useEffect(() => {
    if (!enabled || !node || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) latest.current();
      },
      { rootMargin: '600px 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled, node]);
  return setNode;
}

export interface VirtualRowProps {
  itemKey: string;
  /** Position in the full list (1-based position and the list size are announced to assistive technology). */
  index: number;
  count: number;
  start: number;
  virtualized: boolean;
  onMeasure: (key: string, height: number) => void;
  className?: string | undefined;
  children: ReactNode;
}

/** One row of a windowed list: positions itself, reports its height and announces its place in the whole list. */
export function VirtualRow({
  itemKey,
  index,
  count,
  start,
  virtualized,
  onMeasure,
  className,
  children,
}: VirtualRowProps) {
  const [node, setNode] = useState<HTMLLIElement | null>(null);

  useEffect(() => {
    if (!virtualized || !node || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => onMeasure(itemKey, node.offsetHeight));
    observer.observe(node);
    return () => observer.disconnect();
  }, [virtualized, node, itemKey, onMeasure]);

  const style: CSSProperties | undefined = virtualized
    ? { position: 'absolute', top: start, left: 0, right: 0 }
    : undefined;
  return (
    <li
      ref={setNode}
      className={className}
      style={style}
      aria-posinset={index + 1}
      aria-setsize={count}
    >
      {children}
    </li>
  );
}
