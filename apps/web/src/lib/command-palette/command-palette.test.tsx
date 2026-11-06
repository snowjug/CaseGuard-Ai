import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { caseSummary, persona, session } from '../../../test/fixtures';
import { fakeApi, renderApp, type FakeHandlers } from '../../../test/harness';
import { navigateTo, router } from '../../../test/next-navigation';
import { ShellUiProvider } from '../shell-ui';
import { CommandPalette } from './CommandPalette';
import { fuzzyMatch, rankByQuery } from './fuzzy';
import { groupResults } from './use-palette-search';

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

  it('drops scattered matches, so a short query does not match nearly every command', () => {
    const items = [
      { label: 'Settings and audit: reviewer decisions' },
      { label: 'DNS failures' },
      { label: 'Add a case', keywords: 'upload paste import' },
    ];
    expect(rankByQuery('dns', items).map((r) => r.item.label)).toEqual(['DNS failures']);
    // A compact subsequence still counts: a typo-free abbreviation of a word.
    expect(rankByQuery('addcase', items).map((r) => r.item.label)).toEqual(['Add a case']);
  });
});

const api = (overrides: FakeHandlers = {}) =>
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
    'search.global': () => ({ items: [], query: 'x' }),
    ...overrides,
  });

function mount(overrides: FakeHandlers = {}) {
  return renderApp(
    <ShellUiProvider>
      <CommandPalette />
    </ShellUiProvider>,
    { api: api(overrides) },
  );
}

async function openPalette(user: ReturnType<typeof userEvent.setup>) {
  await user.keyboard('{Control>}k{/Control}');
  return screen.findByRole('combobox', { name: 'Search commands' });
}

const options = () =>
  within(screen.getByRole('listbox', { name: 'Commands and search results' })).getAllByRole(
    'option',
  );

describe('[UX-PALETTE-02] command palette keyboard flow', () => {
  it('opens with Ctrl+K and lists a short grouped list', async () => {
    const user = userEvent.setup();
    mount();
    await openPalette(user);
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
    const list = within(screen.getByRole('listbox', { name: 'Commands and search results' }));
    expect(list.getByRole('option', { name: /Add a case/ })).toBeInTheDocument();
    expect(list.getByRole('option', { name: /Try a sample case/ })).toBeInTheDocument();
    expect(list.getByRole('option', { name: /Go to Home/ })).toBeInTheDocument();
    for (const group of ['Actions', 'Go to', 'Preferences', 'Advanced'])
      expect(list.getByRole('group', { name: group })).toBeInTheDocument();
    // The short list leaves out what only a search should find: sections of Settings and audit, personas.
    expect(list.queryByRole('option', { name: /Settings and audit: audit log/ })).toBeNull();
    expect(list.queryByRole('option', { name: /Switch persona to/ })).toBeNull();
  });

  it('filters as you type, moves with the arrow keys and runs the active command with Enter', async () => {
    const user = userEvent.setup();
    mount();
    const input = await openPalette(user);
    await user.type(input, 'go to cases');
    await waitFor(() => expect(options()[0]).toHaveAccessibleName(/Go to Cases/));
    const list = options();
    await waitFor(() => expect(input).toHaveAttribute('aria-activedescendant', list[0]?.id));
    await user.keyboard('{ArrowDown}');
    await waitFor(() => expect(input).toHaveAttribute('aria-activedescendant', list[1]?.id));
    await user.keyboard('{ArrowUp}');
    await waitFor(() => expect(input).toHaveAttribute('aria-activedescendant', list[0]?.id));
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
    await waitFor(() => expect(options().length).toBeGreaterThan(3));
    const list = options();
    await waitFor(() => expect(input).toHaveAttribute('aria-activedescendant', list[0]?.id));
    await user.keyboard('{ArrowUp}');
    await waitFor(() => expect(input).toHaveAttribute('aria-activedescendant', list.at(-1)?.id));
    await user.keyboard('{ArrowDown}');
    await waitFor(() => expect(input).toHaveAttribute('aria-activedescendant', list[0]?.id));
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
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('No results for “qqqqqq”.'),
    );
    await user.keyboard('{Enter}');
    expect(router.push).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
  });

  it('switches the theme and remembers it in the cg-theme cookie', async () => {
    const user = userEvent.setup();
    mount();
    const input = await openPalette(user);
    await user.type(input, 'dark theme');
    await waitFor(() => expect(options()[0]).toHaveAccessibleName(/Switch to dark theme/));
    await user.keyboard('{Enter}');
    await waitFor(() => expect(document.cookie).toContain('cg-theme=dark'));
  });

  it('lists the cases from cases.list and opens the chosen one on its review', async () => {
    const user = userEvent.setup();
    mount();
    const input = await openPalette(user);
    await user.type(input, 'SAMPLE-002');
    expect(await screen.findByRole('option', { name: /Open SAMPLE-002/ })).toBeInTheDocument();
    await waitFor(() => expect(options()[0]).toHaveAccessibleName(/Open SAMPLE-002/));
    await user.keyboard('{Enter}');
    expect(router.push).toHaveBeenCalledWith('/cases/case_2/review');
    expect(document.cookie).toContain('cg-case=case_2');
  });

  it('keeps the open section when another case is chosen on a case page', async () => {
    const user = userEvent.setup();
    navigateTo('/cases/case_1/evidence');
    mount();
    const input = await openPalette(user);
    await user.type(input, 'SAMPLE-002');
    await waitFor(() => expect(options()[0]).toHaveAccessibleName(/Open SAMPLE-002/));
    await user.keyboard('{Enter}');
    expect(router.push).toHaveBeenCalledWith('/cases/case_2/evidence');
  });

  it('says to add a case, not to choose one, on the case destinations when there are no cases yet', async () => {
    const user = userEvent.setup();
    mount({ 'cases.list': () => ({ items: [], nextCursor: null }) });
    const input = await openPalette(user);
    await user.type(input, 'go to timeline');
    expect(
      await screen.findByRole('option', { name: /Go to Timeline\s*Go to · add a case first/ }),
    ).toBeInTheDocument();
  });

  it('offers development personas and switches the identity (sent as x-cg-persona)', async () => {
    const user = userEvent.setup();
    mount();
    const input = await openPalette(user);
    await user.type(input, 'Rae Reviewer');
    await screen.findByRole('option', { name: /Switch persona to Rae Reviewer/ });
    await waitFor(() => expect(options()[0]).toHaveAccessibleName(/Rae Reviewer/));
    await user.keyboard('{Enter}');
    await waitFor(() => expect(window.localStorage.getItem('cg-persona')).toBe('persona_reviewer'));
  });

  it('toggles presentation mode', async () => {
    const user = userEvent.setup();
    mount();
    const input = await openPalette(user);
    await user.type(input, 'presentation');
    await waitFor(() => expect(options()[0]).toHaveAccessibleName(/presentation mode/));
    await user.keyboard('{Enter}');
    await waitFor(() => expect(window.sessionStorage.getItem('cg-present')).toBe('1'));
  });

  it('runs a command when its row is clicked', async () => {
    const user = userEvent.setup();
    mount();
    await openPalette(user);
    await act(async () => {
      await user.click(await screen.findByRole('option', { name: /Go to Settings and audit/ }));
    });
    expect(router.push).toHaveBeenCalledWith('/governance');
  });

  it('starts a new case or the sample case', async () => {
    const user = userEvent.setup();
    mount();
    let input = await openPalette(user);
    await user.type(input, 'add a case');
    await waitFor(() => expect(options()[0]).toHaveAccessibleName(/Add a case/));
    await user.keyboard('{Enter}');
    expect(router.push).toHaveBeenCalledWith('/cases/new');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull(),
    );
    input = await openPalette(user);
    await user.type(input, 'sample case');
    await waitFor(() => expect(options()[0]).toHaveAccessibleName(/Try a sample case/));
    await user.keyboard('{Enter}');
    expect(router.push).toHaveBeenLastCalledWith('/cases/new?mode=sample');
  });
});

