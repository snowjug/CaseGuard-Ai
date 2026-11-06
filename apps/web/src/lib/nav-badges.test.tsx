import { act, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppShell } from '../components/shell/AppShell';
import { caseSummary, session } from '../../test/fixtures';
import { fakeApi, renderApp, type FakeHandlers } from '../../test/harness';
import { navigateTo } from '../../test/next-navigation';
import { demoState, systemHealth } from '../../test/u4-fixtures';
import { ApiError } from './api/errors';
import { caseBadges, demoBadge, systemBadge } from './nav-badges';

describe('[UX-NAV-BADGE-01] the figures on the navigation', () => {
  it('counts cases and sums open warnings with plain-language descriptions', () => {
    const badges = caseBadges(
      [
        caseSummary({ openWarningCount: 2 }),
        caseSummary({ id: 'case_2', openWarningCount: 1 }),
        caseSummary({ id: 'case_3', openWarningCount: 0 }),
      ],
      false,
    );
    expect(badges.cases).toEqual({ text: '3', description: '3 cases', tone: 'neutral' });
    expect(badges.quality).toEqual({
      text: '3',
      description: '3 open warnings across 2 cases',
      tone: 'warning',
    });
  });

  it('uses singular words for one, and says "or more" when the list continues past the first page', () => {
    const one = caseBadges([caseSummary({ openWarningCount: 1 })], false);
    expect(one.cases?.description).toBe('1 case');
    expect(one.quality?.description).toBe('1 open warning across 1 case');
    const more = caseBadges([caseSummary()], true);
    expect(more.cases).toMatchObject({ text: '1+', description: '1 or more cases' });
  });

  it('shows nothing for an empty list or for cases without warnings', () => {
    expect(caseBadges([], false)).toEqual({});
    expect(caseBadges([caseSummary({ openWarningCount: 0 })], false).quality).toBeUndefined();
  });

  it('shows demo progress from the steps the API derived', () => {
    expect(demoBadge(demoState(4))).toEqual({
      text: '4/13',
      description: '4 of 13 demo steps complete',
      tone: 'neutral',
    });
    expect(demoBadge(demoState(0))?.text).toBe('0/13');
    expect(demoBadge({ steps: [] })).toBeNull();
  });

  it('keeps System status quiet while everything is healthy and names every other state', () => {
    expect(systemBadge('healthy')).toBeNull();
    expect(systemBadge('degraded')).toMatchObject({ text: 'Degraded', tone: 'warning' });
    expect(systemBadge('unhealthy')).toMatchObject({ text: 'Down', tone: 'danger' });
    expect(systemBadge('unknown')).toMatchObject({ text: 'Unknown', tone: 'warning' });
  });
});

const READER = ['case:read', 'quality:read', 'telemetry:read'] as const;

function mount(
  handlers: FakeHandlers = {},
  permissions: readonly (typeof READER)[number][] = READER,
) {
  const api = fakeApi({
    'session.me': () => session('manager', permissions),
    'cases.list': () => ({
      items: [
        caseSummary({ openWarningCount: 2 }),
        caseSummary({ id: 'case_2', reference: 'SAMPLE-002', openWarningCount: 1 }),
      ],
      nextCursor: null,
    }),
    'demo.state': () => demoState(4),
    'system.health': () => systemHealth({ status: 'degraded' }),
    'search.global': () => ({ items: [], query: 'x' }),
    ...handlers,
  });
  const view = renderApp(
    <AppShell>
      <h1>Page title</h1>
    </AppShell>,
    { api },
  );
  return { api, ...view };
}

const primaryNav = () => screen.getByRole('navigation', { name: 'Primary' });

// The first render of a file is slow on a busy machine, so wait longer than the 1 s default for the figures.
const navLink = (name: RegExp) =>
  within(primaryNav()).findByRole('link', { name }, { timeout: 8000 });

const requested = (api: { call: { mock: { calls: readonly (readonly unknown[])[] } } }): string[] =>
  api.call.mock.calls.map((call) => String(call[0]));

describe('[UX-NAV-BADGE-02] navigation badges in the shell', () => {
  it('puts the case count, open warnings and system status on their items and reads them out', async () => {
    navigateTo('/');
    mount();
    expect(await navLink(/^Cases.*\(2 cases\)/)).toBeInTheDocument();
    expect(await navLink(/^Quality.*\(3 open warnings across 2 cases\)/)).toBeInTheDocument();
    expect(await navLink(/^Advanced.*\(System status: degraded\)/)).toBeInTheDocument();
    expect(within(primaryNav()).getAllByRole('link')).toHaveLength(5);
  });

  it('does not ask for system health when the role may not read telemetry', async () => {
    navigateTo('/');
    const { api } = mount({}, ['case:read', 'quality:read']);
    await navLink(/^Cases.*\(2 cases\)/);
    expect(requested(api)).not.toContain('system.health');
  });

  it('does not poll the guided demo from the shell: only the Advanced page shows its progress', async () => {
    navigateTo('/');
    const { api } = mount();
    await navLink(/^Advanced.*degraded/);
    expect(requested(api)).not.toContain('demo.state');
  });

  it('does not ask for the case list when the role may not read cases', async () => {
    navigateTo('/');
    const { api } = mount({}, ['telemetry:read']);
    await navLink(/^Advanced.*degraded/);
    expect(requested(api)).toContain('system.health');
    expect(requested(api)).not.toContain('cases.list');
  });

  it('stays quiet (no badge, no error) while a figure fails to load', async () => {
    navigateTo('/');
    mount({
      'system.health': () => {
        throw new ApiError({ status: 503, code: 'unavailable', title: 'Down', message: 'down' });
      },
    });
    await navLink(/^Cases.*\(2 cases\)/);
    expect(within(primaryNav()).getByRole('link', { name: /^Advanced$/ })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('is silent for a healthy system', async () => {
    navigateTo('/');
    mount({ 'system.health': () => systemHealth() });
    await navLink(/^Cases.*\(2 cases\)/);
    expect(within(primaryNav()).getByRole('link', { name: /^Advanced$/ })).toBeInTheDocument();
  });

  it('shows no count when there are no cases yet', async () => {
    navigateTo('/');
    mount({ 'cases.list': () => ({ items: [], nextCursor: null }) });
    await navLink(/^Advanced.*degraded/);
    expect(within(primaryNav()).queryByRole('link', { name: /^Cases.*\(\d+ cases?\)/ })).toBeNull();
    expect(within(primaryNav()).getByRole('link', { name: /^Cases$/ })).toBeInTheDocument();
  });
});

describe('[UX-NAV-BADGE-03] re-reading the figures', () => {
  function showTab(state: 'visible' | 'hidden'): void {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
  }

  it('re-reads system health once a minute while the tab is visible, and not while it is hidden', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      navigateTo('/');
      const { api } = mount();
      await navLink(/^Advanced.*degraded/);
      const polled = () => requested(api).filter((route) => route === 'system.health').length;
      const first = polled();
      expect(first).toBeGreaterThanOrEqual(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(polled()).toBe(first + 1);

      showTab('hidden');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5 * 60_000);
      });
      expect(polled()).toBe(first + 1);

      showTab('visible');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(polled()).toBe(first + 2);
    } finally {
      Reflect.deleteProperty(document, 'visibilityState');
      vi.useRealTimers();
    }
  });
});
