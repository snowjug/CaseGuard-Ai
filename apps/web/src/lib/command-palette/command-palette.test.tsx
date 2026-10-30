import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { caseSummary, persona, session } from '../../../test/fixtures';
import { fakeApi, renderApp } from '../../../test/harness';
import { router } from '../../../test/next-navigation';
import { ShellUiProvider } from '../shell-ui';
import { CommandPalette } from './CommandPalette';
import { fuzzyMatch, rankByQuery } from './fuzzy';

describe('[UX-PALETTE-01] fuzzy matching', () => {
  it('prefers a contiguous match over a scattered one and reports the matched characters', () => {
    const contiguous = fuzzyMatch('case', 'Go to Cases');
    const scattered = fuzzyMatch('case', 'Counterfactual Lab: simulate everything');
    expect(contiguous?.indices).toEqual([6, 7, 8, 9]);
    expect(scattered).not.toBeNull();
    expect((contiguous?.score ?? 0) > (scattered?.score ?? 0)).toBe(true);
  });

  it('returns null when the query is not a subsequence and keeps order for an empty query', () => {
    expect(fuzzyMatch('zzz', 'Go to Cases')).toBeNull();
    const items = [{ label: 'B' }, { label: 'A' }];
    expect(rankByQuery('', items).map((r) => r.item.label)).toEqual(['B', 'A']);
    expect(rankByQuery('a', items).map((r) => r.item.label)).toEqual(['A']);
  });

  it('matches hidden keywords with a lower weight than the label', () => {
    const items = [
      { label: 'Switch to dark theme', keywords: 'appearance' },
      { label: 'Appearance settings' },
    ];
    expect(rankByQuery('appearance', items)[0]?.item.label).toBe('Appearance settings');
    expect(rankByQuery('appearance', items)).toHaveLength(2);
  });
});

const api = () =>
  fakeApi({
    'session.me': () => session('engineer'),
    'cases.list': () => ({
      items: [
        caseSummary(),
        caseSummary({ id: 'case_2', reference: 'SAMPLE-002', title: 'Mailbox migration stalls' }),
      ],
      nextCursor: null,
    }),
    'dev.personas': () => ({
      enabled: true,
      notice: 'Synthetic personas',
      items: [
        persona('persona_reviewer', 'reviewer', 'Rae Reviewer'),
        persona('persona_engineer', 'engineer', 'Eli Engineer'),
      ],
    }),
  });

function mount() {
  return renderApp(
    <ShellUiProvider>
      <CommandPalette />
    </ShellUiProvider>,
    { api: api() },
  );
}

async function openPalette(user: ReturnType<typeof userEvent.setup>) {
  await user.keyboard('{Control>}k{/Control}');
  return screen.findByRole('combobox', { name: 'Search commands' });
}

describe('[UX-PALETTE-02] command palette keyboard flow', () => {
  it('opens with Ctrl+K, shows the search box and lists commands in groups', async () => {
    const user = userEvent.setup();
    mount();
    await openPalette(user);
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
    const list = screen.getByRole('listbox', { name: 'Commands' });
    expect(within(list).getByRole('option', { name: /Go to Command Center/ })).toBeInTheDocument();
    expect(within(list).getAllByRole('option').length).toBeGreaterThan(12);
    expect(within(list).getByRole('group', { name: 'Navigate' })).toBeInTheDocument();
  });

  it('filters as you type, moves with the arrow keys and runs the active command with Enter', async () => {
    const user = userEvent.setup();
    mount();
    const input = await openPalette(user);
    await user.type(input, 'go to cases');
    const options = within(screen.getByRole('listbox')).getAllByRole('option');
    expect(options[0]).toHaveAccessibleName(/Go to Cases/);
    expect(input).toHaveAttribute('aria-activedescendant', options[0]?.id);
    await user.keyboard('{ArrowDown}');
    expect(input).toHaveAttribute('aria-activedescendant', options[1]?.id);
    await user.keyboard('{ArrowUp}');
    expect(input).toHaveAttribute('aria-activedescendant', options[0]?.id);
    await user.keyboard('{Enter}');
    expect(router.push).toHaveBeenCalledWith('/cases');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull(),
    );
  });

  it('wraps around at both ends of the list', async () => {
    const user = userEvent.setup();
    mount();
    const input = await openPalette(user);
    await user.type(input, 'go to');
    const options = within(screen.getByRole('listbox')).getAllByRole('option');
    await user.keyboard('{ArrowUp}');
    expect(input).toHaveAttribute('aria-activedescendant', options.at(-1)?.id);
    await user.keyboard('{ArrowDown}');
    expect(input).toHaveAttribute('aria-activedescendant', options[0]?.id);
  });

  it('closes with Escape and starts fresh next time', async () => {
    const user = userEvent.setup();
    mount();
    const input = await openPalette(user);
    await user.type(input, 'xyz');
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull(),
    );
    const again = await openPalette(user);
    expect(again).toHaveValue('');
  });

  it('says so when nothing matches and does nothing on Enter', async () => {
    const user = userEvent.setup();
    mount();
    const input = await openPalette(user);
    await user.type(input, 'qqqqqq');
    expect(screen.getByRole('status')).toHaveTextContent('No commands match');
    await user.keyboard('{Enter}');
    expect(router.push).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
  });

  it('switches the theme and remembers it in the cg-theme cookie', async () => {
    const user = userEvent.setup();
    mount();
    const input = await openPalette(user);
    await user.type(input, 'dark theme');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(document.cookie).toContain('cg-theme=dark'));
  });

  it('lists the cases from cases.list and opens the chosen one', async () => {
    const user = userEvent.setup();
    mount();
    const input = await openPalette(user);
    await user.type(input, 'SAMPLE-002');
    const option = await screen.findByRole('option', { name: /Switch to SAMPLE-002/ });
    expect(option).toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(router.push).toHaveBeenCalledWith('/cases/case_2');
    expect(document.cookie).toContain('cg-case=case_2');
  });

  it('offers development personas and switches the identity (sent as x-cg-persona)', async () => {
    const user = userEvent.setup();
    mount();
    const input = await openPalette(user);
    await user.type(input, 'Rae Reviewer');
    await screen.findByRole('option', { name: /Switch persona to Rae Reviewer/ });
    await user.keyboard('{Enter}');
    await waitFor(() => expect(window.localStorage.getItem('cg-persona')).toBe('persona_reviewer'));
  });

  it('toggles presentation mode', async () => {
    const user = userEvent.setup();
    mount();
    const input = await openPalette(user);
    await user.type(input, 'presentation');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(window.sessionStorage.getItem('cg-present')).toBe('1'));
  });

  it('runs a command when its row is clicked', async () => {
    const user = userEvent.setup();
    mount();
    await openPalette(user);
    await act(async () => {
      await user.click(screen.getByRole('option', { name: /Go to Governance/ }));
    });
    expect(router.push).toHaveBeenCalledWith('/governance');
  });
});
