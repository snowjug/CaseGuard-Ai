import { act, configure, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useCallback } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  VirtualRow,
  useNearEnd,
  useWindowVirtualizer,
  visibleRange,
  type WindowVirtualizerOptions,
} from './virtual-list';

configure({ asyncUtilTimeout: 5000 });

/** Prefix sums of `count` rows of `size` pixels. */
const offsets = (count: number, size: number): number[] =>
  Array.from({ length: count + 1 }, (_, index) => index * size);

describe('visibleRange', () => {
  it('returns nothing for an empty list', () => {
    expect(visibleRange([0], 0, 800, 3)).toEqual({ start: 0, end: 0 });
  });

  it('covers the viewport and widens it by the overscan', () => {
    // 100 rows of 100px; the viewport shows pixels 1000-1450 = rows 10 to 14.
    expect(visibleRange(offsets(100, 100), 1000, 1450, 0)).toEqual({ start: 10, end: 15 });
    expect(visibleRange(offsets(100, 100), 1000, 1450, 2)).toEqual({ start: 8, end: 17 });
  });

  it('includes a row that is only partly in view at either edge', () => {
    expect(visibleRange(offsets(100, 100), 1050, 1150, 0)).toEqual({ start: 10, end: 12 });
  });

  it('clamps at both ends of the list', () => {
    expect(visibleRange(offsets(20, 100), 0, 250, 5)).toEqual({ start: 0, end: 8 });
    expect(visibleRange(offsets(20, 100), 1900, 5000, 5)).toEqual({ start: 14, end: 20 });
  });

  it('always keeps at least one row, even when the viewport is past the end or empty', () => {
    const past = visibleRange(offsets(10, 100), 5000, 6000, 0);
    expect(past.end - past.start).toBeGreaterThanOrEqual(1);
    expect(past.end).toBe(10);
    expect(visibleRange(offsets(10, 100), 300, 300, 0)).toEqual({ start: 3, end: 4 });
  });

  it('follows rows of different heights', () => {
    // Heights 50, 200, 50, 50: the second row spans 50-250.
    expect(visibleRange([0, 50, 250, 300, 350], 100, 260, 0)).toEqual({ start: 1, end: 3 });
  });
});

interface ProbeProps extends Partial<Pick<WindowVirtualizerOptions, 'threshold' | 'overscan'>> {
  count: number;
  scrollTo?: number;
}

function VirtualProbe({ count, scrollTo, ...options }: ProbeProps) {
  const getKey = useCallback((index: number) => `k${index}`, []);
  const { containerRef, items, totalSize, virtualized, onMeasure, scrollToIndex } =
    useWindowVirtualizer({ count, getKey, estimateSize: 100, ...options });
  return (
    <div>
      <button type="button" onClick={() => scrollToIndex(scrollTo ?? 0)}>
        scroll
      </button>
      <ul
        ref={containerRef}
        aria-label="rows"
        data-virtualized={String(virtualized)}
        data-total={totalSize}
      >
        {items.map((item) => (
          <VirtualRow
            key={item.key}
            itemKey={item.key}
            index={item.index}
            count={count}
            start={item.start}
            virtualized={virtualized}
            onMeasure={onMeasure}
          >
            row {item.index}
          </VirtualRow>
        ))}
      </ul>
    </div>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useWindowVirtualizer', () => {
  it('renders a short list in full, without windowing', () => {
    render(<VirtualProbe count={20} />);
    const list = screen.getByRole('list', { name: 'rows' });
    expect(list).toHaveAttribute('data-virtualized', 'false');
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(20);
    expect(rows[0]?.style.position).toBe('');
  });

  it('windows a long list: few rows are rendered, placed absolutely, and announce their place in the whole list', () => {
    render(<VirtualProbe count={1000} />);
    expect(screen.getByRole('list', { name: 'rows' })).toHaveAttribute('data-virtualized', 'true');
    const rows = screen.getAllByRole('listitem');
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.length).toBeLessThan(30);
    expect(screen.getByRole('list', { name: 'rows' })).toHaveAttribute('data-total', '100000');
    expect(rows[0]).toHaveAttribute('aria-posinset', '1');
    expect(rows[0]).toHaveAttribute('aria-setsize', '1000');
    expect(rows[3]?.style.position).toBe('absolute');
    expect(rows[3]?.style.top).toBe('300px');
  });

  it('honours the threshold', () => {
    render(<VirtualProbe count={30} threshold={10} />);
    expect(screen.getByRole('list', { name: 'rows' })).toHaveAttribute('data-virtualized', 'true');
    expect(screen.getAllByRole('listitem').length).toBeLessThan(30);
  });

  it('uses the measured height of a row instead of the estimate', async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private readonly callback: () => void) {}
        observe(): void {
          this.callback();
        }
        disconnect(): void {}
        unobserve(): void {}
      },
    );
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(250);
    render(<VirtualProbe count={1000} />);
    await waitFor(() => {
      expect(
        Number(screen.getByRole('list', { name: 'rows' }).getAttribute('data-total')),
      ).toBeGreaterThan(100000);
    });
  });

  it('scrolls the page so the chosen row sits just below the header', async () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    const user = userEvent.setup();
    render(<VirtualProbe count={1000} scrollTo={5} />);
    await user.click(screen.getByRole('button', { name: 'scroll' }));
    // Row 5 starts 500px down at the estimated height, and the default header offset is 96px.
    expect(scrollTo).toHaveBeenCalledWith({ top: 404, behavior: 'auto' });
  });
});

