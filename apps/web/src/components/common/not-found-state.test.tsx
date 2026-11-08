import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { session } from '../../../test/fixtures';
import { expectNoAxeViolations, fakeApi, renderApp } from '../../../test/harness';
import { demoState } from '../../../test/u4-fixtures';
import { AppShell } from '../shell/AppShell';
import { NotFoundState } from './NotFoundState';

function mount() {
  return renderApp(
    <AppShell>
      <NotFoundState />
    </AppShell>,
    {
      api: fakeApi({
        'session.me': () => session('engineer', ['case:read']),
        'cases.list': () => ({ items: [], nextCursor: null }),
        'demo.state': () => demoState(0),
        'search.global': () => ({ items: [], query: 'x' }),
      }),
    },
  );
}

describe('[UX-404-01] page not found', () => {
  it('says what happened, why a link can stop working after a demo reset, and offers four ways forward', () => {
    mount();
    const main = within(screen.getByRole('main'));
    expect(
      main.getByRole('heading', { level: 1, name: "We couldn't find that page" }),
    ).toBeInTheDocument();
    expect(
      main.getByText(/Resetting the demo data removes the demo cases and skills/),
    ).toBeInTheDocument();
    expect(main.getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/');
    expect(main.getByRole('link', { name: 'Browse cases' })).toHaveAttribute('href', '/cases');
    expect(main.getByRole('link', { name: 'Guided demo' })).toHaveAttribute('href', '/demo');
    expect(main.getByRole('button', { name: 'Search' })).toBeInTheDocument();
  });

  it('opens the search from the Search button', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(within(screen.getByRole('main')).getByRole('button', { name: 'Search' }));
    expect(await screen.findByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Search commands' })).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = mount();
    await expectNoAxeViolations(container);
  });
});
