import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, caseSummary, persona, session } from '../../../test/fixtures';
import {
  expectNoAxeViolations,
  fakeApi,
  renderApp,
  type FakeHandlers,
} from '../../../test/harness';
import { navigateTo, router } from '../../../test/next-navigation';
import { COMPARE_ROUTE, demoState, systemHealth } from '../../../test/u4-fixtures';
import { expectToast } from '../../../test/u4-support';
import { ApiError } from '../../lib/api/errors';
import { AppShell } from './AppShell';
import { PRESENTER_HEIGHT_VAR, PresenterStrip } from './PresenterStrip';

const admin = () => session('administrator', ALL_PERMISSIONS);

function api(overrides: FakeHandlers = {}) {
  return fakeApi({
    'session.me': admin,
    'demo.state': () => demoState(3),
    'dev.personas': () => ({
      enabled: true,
      notice: '',
      items: [
        { ...persona('user_fabi', 'engineer', 'Fabi Engineer'), tenantId: 'tenant_other' },
        persona('user_ava_engineer', 'engineer', 'Ava Engineer'),
        persona('user_alex_admin', 'administrator', 'Alex Admin'),
      ],
    }),
    ...overrides,
  });
}

const strip = () => screen.findByRole('region', { name: 'Presenter strip' });

describe('[FR-PRES-01] presenter strip', () => {
  it('shows nothing until presentation mode is on', async () => {
    renderApp(<PresenterStrip />, { api: api() });
    expect(screen.queryByRole('region', { name: 'Presenter strip' })).toBeNull();
  });

  it('shows progress, the next step with the role to present as, and outlines the next action', async () => {
    navigateTo('/?present=1');
    renderApp(<PresenterStrip />, { api: api() });
    const region = await strip();
    expect(await within(region).findByText('Demo guide · 3 of 13 done')).toBeInTheDocument();
    expect(
      within(region).getByRole('progressbar', { name: 'Demo progress: 3 of 13 steps complete' }),
    ).toBeInTheDocument();
    expect(within(region).getByText(/Next: Competing hypotheses shown/)).toBeInTheDocument();
    expect(within(region).getByText(/present as Technical Support Engineer/)).toBeInTheDocument();
    const action = within(region).getByRole('link', { name: 'Open Competing hypotheses shown' });
    expect(action).toHaveAttribute('href', '/cases/case_1/hypotheses');
    expect(action).toHaveClass('cg-presenter-target');
  });

  it('shows concise presenter notes on request', async () => {
    const user = userEvent.setup();
    navigateTo('/?present=1');
    renderApp(<PresenterStrip />, { api: api() });
    const region = await strip();
    await user.click(await within(region).findByRole('button', { name: 'Presenter notes' }));
    expect(await screen.findByText(/Notes for "Competing hypotheses shown"/)).toBeInTheDocument();
  });

  it('switches straight to a persona of this tenant that holds the role, and never offers another tenant', async () => {
    const user = userEvent.setup();
    navigateTo('/?present=1');
    renderApp(<PresenterStrip />, { api: api() });
    const region = await strip();
    const button = await within(region).findByRole('button', { name: 'Switch to Ava Engineer' });
    expect(within(region).queryByText(/Fabi/)).toBeNull();
    await user.click(button);
    expect(window.localStorage.getItem('cg-persona')).toBe('user_ava_engineer');
    await expectToast('Now acting as Ava Engineer');
  });

  it('keeps the page clear of the strip by publishing its height, and removes it on exit', async () => {
    const user = userEvent.setup();
    navigateTo('/?present=1');
    renderApp(<PresenterStrip />, { api: api() });
    const region = await strip();
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue(PRESENTER_HEIGHT_VAR)).toMatch(
        /^\d+px$/,
      ),
    );
    await user.click(within(region).getByRole('button', { name: 'Exit presentation' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Presenter strip' })).toBeNull(),
    );
    expect(document.documentElement.style.getPropertyValue(PRESENTER_HEIGHT_VAR)).toBe('');
  });

  it('says the story is complete when every step is done, with the last step still reachable', async () => {
    navigateTo('/?present=1');
    renderApp(<PresenterStrip />, { api: api({ 'demo.state': () => demoState(13) }) });
    const region = await strip();
    expect(await within(region).findByText(/Last step: Outcomes compared/)).toBeInTheDocument();
    // The route of the last step carries a query string (`?tab=compare&with=`): it must reach the link whole.
    expect(within(region).getByRole('link', { name: 'Open Outcomes compared' })).toHaveAttribute(
      'href',
      COMPARE_ROUTE,
    );
  });

  it('says why when the guide cannot be loaded', async () => {
    navigateTo('/?present=1');
    renderApp(<PresenterStrip />, {
      api: api({
        'demo.state': () => {
          throw new ApiError({ status: 500, code: 'internal', title: 'Internal server error' });
        },
      }),
    });
    const region = await strip();
    expect(
      await within(region).findByText(/The demo guide could not be loaded/),
    ).toBeInTheDocument();
  });
});

