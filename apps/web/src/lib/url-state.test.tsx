import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { navigateTo, setNavigationLatency } from '../../test/next-navigation';
import { boundedString } from './url-codecs';
import {
  codecs,
  useAsOfState,
  useCurrentUrl,
  useSelectionState,
  useTabState,
  useUrlState,
  useUrlStates,
  useUrlTextState,
  writeUrlState,
  type UrlCodec,
} from './url-state';

describe('[UX-URL-01] URL codecs never throw on hostile input', () => {
  it('falls back to the default for malformed values', () => {
    expect(codecs.integer({ fallback: 1, min: 1, max: 50 }).parse('abc')).toBe(1);
    expect(codecs.integer({ fallback: 1, min: 1, max: 50 }).parse('9999')).toBe(50);
    expect(codecs.integer({ fallback: 1, min: 1, max: 50 }).parse('-4')).toBe(1);
    expect(codecs.enumOf(['a', 'b'] as const, 'a').parse('zzz')).toBe('a');
    expect(codecs.isoTimestamp().parse('yesterday')).toBeNull();
    expect(codecs.isoTimestamp().parse('2025-02-30T00:00:00Z')).toBeNull();
    expect(codecs.isoTimestamp().parse('2025-03-14T09:00:00Z')).toBe('2025-03-14T09:00:00Z');
    expect(codecs.stringList().parse(' a, ,b ,')).toEqual(['a', 'b']);
    expect(codecs.boolean().parse('2')).toBe(false);
  });

  it('omits defaults so URLs stay canonical', () => {
    expect(codecs.string().serialize('')).toBeNull();
    expect(codecs.enumOf(['a', 'b'] as const, 'a').serialize('a')).toBeNull();
    expect(codecs.enumOf(['a', 'b'] as const, 'a').serialize('b')).toBe('b');
    expect(codecs.stringList().serialize([])).toBeNull();
    expect(codecs.integer({ fallback: 1 }).serialize(1)).toBeNull();
  });
});

describe('[UX-URL-02] useUrlState', () => {
  it('reads the value from the URL and updates it without a navigation', () => {
    navigateTo('/cases/case_1/timeline?status=open');
    const codec = codecs.enumOf(['all', 'open'] as const, 'all');
    const { result } = renderHook(() => useUrlState('status', codec));
    expect(result.current[0]).toBe('open');
    act(() => result.current[1]('all'));
    expect(result.current[0]).toBe('all');
    expect(window.location.search).toBe('');
    expect(window.location.pathname).toBe('/cases/case_1/timeline');
  });

  it('accepts an updater function and keeps unrelated parameters', () => {
    navigateTo('/x?page=2&keep=1');
    const codec = codecs.integer({ fallback: 1 });
    const { result } = renderHook(() => useUrlState('page', codec));
    act(() => result.current[1]((previous) => previous + 1));
    expect(new URLSearchParams(window.location.search).get('page')).toBe('3');
    expect(new URLSearchParams(window.location.search).get('keep')).toBe('1');
  });

  it('can push a history entry (tabs, selection) instead of replacing it', () => {
    navigateTo('/x');
    const before = window.history.length;
    const { result } = renderHook(() => useSelectionState());
    act(() => result.current[1]('node_7'));
    expect(window.history.length).toBe(before + 1);
    expect(result.current[0]).toBe('node_7');
    act(() => result.current[1](null));
    expect(result.current[0]).toBeNull();
    expect(window.location.search).toBe('');
  });
});

describe('[UX-URL-03] useUrlStates changes several parameters in one history operation', () => {
  it('applies a patch atomically', () => {
    navigateTo('/x?status=open&page=4');
    const schema = {
      status: codecs.enumOf(['all', 'open', 'closed'] as const, 'all'),
      page: codecs.integer({ fallback: 1 }),
    };
    const { result } = renderHook(() => useUrlStates(schema));
    expect(result.current[0]).toEqual({ status: 'open', page: 4 });
    act(() => result.current[1]({ status: 'closed', page: 1 }));
    expect(result.current[0]).toEqual({ status: 'closed', page: 1 });
    expect(window.location.search).toBe('?status=closed');
  });
});

