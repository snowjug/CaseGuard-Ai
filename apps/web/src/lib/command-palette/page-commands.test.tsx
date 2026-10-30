import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { caseSummary, session } from '../../../test/fixtures';
import { fakeApi, renderApp } from '../../../test/harness';
import { navigateTo, router } from '../../../test/next-navigation';
import { GOVERNANCE_TAB_IDS } from '../../features/governance/tabs';
import { NAV_ITEMS } from '../nav';
import { ShellUiProvider } from '../shell-ui';
import { CommandPalette } from './CommandPalette';
import { buildPageCommands } from './commands';

describe('[UX-PALETTE-03] entries for pages and sections', () => {
  it('has unique ids, never a "Go to" prefix, and only real Governance sections', () => {
    const navigate = vi.fn();
    const commands = buildPageCommands({ context: { pathCaseId: null, caseId: null }, navigate });
    expect(new Set(commands.map((command) => command.id)).size).toBe(commands.length);
    for (const command of commands) expect(command.label.startsWith('Go to')).toBe(false);
    const sections = commands
      .map((command) => /^\/governance\?tab=(.+)$/.exec(command.hint ?? '')?.[1])
      .filter((tab): tab is string => tab !== undefined);
    expect(sections.length).toBeGreaterThanOrEqual(6);
    for (const tab of sections) expect(GOVERNANCE_TAB_IDS).toContain(tab);
  });

  it('opens the active case overview only when a case is active', () => {
    const navigate = vi.fn();
    const without = buildPageCommands({ context: { pathCaseId: null, caseId: null }, navigate });
    expect(without.some((command) => command.id === 'page:case-overview')).toBe(false);
    const withCase = buildPageCommands({
      context: { pathCaseId: null, caseId: 'case_1' },
      navigate,
    });
    withCase.find((command) => command.id === 'page:case-overview')?.run();
    expect(navigate).toHaveBeenCalledWith('/cases/case_1');
  });
});

function mount() {
  navigateTo('/');
  return renderApp(
    <ShellUiProvider>
      <CommandPalette />
    </ShellUiProvider>,
    {
      api: fakeApi({
        'session.me': () => session('administrator'),
        'cases.list': () => ({ items: [caseSummary()], nextCursor: null }),
        'dev.personas': () => ({ enabled: true, notice: 'Synthetic personas', items: [] }),
      }),
    },
  );
}

async function search(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.keyboard('{Control>}k{/Control}');
  const input = await screen.findByRole('combobox', { name: 'Search commands' });
  await user.type(input, text);
  return within(screen.getByRole('listbox', { name: 'Commands' }));
}

describe('[UX-PALETTE-04] the palette reaches every page', () => {
  it('lists a "Go to" command for each of the 12 destinations', async () => {
    const user = userEvent.setup();
    mount();
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('combobox', { name: 'Search commands' });
    const list = within(screen.getByRole('listbox', { name: 'Commands' }));
    for (const item of NAV_ITEMS)
      expect(
        list.getByRole('option', { name: new RegExp(`Go to ${item.label}`) }),
      ).toBeInTheDocument();
  });

  it('opens a Governance section directly', async () => {
    const user = userEvent.setup();
    mount();
    const list = await search(user, 'Governance: audit log');
    expect(list.getAllByRole('option')[0]).toHaveAccessibleName(/Governance: audit log/);
    await user.keyboard('{Enter}');
    expect(router.push).toHaveBeenCalledWith('/governance?tab=audit');
  });

  it('opens the portfolio analytics, the ingestion wizard and the AI provider', async () => {
    const user = userEvent.setup();
    mount();
    let list = await search(user, 'portfolio analytics');
    expect(list.getAllByRole('option')[0]).toHaveAccessibleName(
      /Quality Review: portfolio analytics/,
    );
    await user.keyboard('{Enter}');
    expect(router.push).toHaveBeenCalledWith('/quality');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull(),
    );

    list = await search(user, 'ingest a new case');
    expect(list.getAllByRole('option')[0]).toHaveAccessibleName(/Ingest a new case/);
    await user.keyboard('{Enter}');
    expect(router.push).toHaveBeenCalledWith('/cases/new');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull(),
    );

    list = await search(user, 'System Health: AI provider');
    expect(list.getAllByRole('option')[0]).toHaveAccessibleName(/System Health: AI provider/);
    await user.keyboard('{Enter}');
    expect(router.push).toHaveBeenCalledWith('/system');
  });
});