describe('useNearEnd', () => {
  type Callback = (entries: { isIntersecting: boolean }[]) => void;
  const instances: { callback: Callback; observed: Element[]; disconnected: boolean }[] = [];

  function stubObserver(): void {
    instances.length = 0;
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        readonly record: (typeof instances)[number];
        constructor(callback: Callback) {
          this.record = { callback, observed: [], disconnected: false };
          instances.push(this.record);
        }
        observe(element: Element): void {
          this.record.observed.push(element);
        }
        disconnect(): void {
          this.record.disconnected = true;
        }
      },
    );
  }

  function EndProbe({ enabled, onNearEnd }: { enabled: boolean; onNearEnd: () => void }) {
    const ref = useNearEnd(enabled, onNearEnd);
    return <div ref={ref} data-testid="end" />;
  }

  it('asks for more when the end of the list comes within reach, and stops when unmounted', () => {
    stubObserver();
    const onNearEnd = vi.fn();
    const { unmount } = render(<EndProbe enabled onNearEnd={onNearEnd} />);
    expect(instances).toHaveLength(1);
    expect(instances[0]?.observed).toEqual([screen.getByTestId('end')]);

    act(() => instances[0]?.callback([{ isIntersecting: false }]));
    expect(onNearEnd).not.toHaveBeenCalled();
    act(() => instances[0]?.callback([{ isIntersecting: true }]));
    expect(onNearEnd).toHaveBeenCalledTimes(1);

    unmount();
    expect(instances[0]?.disconnected).toBe(true);
  });

  it('does nothing while there is nothing more to load', () => {
    stubObserver();
    render(<EndProbe enabled={false} onNearEnd={vi.fn()} />);
    expect(instances).toHaveLength(0);
  });

  it('keeps one observer when the callback changes, and calls the latest callback', () => {
    stubObserver();
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<EndProbe enabled onNearEnd={first} />);
    rerender(<EndProbe enabled onNearEnd={second} />);
    // A new observer reports at once, which repeated a request that had just failed, in a loop; the same one does not.
    expect(instances).toHaveLength(1);
    expect(instances[0]?.disconnected).toBe(false);
    act(() => instances[0]?.callback([{ isIntersecting: true }]));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('builds a new observer only when it is switched off and on again', () => {
    stubObserver();
    const { rerender } = render(<EndProbe enabled onNearEnd={vi.fn()} />);
    rerender(<EndProbe enabled={false} onNearEnd={vi.fn()} />);
    expect(instances[0]?.disconnected).toBe(true);
    rerender(<EndProbe enabled onNearEnd={vi.fn()} />);
    expect(instances).toHaveLength(2);
    expect(instances[1]?.disconnected).toBe(false);
  });

  it('does not fail where IntersectionObserver is missing', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    expect(() => render(<EndProbe enabled onNearEnd={vi.fn()} />)).not.toThrow();
  });
});