describe('[UX-PALETTE-05] search results in the palette', () => {
  const results = () => ({
    query: 'dns',
    items: [
      {
        type: 'case' as const,
        id: 'case_9',
        caseId: 'case_9',
        title: 'DNS failures after the failover',
        snippet: 'Resolver timeouts across two zones',
        href: '/cases/case_9/review',
        score: 3,
      },
      {
        type: 'skill' as const,
        id: 'skill_4',
        caseId: null,
        title: 'Check the resolver chain',
        snippet: '',
        href: '/skills/skill_4',
        score: 2,
      },
      {
        type: 'claim' as const,
        id: 'claim_7',
        caseId: 'case_9',
        title: 'Phishing link',
        snippet: 'Leaves the app',
        href: 'https://evil.example/claim',
        score: 1,
      },
    ],
  });

  it('searches from two characters on, groups the results and opens one on Enter or click', async () => {
    const user = userEvent.setup();
    const search = vi.fn(() => results());
    mount({ 'search.global': search });
    const input = await openPalette(user);
    await user.type(input, 'd');
    expect(search).not.toHaveBeenCalled();
    await user.type(input, 'ns');
    const list = within(screen.getByRole('listbox', { name: 'Commands and search results' }));
    const found = await list.findByRole('option', { name: /DNS failures after the failover/ });
    expect(found).toHaveTextContent('Resolver timeouts across two zones');
    expect(list.getByRole('group', { name: 'Cases' })).toContainElement(found);
    expect(list.getByRole('group', { name: 'Skills' })).toBeInTheDocument();
    await act(async () => {
      await user.click(found);
    });
    expect(router.push).toHaveBeenCalledWith('/cases/case_9/review');
  });

  it('never offers a result that leaves the app', async () => {
    const user = userEvent.setup();
    mount({ 'search.global': () => results() });
    const input = await openPalette(user);
    await user.type(input, 'dns');
    await screen.findByRole('option', { name: /DNS failures after the failover/ });
    expect(screen.queryByRole('option', { name: /Phishing link/ })).toBeNull();
  });

  it('says why when the search fails, while commands still work', async () => {
    const user = userEvent.setup();
    mount({
      'search.global': () => {
        throw new Error('boom');
      },
    });
    const input = await openPalette(user);
    await user.type(input, 'go to cases');
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Search failed.'));
    expect(screen.getByRole('option', { name: /Go to Cases/ })).toBeInTheDocument();
  });

  it('groups results in a fixed order and drops links that are not app paths', () => {
    const groups = groupResults([
      ...results().items,
      { ...results().items[1], id: 'skill_5', href: '//evil.example' } as never,
    ]);
    expect(groups.map((group) => group.type)).toEqual(['case', 'skill']);
    expect(groups[1]?.items).toHaveLength(1);
  });
});
