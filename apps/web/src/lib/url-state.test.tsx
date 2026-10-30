import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { navigateTo } from '../../test/next-navigation';
import {
  codecs,
  useAsOfState,
  useCurrentUrl,
  useSelectionState,
  useTabState,
  useUrlState,
  useUrlStates,
  writeUrlState,
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