describe('asOf, tab and shareable URL helpers', () => {
  it('asOf accepts only a UTC instant', () => {
    navigateTo('/x?asOf=nonsense');
    const { result } = renderHook(() => useAsOfState());
    expect(result.current[0]).toBeNull();
    act(() => result.current[1]('2025-03-14T09:00:00Z'));
    expect(result.current[0]).toBe('2025-03-14T09:00:00Z');
    expect(window.location.search).toBe('?asOf=2025-03-14T09%3A00%3A00Z');
  });

  it('tab state is restricted to the known tabs', () => {
    navigateTo('/x?tab=hacked');
    const tabs = ['overview', 'events'] as const;
    const { result } = renderHook(() => useTabState(tabs, 'overview'));
    expect(result.current[0]).toBe('overview');
    act(() => result.current[1]('events'));
    expect(result.current[0]).toBe('events');
  });

  it('useCurrentUrl reflects path and query for share links', () => {
    navigateTo('/cases/c1/evidence?sel=claim_9');
    const { result } = renderHook(() => useCurrentUrl());
    expect(result.current).toBe('/cases/c1/evidence?sel=claim_9');
  });

  it('writeUrlState removes a key when the value is null and preserves the hash', () => {
    navigateTo('/x?a=1&b=2#section');
    writeUrlState({ a: null, c: '3' });
    expect(window.location.search).toBe('?b=2&c=3');
    expect(window.location.hash).toBe('#section');
  });
});

const TEXT = codecs.string();
const SHORT = boundedString(5);
const readQ = (): string | null => new URLSearchParams(window.location.search).get('q');

function Box({ delayMs, codec = TEXT }: { delayMs?: number; codec?: UrlCodec<string> }) {
  const field = useUrlTextState('q', codec, { delayMs });
  return (
    <>
      <input aria-label="Search" {...field.inputProps} />
      <p data-testid="committed">{field.value}</p>
      <button type="button" onClick={() => field.set('')}>
        Clear
      </button>
    </>
  );
}

const searchBox = (): HTMLInputElement => screen.getByRole('textbox', { name: 'Search' });
const committed = (): string | null => screen.getByTestId('committed').textContent;

/** Types like a person who never pauses: each character lands on whatever the field shows at that moment. */
function typeFast(input: HTMLInputElement, text: string, seen?: (shown: string) => void): void {
  for (const char of text) {
    fireEvent.change(input, { target: { value: input.value + char } });
    seen?.(input.value);
  }
}

let replace: MockInstance | undefined;
function spyOnWrites(): MockInstance {
  replace = vi.spyOn(window.history, 'replaceState');
  return replace;
}
afterEach(() => {
  replace?.mockRestore();
  replace = undefined;
});