describe('[FR-PRES-02] reset from the strip', () => {
  it('resets after a confirmation, refreshes everything, confirms with a toast and lands on the Demo Guide', async () => {
    const user = userEvent.setup();
    navigateTo('/?present=1');
    const fake = api({ 'demo.reset': () => demoState(0) });
    renderApp(<PresenterStrip />, { api: fake });
    const region = await strip();
    await waitFor(() =>
      expect(within(region).getByRole('button', { name: 'Reset demo' })).not.toHaveAttribute(
        'aria-disabled',
        'true',
      ),
    );
    await user.click(within(region).getByRole('button', { name: 'Reset demo' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Reset the demo data?' });
    await user.click(within(dialog).getByRole('button', { name: 'Reset demo' }));
    await expectToast('Demo data reset');
    expect(fake.call.mock.calls.some((call) => call[0] === 'demo.reset')).toBe(true);
    expect(router.push).toHaveBeenCalledWith('/demo');
  });

  it('explains the API refusal inside the dialog and stays where it is', async () => {
    const user = userEvent.setup();
    navigateTo('/?present=1');
    renderApp(<PresenterStrip />, {
      api: api({
        'demo.reset': () => {
          throw new ApiError({
            status: 409,
            code: 'conflict',
            reason: 'job_active',
            title: 'Conflict',
            message: 'Words the strip must not depend on',
          });
        },
      }),
    });
    const region = await strip();
    await waitFor(() =>
      expect(within(region).getByRole('button', { name: 'Reset demo' })).not.toHaveAttribute(
        'aria-disabled',
        'true',
      ),
    );
    await user.click(within(region).getByRole('button', { name: 'Reset demo' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Reset demo' }));
    expect(
      await within(dialog).findByText(/A job is still queued or running in this workspace/),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(/Words the strip must not depend on/)).toBeNull();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('disables the reset for a role without demo:manage', async () => {
    navigateTo('/?present=1');
    renderApp(<PresenterStrip />, {
      api: api({ 'session.me': () => session('reviewer', ['case:read']) }),
    });
    const region = await strip();
    expect(within(region).getByRole('button', { name: 'Reset demo' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('has no accessibility violations', async () => {
    navigateTo('/?present=1');
    const { container } = renderApp(<PresenterStrip />, { api: api() });
    const region = await strip();
    await within(region).findByText('Demo guide · 3 of 13 done');
    await expectNoAxeViolations(container);
  });
});

describe('[FR-PRES-03] the navigation outlines where the next step leads', () => {
  it('outlines the item of the page the step opens, also when its route has a query string', async () => {
    // Step 13 leads to the comparison tab of case two: `/cases/case_2/quality?tab=compare&with=case_1`. While a case
    // page is open the Quality Review item opens that case's review, which is where the step leads.
    navigateTo('/cases/case_2?present=1');
    renderApp(
      <AppShell>
        <h1>Page title</h1>
      </AppShell>,
      {
        api: api({
          'demo.state': () => demoState(12),
          'cases.list': () => ({
            items: [caseSummary({ id: 'case_2', reference: 'SAMPLE-002' })],
            nextCursor: null,
          }),
          'search.global': () => ({ items: [], query: 'x' }),
          'system.health': () => systemHealth(),
        }),
        initialCaseId: 'case_2',
      },
    );
    const nav = await screen.findByRole('navigation', { name: 'Primary' });
    const quality = await within(nav).findByRole('link', { name: /^Quality Review/ });
    expect(quality).toHaveAttribute('href', '/cases/case_2/quality');
    await waitFor(() => expect(quality).toHaveClass('cg-presenter-target'));
    expect(within(nav).getByRole('link', { name: /^Case Timeline/ })).not.toHaveClass(
      'cg-presenter-target',
    );
    expect(within(nav).getByRole('link', { name: /^Efficiency Monitor/ })).not.toHaveClass(
      'cg-presenter-target',
    );
  });
});
