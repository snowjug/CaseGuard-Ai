import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { caseSummary, commandCenter, persona, session } from '../../../test/fixtures';
import {
  expectNoAxeViolations,
  fakeApi,
  renderApp,
  type FakeHandlers,
} from '../../../test/harness';
import { navigateTo } from '../../../test/next-navigation';
import { ApiError } from '../../lib/api/errors';
import { HomePage } from './HomePage';

const casesList = () => ({
  items: [
    caseSummary(),
    caseSummary({ id: 'case_2', reference: 'SAMPLE-002', title: 'Mailbox migration stalls' }),
  ],
  nextCursor: null,
});

function api(overrides: FakeHandlers = {}) {
  return fakeApi({
    'session.me': () => session('engineer', ['case:read', 'case:ingest']),
    'cases.list': casesList,
    'dashboard.commandCenter': () => commandCenter(),
    'dev.personas': () => ({
      enabled: true,
      notice: '',
      items: [persona('persona_engineer', 'engineer', 'Eli Engineer')],
    }),
    ...overrides,
  });
}

const reviewHero = async () => screen.findByRole('region', { name: 'Latest review' });

describe('[FR-HOME-01] Home page', () => {
  it('shows a loading skeleton first, then the latest review: a big score, the reason and the way in', async () => {
    renderApp(<HomePage />, { api: api() });
    expect(screen.getByRole('status', { name: 'Loading Home' })).toBeInTheDocument();

    const hero = await reviewHero();
    expect(
      within(hero).getByRole('img', { name: /Case quality: 72 out of 100/ }),
    ).toBeInTheDocument();
    expect(within(hero).getByText('SAMPLE-001')).toBeInTheDocument();
    expect(within(hero).getByText('Intermittent sign-in failures')).toBeInTheDocument();
    // The reason is the top issue, and the way in is the review.
    expect(within(hero).getByText(/2 issues to fix|1 issue to fix/)).toBeInTheDocument();
    expect(within(hero).getByRole('link', { name: 'Open review' })).toHaveAttribute(
      'href',
      '/cases/case_1/review',
    );
    expect(within(hero).getByRole('link', { name: 'Compare possible causes' })).toHaveAttribute(
      'href',
      '/cases/case_1/hypotheses?sel=hyp_1',
    );
  });

  it('puts one primary action in the header: Add a case', async () => {
    renderApp(<HomePage />, { api: api() });
    expect(screen.getByRole('heading', { level: 1, name: 'Home' })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Add a case' })).toHaveAttribute(
      'href',
      '/cases/new',
    );
  });

  it('lists what to fix first: warnings with their next step, then missing evidence with the question to ask', async () => {
    renderApp(<HomePage />, { api: api() });
    const fixes = await screen.findByRole('region', { name: 'Fix first' });
    expect(within(fixes).getByText('High priority')).toBeInTheDocument();
    expect(
      within(fixes).getByRole('link', { name: 'The same logs were requested twice' }),
    ).toHaveAttribute('href', '/cases/case_1/timeline?sel=evt_9');
    expect(
      within(fixes).getByText('Ask for the proxy trace instead of repeating the request.'),
    ).toBeInTheDocument();
    expect(
      within(fixes).getByRole('link', { name: 'Client trace from an affected device' }),
    ).toHaveAttribute('href', '/cases/case_1/evidence?sel=req_1');
    expect(within(fixes).getByText(/Could you capture a trace/)).toBeInTheDocument();
    expect(
      within(fixes).getByRole('button', {
        name: 'Copy the question for Client trace from an affected device',
      }),
    ).toBeInTheDocument();
  });

  it('keeps three fixes in view and expands to all of them on request', async () => {
    const user = userEvent.setup();
    const many = commandCenter();
    const warning = many.openWarnings[0]!;
    renderApp(<HomePage />, {
      api: api({
        'dashboard.commandCenter': () => ({
          ...many,
          openWarnings: [1, 2, 3, 4].map((rank) => ({
            ...warning,
            id: `warn_${rank}`,
            rank,
            title: `Warning number ${rank}`,
          })),
        }),
      }),
    });
    const fixes = await screen.findByRole('region', { name: 'Fix first' });
    expect(within(fixes).getAllByRole('listitem')).toHaveLength(3);
    await user.click(within(fixes).getByRole('button', { name: 'Show all 5' }));
    await waitFor(() => expect(within(fixes).getAllByRole('listitem')).toHaveLength(5));
    expect(within(fixes).getByRole('button', { name: 'Show fewer' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('says nothing is open, and points to the lessons in the review, when a poor case has no open items', async () => {
    renderApp(<HomePage />, {
      api: api({
        'dashboard.commandCenter': () =>
          commandCenter({ openWarnings: [], criticalMissingEvidence: [] }),
      }),
    });
    const fixes = await screen.findByRole('region', { name: 'Fix first' });
    expect(within(fixes).getByText('Nothing is open on this case')).toBeInTheDocument();
    expect(within(fixes).getByRole('link', { name: 'See what to improve' })).toHaveAttribute(
      'href',
      '/cases/case_1/review',
    );
  });

  it('shows three key numbers with their status in words, and never invents one', async () => {
    renderApp(<HomePage />, { api: api() });
    await reviewHero();
    // A StatCard is a card with a heading: its root is the heading's grandparent.
    const cardOf = (name: string): HTMLElement =>
      screen.getByRole('heading', { name }).parentElement!.parentElement!;
    const effort = cardOf('Time that could have been saved');
    expect(within(effort).getByText('Poor')).toBeInTheDocument();
    expect(within(effort).getByText('Range 31 to 45')).toBeInTheDocument();
    expect(
      within(effort).getByRole('button', { name: /About Time that could have been saved/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Evidence integrity' })).toBeInTheDocument();
    // A metric the API has no data for is skipped here and shown with its dash in "All metrics".
    expect(screen.queryByRole('heading', { name: 'Reasoning efficiency' })).toBeNull();
  });

  it('keeps every metric, with its definition, range and evidence link, in "All metrics"', async () => {
    const user = userEvent.setup();
    renderApp(<HomePage />, { api: api() });
    await reviewHero();
    await user.click(await screen.findByRole('button', { name: /All metrics/ }));
    const cqi = await screen.findByRole('group', { name: 'Case Quality Index' });
    expect(
      within(cqi).getByRole('button', { name: 'What is Case Quality Index?' }),
    ).toBeInTheDocument();
    expect(within(cqi).getByText('Estimated range 64 to 80')).toBeInTheDocument();
    expect(within(cqi).getByRole('link', { name: /View score composition/ })).toHaveAttribute(
      'href',
      '/cases/case_1/quality',
    );
    const token = screen.getByRole('group', { name: 'Token Efficiency' });
    expect(within(token).getByText('—')).toBeInTheDocument();
    expect(within(token).getByText('Not enough data')).toBeInTheDocument();
    expect(within(token).queryByText(/Estimated range/)).toBeNull();
  });

  it('lists recent cases as links to their review, and the best skill match with its applicability', async () => {
    renderApp(<HomePage />, { api: api() });
    const recent = await screen.findByRole('region', { name: 'Recent cases' });
    expect(within(recent).getByRole('link', { name: /SAMPLE-001/ })).toHaveAttribute(
      'href',
      '/cases/case_1/review',
    );
    // A case that was not analysed has no review yet: its row opens the case.
    expect(within(recent).getByRole('link', { name: /SAMPLE-002/ })).toHaveAttribute(
      'href',
      '/cases/case_2',
    );
    expect(within(recent).getByText('Not analysed')).toBeInTheDocument();
    const skills = screen.getByRole('region', { name: 'Skills you could reuse' });
    expect(
      within(skills).getByRole('link', { name: /Check proxy authentication first/ }),
    ).toHaveAttribute('href', '/skills/skill_1');
    expect(within(skills).getByText('Applies')).toBeInTheDocument();
    expect(within(skills).getByText(/71%, estimated/)).toBeInTheDocument();
  });

  it('shows the three steps of the flow with the current one marked', async () => {
    renderApp(<HomePage />, { api: api() });
    await reviewHero();
    const flow = screen.getByRole('list', { name: 'How CaseGuard works' });
    expect(within(flow).getAllByRole('listitem')).toHaveLength(3);
    expect(
      within(flow)
        .getByText(/Fix what matters/)
        .closest('li'),
    ).toHaveAttribute('aria-current', 'step');
  });

  it('flags a system that is not healthy in the header, and says nothing while it is healthy', async () => {
    const healthy = renderApp(<HomePage />, { api: api() });
    await reviewHero();
    expect(screen.queryByRole('link', { name: /System status/ })).toBeNull();
    healthy.unmount();
    const base = commandCenter();
    renderApp(<HomePage />, {
      api: api({
        'dashboard.commandCenter': () => ({
          ...base,
          systemHealth: { ...base.systemHealth, status: 'degraded' },
        }),
      }),
    });
    expect(await screen.findByRole('link', { name: /System status: degraded/ })).toHaveAttribute(
      'href',
      '/system',
    );
  });

  it('has no accessibility violations when loaded', async () => {
    const { container } = renderApp(<HomePage />, { api: api() });
    await reviewHero();
    await expectNoAxeViolations(container);
  });
});

describe('[FR-HOME-02] Home states', () => {
  const noCases = () =>
    commandCenter({
      activeCase: null,
      metrics: [],
      recentCases: [],
      openWarnings: [],
      criticalMissingEvidence: [],
      leadingHypothesis: null,
      skillMatch: null,
    });

  it('welcomes a workspace with no cases: three steps, Add a case and Try a sample case', async () => {
    const { container } = renderApp(<HomePage />, {
      api: api({ 'dashboard.commandCenter': noCases }),
    });
    expect(await screen.findByRole('heading', { name: 'Add your first case' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add a case' })).toHaveAttribute('href', '/cases/new');
    expect(screen.getByRole('link', { name: 'Try a sample case' })).toHaveAttribute(
      'href',
      '/cases/new?source=sample',
    );
    expect(screen.getByRole('list', { name: 'How CaseGuard works' })).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('tells a role without ingest permission who can add a case, and offers no button', async () => {
    renderApp(<HomePage />, {
      api: api({
        'session.me': () => session('reviewer', ['case:read']),
        'dashboard.commandCenter': noCases,
      }),
    });
    expect(
      await screen.findByText(/Someone with the Engineer or Administrator role can add one/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Add a case' })).toBeNull();
  });

  it('asks which case to show when the API has none active but there are recent cases', async () => {
    renderApp(<HomePage />, {
      api: api({
        'dashboard.commandCenter': () =>
          commandCenter({
            activeCase: null,
            metrics: [],
            leadingHypothesis: null,
            skillMatch: null,
          }),
      }),
    });
    expect(await screen.findByRole('heading', { name: 'Choose a case' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Recent cases' })).toBeInTheDocument();
  });

  it('opens a case that has not been reviewed with "Open case" and says the review is missing', async () => {
    renderApp(<HomePage />, {
      api: api({
        'dashboard.commandCenter': () =>
          commandCenter({
            activeCase: caseSummary({ analysisState: 'not_analyzed', qualityIndex: null }),
            metrics: [],
            openWarnings: [],
            criticalMissingEvidence: [],
            leadingHypothesis: null,
            skillMatch: null,
          }),
      }),
    });
    const hero = await reviewHero();
    expect(within(hero).getByText(/has not been reviewed yet/)).toBeInTheDocument();
    expect(within(hero).getByRole('link', { name: 'Open case' })).toHaveAttribute(
      'href',
      '/cases/case_1',
    );
    expect(screen.queryByRole('region', { name: 'Fix first' })).toBeNull();
  });

  it('shows an error with Retry when the API is down, and recovers on retry', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const flaky = api({
      'dashboard.commandCenter': () => {
        attempts += 1;
        if (attempts === 1)
          throw new ApiError({
            status: 502,
            code: 'upstream_unavailable',
            title: 'API unavailable',
            correlationId: 'corr-1',
          });
        return commandCenter();
      },
    });
    const { container } = renderApp(<HomePage />, { api: flaky });
    expect(await screen.findByText('The CaseGuard API is not reachable')).toBeInTheDocument();
    expect(screen.getByText(/Check that the API server is running/)).toBeInTheDocument();
    expect(screen.getByText('corr-1')).toBeInTheDocument();
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole('button', { name: /Retry/ }));
    expect(await reviewHero()).toBeInTheDocument();
    expect(attempts).toBe(2);
  });

  it('asks the person to choose an identity (not an error) when nobody is signed in', async () => {
    const quiet = api();
    renderApp(<HomePage />, { api: quiet, persona: null });
    expect(
      await screen.findByRole('heading', { name: 'Choose who you are acting as' }),
    ).toBeInTheDocument();
    expect(await screen.findByRole('list', { name: 'Personas' })).toBeInTheDocument();
    expect(screen.queryByText('The CaseGuard API is not reachable')).toBeNull();
    expect(quiet.call).not.toHaveBeenCalledWith('dashboard.commandCenter', expect.anything());
  });

  it('falls back to the persona dialog when the identities cannot be listed on the page', async () => {
    const quiet = api({
      'dev.personas': () => {
        throw new ApiError({ status: 500, code: 'internal_error', title: 'Server error' });
      },
    });
    renderApp(<HomePage />, { api: quiet, persona: null });
    expect(
      await screen.findByRole('button', { name: 'Choose a development persona' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Personas' })).toBeNull();
  });

  it('shows the product promise and lets a first-time visitor pick a demo identity on the page, in one click', async () => {
    const user = userEvent.setup();
    const first = api({
      'dev.personas': () => ({
        enabled: true,
        notice: '',
        items: [
          persona('persona_engineer', 'engineer', 'Eli Engineer'),
          persona('persona_reviewer', 'reviewer', 'Rae Reviewer'),
        ],
      }),
    });
    const { container } = renderApp(<HomePage />, { api: first, persona: null });
    const list = await screen.findByRole('list', { name: 'Personas' });
    expect(screen.getByText('See how a support case went and what to fix first.')).toBeVisible();
    expect(screen.getByRole('list', { name: 'How CaseGuard works' })).toBeVisible();
    expect(within(list).getAllByRole('button')).toHaveLength(2);
    // The choices are on the page, so there is no second way in through a dialog.
    expect(screen.queryByRole('button', { name: 'Choose a development persona' })).toBeNull();
    await expectNoAxeViolations(container);
    await user.click(within(list).getByRole('button', { name: /Rae Reviewer/ }));
    expect(window.localStorage.getItem('cg-persona')).toBe('persona_reviewer');
  });

  it('does not offer Retry for a forbidden response', async () => {
    const forbidden = api({
      'dashboard.commandCenter': () => {
        throw new ApiError({ status: 403, code: 'forbidden', title: 'Forbidden' });
      },
    });
    renderApp(<HomePage />, { api: forbidden });
    expect(await screen.findByText('You do not have access to this')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
  });
});

describe('[FR-HOME-03] case selection', () => {
  it('requests the case from ?case=, shares it in the URL and remembers it in a cookie', async () => {
    const user = userEvent.setup();
    navigateTo('/?case=case_2');
    const handler = api();
    renderApp(<HomePage />, { api: handler });
    await reviewHero();
    expect(handler.call).toHaveBeenCalledWith(
      'dashboard.commandCenter',
      expect.objectContaining({ query: { caseId: 'case_2' } }),
    );

    const select = await screen.findByRole('combobox', { name: 'Case' });
    await waitFor(() => expect(within(select).getAllByRole('option').length).toBeGreaterThan(2));
    await user.selectOptions(select, 'case_1');
    await waitFor(() => expect(window.location.search).toBe('?case=case_1'));
    expect(document.cookie).toContain('cg-case=case_1');
    await waitFor(() =>
      expect(handler.call).toHaveBeenCalledWith(
        'dashboard.commandCenter',
        expect.objectContaining({ query: { caseId: 'case_1' } }),
      ),
    );
  });

  it('ignores a malformed case id in the URL', async () => {
    navigateTo('/?case=..%2F..%2Fetc');
    const handler = api();
    renderApp(<HomePage />, { api: handler });
    await reviewHero();
    expect(handler.call).toHaveBeenCalledWith(
      'dashboard.commandCenter',
      expect.objectContaining({ query: {} }),
    );
  });

  it('remembers the case the API chose without requesting the dashboard a second time', async () => {
    const handler = api();
    renderApp(<HomePage />, { api: handler });
    await reviewHero();
    await waitFor(() => expect(document.cookie).toContain('cg-case=case_1'));
    const dashboardCalls = handler.call.mock.calls.filter(
      ([routeId]) => routeId === 'dashboard.commandCenter',
    );
    expect(dashboardCalls).toHaveLength(1);
  });
});
