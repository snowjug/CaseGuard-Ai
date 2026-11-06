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
  it('has unique ids, never a "Go to" prefix, and only real Settings and audit sections', () => {
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

  it('opens the case details and the report only when a case is active', () => {
    const navigate = vi.fn();
    const without = buildPageCommands({ context: { pathCaseId: null, caseId: null }, navigate });
    expect(without.some((command) => command.id === 'page:case-overview')).toBe(false);
    expect(without.some((command) => command.id === 'page:case-report')).toBe(false);
    const withCase = buildPageCommands({
      context: { pathCaseId: null, caseId: 'case_1' },
      navigate,
    });
    withCase.find((command) => command.id === 'page:case-overview')?.run();
    expect(navigate).toHaveBeenCalledWith('/cases/case_1');
    withCase.find((command) => command.id === 'page:case-report')?.run();
    expect(navigate).toHaveBeenCalledWith('/cases/case_1/report');
  });

  it('starts adding a case, or the sample case, from the Actions group', () => {
    const navigate = vi.fn();
    const commands = buildPageCommands({ context: { pathCaseId: null, caseId: null }, navigate });
    const add = commands.find((command) => command.id === 'page:new-case');
    const sample = commands.find((command) => command.id === 'page:sample-case');
    expect([add?.group, sample?.group]).toEqual(['Actions', 'Actions']);
    add?.run();
    sample?.run();
    expect(navigate.mock.calls).toEqual([['/cases/new'], ['/cases/new?source=sample']]);
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
        'search.global': () => ({ items: [], query: 'x' }),
      }),
    },
  );
}

async function search(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.keyboard('{Control>}k{/Control}');
  const input = await screen.findByRole('combobox', { name: 'Search commands' });
  await user.type(input, text);
  return within(screen.getByRole('listbox', { name: 'Commands and search results' }));
}

describe('[UX-PALETTE-04] the palette reaches every page', () => {
  it('has a "Go to" command for each destination, found by typing its name', async () => {
    const user = userEvent.setup();
    mount();
    await user.keyboard('{Control>}k{/Control}');
    const input = await screen.findByRole('combobox', { name: 'Search commands' });
    const list = within(screen.getByRole('listbox', { name: 'Commands and search results' }));
    for (const item of NAV_ITEMS) {
      await user.clear(input);
      await user.paste(`Go to ${item.label}`);
      expect(
        await list.findByRole('option', { name: new RegExp(`Go to ${item.label}`) }),
      ).toBeInTheDocument();
    }
  });

  it('opens a Settings and audit section directly', async () => {
    const user = userEvent.setup();
    mount();
    const list = await search(user, 'Settings and audit: audit log');
    await waitFor(() =>
      expect(list.getAllByRole('option')[0]).toHaveAccessibleName(/Settings and audit: audit log/),
    );
    await user.keyboard('{Enter}');
    expect(router.push).toHaveBeenCalledWith('/governance?tab=audit');
  });

  it('opens the quality of all cases, the add-a-case page and the AI provider', async () => {
    const user = userEvent.setup();
    mount();
    let list = await search(user, 'Quality across all cases');
    await waitFor(() =>
      expect(list.getAllByRole('option')[0]).toHaveAccessibleName(/Quality across all cases/),
    );
    await user.keyboard('{Enter}');
    expect(router.push).toHaveBeenCalledWith('/quality');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull(),
    );

    list = await search(user, 'Add a case');
    await waitFor(() => expect(list.getAllByRole('option')[0]).toHaveAccessibleName(/Add a case/));
    await user.keyboard('{Enter}');
    expect(router.push).toHaveBeenCalledWith('/cases/new');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull(),
    );

    list = await search(user, 'System status: AI provider');
    await waitFor(() =>
      expect(list.getAllByRole('option')[0]).toHaveAccessibleName(/System status: AI provider/),
    );
    await user.keyboard('{Enter}');
    expect(router.push).toHaveBeenCalledWith('/system');
  });
});