describe('[UX-URL-04] text typed into a field whose value lives in the URL', () => {
  it('the test router reports a written URL late, as the App Router does', () => {
    navigateTo('/x');
    setNavigationLatency(5);
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useUrlState('q', TEXT));
      act(() => result.current[1]('a'));
      expect(window.location.search).toBe('?q=a');
      expect(result.current[0]).toBe('');
      act(() => {
        vi.advanceTimersByTime(5);
      });
      expect(result.current[0]).toBe('a');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps every character typed with no pause while the router reports each write late', async () => {
    navigateTo('/x?keep=1');
    setNavigationLatency(5);
    const writes = spyOnWrites();
    const user = userEvent.setup({ delay: null });
    render(<Box />);
    const input = searchBox();
    await user.click(input);
    for (const [index, char] of [...'xyz'].entries()) {
      await user.keyboard(char);
      expect(input).toHaveValue('xyz'.slice(0, index + 1));
    }
    await waitFor(() => expect(window.location.search).toBe('?keep=1&q=xyz'));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(input).toHaveValue('xyz');
    expect(writes).toHaveBeenCalledTimes(1);
  });

  it('follows the URL when it changes for another reason: a link, Back and Forward, a write elsewhere', async () => {
    navigateTo('/x?q=proxy');
    render(<Box />);
    const input = searchBox();
    expect(input).toHaveValue('proxy');
    act(() => navigateTo('/x?q=dns'));
    expect(input).toHaveValue('dns');
    act(() => writeUrlState({ q: null }));
    expect(input).toHaveValue('');
    act(() => window.history.pushState(null, '', '/x?q=one'));
    act(() => window.history.pushState(null, '', '/x?q=two'));
    expect(input).toHaveValue('two');
    act(() => window.history.back());
    await waitFor(() => expect(input).toHaveValue('one'));
    act(() => window.history.forward());
    await waitFor(() => expect(input).toHaveValue('two'));
  });

  describe('timing', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });
    const advance = (ms: number): void => {
      act(() => {
        vi.advanceTimersByTime(ms);
      });
    };

    it('writes the URL once, when typing pauses, and shows what was typed after every key', () => {
      navigateTo('/x');
      setNavigationLatency(5);
      const writes = spyOnWrites();
      render(<Box />);
      const input = searchBox();
      const shown: string[] = [];
      typeFast(input, 'xyz', (value) => shown.push(value));
      expect(shown).toEqual(['x', 'xy', 'xyz']);
      advance(249);
      expect(writes).not.toHaveBeenCalled();
      advance(1);
      expect(window.location.search).toBe('?q=xyz');
      advance(100);
      expect(input).toHaveValue('xyz');
      expect(writes).toHaveBeenCalledTimes(1);
    });

    it('is not overwritten by the late report of an earlier write', () => {
      navigateTo('/x');
      setNavigationLatency(60);
      render(<Box delayMs={10} />);
      const input = searchBox();
      typeFast(input, 'a');
      advance(10);
      expect(readQ()).toBe('a');
      typeFast(input, 'b');
      advance(10);
      expect(readQ()).toBe('ab');
      advance(50);
      expect(input).toHaveValue('ab');
      advance(60);
      expect(input).toHaveValue('ab');
    });

    it('keeps text that is waiting to be written when the URL changes for another reason', () => {
      navigateTo('/x');
      render(<Box />);
      const input = searchBox();
      typeFast(input, 'abc');
      act(() => navigateTo('/x?q=zzz'));
      expect(input).toHaveValue('abc');
      advance(250);
      expect(readQ()).toBe('abc');
      act(() => navigateTo('/x?q=later'));
      expect(input).toHaveValue('later');
    });

    it('writes nothing, and searches for nothing, while an IME composition is in progress', () => {
      navigateTo('/x');
      render(<Box />);
      const input = searchBox();
      fireEvent.compositionStart(input);
      fireEvent.change(input, { target: { value: 'ni' } });
      fireEvent.change(input, { target: { value: 'nih' } });
      expect(input).toHaveValue('nih');
      expect(committed()).toBe('');
      advance(1000);
      expect(window.location.search).toBe('');
      // Enter that confirms a candidate is not a request to search.
      fireEvent.keyDown(input, { key: 'Enter' });
      fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
      expect(window.location.search).toBe('');
      fireEvent.change(input, { target: { value: '你好' } });
      fireEvent.compositionEnd(input);
      expect(committed()).toBe('你好');
      expect(window.location.search).toBe('');
      advance(250);
      expect(readQ()).toBe('你好');
    });

    it('writes at once on Enter and when the field loses focus', () => {
      navigateTo('/x');
      render(<Box />);
      const input = searchBox();
      typeFast(input, 'abc');
      expect(readQ()).toBeNull();
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(readQ()).toBe('abc');
      typeFast(input, 'd');
      expect(readQ()).toBe('abc');
      fireEvent.blur(input);
      expect(readQ()).toBe('abcd');
    });

    it('set replaces the text and the URL together and cancels a write that was waiting', () => {
      navigateTo('/x?q=proxy&keep=1');
      setNavigationLatency(5);
      render(<Box />);
      const input = searchBox();
      expect(input).toHaveValue('proxy');
      typeFast(input, 'abc');
      fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
      expect(input).toHaveValue('');
      expect(window.location.search).toBe('?keep=1');
      advance(1000);
      expect(input).toHaveValue('');
      expect(window.location.search).toBe('?keep=1');
    });

    it('writes nothing after the page is gone', () => {
      navigateTo('/x');
      const { unmount } = render(<Box />);
      typeFast(searchBox(), 'abc');
      unmount();
      navigateTo('/other');
      advance(1000);
      expect(window.location.pathname + window.location.search).toBe('/other');
    });

    it('writes only when the URL would change', () => {
      navigateTo('/x');
      const writes = spyOnWrites();
      render(<Box />);
      const input = searchBox();
      typeFast(input, 'x');
      fireEvent.change(input, { target: { value: '' } });
      advance(1000);
      expect(writes).not.toHaveBeenCalled();
      expect(window.location.search).toBe('');
    });

    it('writes at every change when the delay is 0 (a date that is complete when it changes)', () => {
      navigateTo('/x');
      setNavigationLatency(5);
      render(<Box delayMs={0} />);
      const input = searchBox();
      typeFast(input, 'a');
      expect(readQ()).toBe('a');
      typeFast(input, 'b');
      expect(readQ()).toBe('ab');
      advance(100);
      expect(input).toHaveValue('ab');
    });

    it('keeps the text in the form the codec gives it: bounded, and never cut inside an emoji', () => {
      navigateTo('/x');
      render(<Box codec={SHORT} />);
      const input = searchBox();
      fireEvent.change(input, { target: { value: '123456789' } });
      expect(input).toHaveValue('12345');
      fireEvent.change(input, { target: { value: 'ab😀😀' } });
      expect(input).toHaveValue('ab😀');
      advance(250);
      expect(readQ()).toBe('ab😀');
    });
  });
});
