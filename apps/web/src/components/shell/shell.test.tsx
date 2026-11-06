import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { caseSummary, session } from '../../../test/fixtures';
import { expectNoAxeViolations, fakeApi, renderApp } from '../../../test/harness';
import { navigateTo, router } from '../../../test/next-navigation';
import { PRIMARY_NAV } from '../../lib/nav';
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

  it('exposes banner, sidebar, primary navigation, main and footer landmarks, and no breadcrumbs on a top-level page', () => {
    navigateTo('/');
    mount();
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Sidebar' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    // The bottom bar is hidden by a media query below the tablet width, which jsdom does not evaluate.
    expect(document.querySelector('nav[aria-label="Primary, mobile"]')).not.toBeNull();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).toBeNull();
  });

  it('shows breadcrumbs only where a page has depth', () => {
    navigateTo('/cases/case_1/timeline');
    mount();
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByRole('link', { name: 'Cases' })).toHaveAttribute('href', '/cases');
    expect(within(crumbs).getByText('case_1')).toHaveAttribute('aria-current', 'page');
  });

  it('lists the five main destinations in the sidebar and the bottom bar and marks the current page', () => {
    navigateTo('/cases/case_1/timeline');
    mount();
    // The bottom bar is hidden by a media query below the tablet width, which jsdom does not evaluate, and the name of
    // a hidden element is empty: it is read from the DOM rather than by role and name.
    const bar = document.querySelector('nav[aria-label="Primary, mobile"]');
    const sidebar = screen.getByRole('navigation', { name: 'Primary' });
    for (const nav of [sidebar, bar]) {
      expect(nav).not.toBeNull();
      const links = Array.from(nav?.querySelectorAll('a') ?? []);
      expect(links.map((link) => link.getAttribute('href'))).toEqual(
        PRIMARY_NAV.map((item) => item.href),
      );
      PRIMARY_NAV.forEach((item, index) => expect(links[index]).toHaveTextContent(item.label));
      const current = links.filter((link) => link.getAttribute('aria-current') === 'page');
      expect(current).toHaveLength(1);
      expect(current[0]).toHaveTextContent('Cases');
    }
  });

  it('keeps Advanced lit on its views', () => {
    navigateTo('/governance');
    mount();
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(nav).getByRole('link', { name: /^Advanced/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('marks the data as demo data in a pill that opens the full sentence, and keeps the responsible-use notice', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: /Demo data: what this means/ }));
    expect(await screen.findByText(/synthetic and for demonstration only/)).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toHaveTextContent(
      /must not be used to rank, rate or discipline individual employees/,
    );
  });

  it('keeps a development-identity badge in the banner, and says so again in the account menu', async () => {
    const user = userEvent.setup();
    mount();
    expect(
      within(screen.getByRole('banner')).getByText('Development identity'),
    ).toBeInTheDocument();
    await user.click(
      await screen.findByRole('button', { name: /Ada Reviewer\s*Support Quality Reviewer/ }),
    );
    expect((await screen.findAllByText('Development identity')).length).toBeGreaterThan(1);
  });

  it('has no accessibility violations', async () => {
    const { container } = mount();
    await expectNoAxeViolations(container);
  });
});

describe('[UX-SHELL-02] top bar controls', () => {
  it('switches the theme from the top bar and persists it to the cg-theme cookie', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: 'Theme: Light' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Dark' }));
    await waitFor(() => expect(document.cookie).toContain('cg-theme=dark'));
    expect(document.documentElement.dataset.cgTheme).toBe('dark');
  });

  it('opens the command palette from the search button and with Ctrl+K', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: 'Search or jump to' }));
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

  it('has no case selector in the chrome: a case is chosen from Cases, the palette or Home', () => {
    mount();
    expect(screen.queryByRole('combobox', { name: 'Active case' })).toBeNull();
  });
});

describe('[UX-SHELL-03] keyboard shortcuts', () => {
  it('g then c goes to Cases, ? lists the shortcuts and / opens the search', async () => {
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
    expect(await screen.findByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Search commands' })).toBeInTheDocument();
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
