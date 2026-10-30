import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { caseSummary, session } from '../../../test/fixtures';
import { expectNoAxeViolations, fakeApi, renderApp } from '../../../test/harness';
import { navigateTo, router } from '../../../test/next-navigation';
import { NAV_ITEMS } from '../../lib/nav';
import { AppShell } from './AppShell';

const demoState = () => ({
  steps: [],
  seededAt: null,
  datasetLabel: '',
  provider: 'deterministic',
  providerSimulated: true,
  caseOneId: null,
  caseTwoId: null,
  skillId: null,
  notices: [],
});

const api = () =>
  fakeApi({
    'session.me': () => session('reviewer', ['case:read', 'quality:read']),
    'cases.list': () => ({
      items: [
        caseSummary(),
        caseSummary({ id: 'case_2', reference: 'SAMPLE-002', title: 'Mailbox migration stalls' }),
      ],
      nextCursor: null,
    }),
    'demo.state': demoState,
    'search.global': () => ({ items: [], query: 'x' }),
  });

function mount() {
  return renderApp(
    <AppShell>
      <h1>Page title</h1>
    </AppShell>,
    { api: api() },
  );
}

describe('[UX-SHELL-01] application shell landmarks', () => {
  it('has a skip link as the first tab stop that targets the focusable main landmark', async () => {
    const user = userEvent.setup();
    mount();
    const skip = screen.getByRole('link', { name: 'Skip to main content' });
    expect(skip).toHaveAttribute('href', '#main-content');
    await user.tab();
    expect(skip).toHaveFocus();
    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main-content');
    expect(main).toHaveAttribute('tabindex', '-1');
    expect(within(main).getByRole('heading', { level: 1, name: 'Page title' })).toBeInTheDocument();
  });

  it('exposes banner, primary navigation, breadcrumbs, search, main and footer landmarks', () => {
    mount();
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toBeInTheDocument();
    expect(screen.getByRole('search')).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
  });

  it('lists all 12 destinations and marks the current page', () => {
    navigateTo('/cases/case_1/timeline');
    mount();
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    const links = within(nav).getAllByRole('link');
    expect(links).toHaveLength(12);
    for (const item of NAV_ITEMS)
      expect(
        within(nav).getByRole('link', { name: new RegExp(`^${item.label}`) }),
      ).toBeInTheDocument();
    const current = within(nav)
      .getAllByRole('link')
      .filter((link) => link.getAttribute('aria-current') === 'page');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent('Case Timeline');
    expect(within(nav).getByRole('link', { name: /Case Timeline/ })).toHaveAttribute(
      'href',
      '/cases/case_1/timeline',
    );
  });

  it('shows the synthetic-data honesty bar, the responsible-use notice and a persistent development-identity badge', () => {
    mount();
    expect(screen.getAllByText('Synthetic demo data').length).toBeGreaterThan(0);
    expect(screen.getByText(/synthetic and for demonstration only/)).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toHaveTextContent(
      /must not be used to rank, rate or discipline individual employees/,
    );
    expect(screen.getAllByText('Development identity').length).toBeGreaterThan(0);
  });

  it('has no accessibility violations', async () => {
    const { container } = mount();
    await expectNoAxeViolations(container);
  });
});

describe('[UX-SHELL-02] header controls', () => {
  it('switches the theme from the header menu and persists it to the cg-theme cookie', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: /Theme:/ }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Dark' }));
    await waitFor(() => expect(document.cookie).toContain('cg-theme=dark'));
    expect(document.documentElement.dataset.cgTheme).toBe('dark');
  });

  it('opens the command palette from the header and with Ctrl+K', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: 'Commands' }));
    expect(await screen.findByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull(),
    );
    await user.keyboard('{Control>}k{/Control}');
    expect(await screen.findByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
  });

  it('shows the persona (role) from session.me in the account menu', async () => {
    const user = userEvent.setup();
    mount();
    const account = await screen.findByRole('button', {
      name: /Ada Reviewer\s*Support Quality Reviewer/,
    });
    await user.click(account);
    expect(await screen.findByText('Tenant: Demo tenant')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Switch persona/ })).toBeInTheDocument();
  });

  it('switches the case on the Command Center by writing ?case= and remembering it', async () => {
    const user = userEvent.setup();
    navigateTo('/');
    mount();
    const select = await screen.findByRole('combobox', { name: 'Active case' });
    await waitFor(() => expect(within(select).getAllByRole('option').length).toBeGreaterThan(2));
    await user.selectOptions(select, 'case_2');
    expect(window.location.search).toBe('?case=case_2');
    expect(document.cookie).toContain('cg-case=case_2');
  });

  it('keeps the current section when switching case inside a case page', async () => {
    const user = userEvent.setup();
    navigateTo('/cases/case_1/evidence');
    mount();
    const select = await screen.findByRole('combobox', { name: 'Active case' });
    await waitFor(() => expect(within(select).getAllByRole('option').length).toBeGreaterThan(2));
    await user.selectOptions(select, 'case_2');
    expect(router.push).toHaveBeenCalledWith('/cases/case_2/evidence');
  });

  it('opens the navigation drawer from the menu button (visible on narrow screens)', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation', hidden: true }));
    const drawer = await screen.findByRole('dialog', { name: 'Navigation' });
    expect(within(drawer).getAllByRole('link')).toHaveLength(12);
  });
});

describe('[UX-SHELL-03] keyboard shortcuts', () => {
  it('g then c goes to Cases, ? lists the shortcuts and / focuses the search box', async () => {
    const user = userEvent.setup();
    mount();
    await user.keyboard('gc');
    expect(router.push).toHaveBeenCalledWith('/cases');

    await user.keyboard('?');
    const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(within(dialog).getByText('Go to Cases')).toBeInTheDocument();
    expect(within(dialog).getByText('G then C')).toBeInTheDocument();
    expect(within(dialog).getByText('Ctrl+K')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull(),
    );

    await user.keyboard('/');
    expect(screen.getByRole('combobox', { name: /Search cases/ })).toHaveFocus();
  });
});

describe('[UX-SHELL-04] presentation mode', () => {
  it('?present=1 shows the presenter strip, hides development controls and offers an exit', async () => {
    const user = userEvent.setup();
    navigateTo('/?present=1');
    mount();
    expect(await screen.findByRole('region', { name: 'Presenter strip' })).toBeInTheDocument();
    expect(screen.queryByText('Development identity')).toBeNull();
    expect(document.documentElement.dataset.cgPresent).toBe('true');
    await user.click(screen.getByRole('button', { name: 'Exit presentation' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Presenter strip' })).toBeNull(),
    );
    expect(window.sessionStorage.getItem('cg-present')).toBeNull();
  });
});
