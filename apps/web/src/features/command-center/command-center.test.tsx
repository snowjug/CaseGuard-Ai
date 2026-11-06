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
import { CommandCenterPage } from './CommandCenterPage';

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

describe('[FR-CC-01] Command Center page', () => {
  it('shows a loading skeleton first, then every metric card with its definition, range and evidence link', async () => {
    renderApp(<CommandCenterPage />, { api: api() });
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Loading metrics/).length).toBeGreaterThan(0);

    const grid = await screen.findByRole('heading', { name: 'Key metrics' });
    expect(grid).toBeInTheDocument();
    for (const name of [
      'Case Quality Index',
      'Evidence Integrity',
      'Avoidable Support Effort',
      'Token Efficiency',
    ]) {
      const card = screen.getByRole('group', { name });
      expect(within(card).getByRole('button', { name: `What is ${name}?` })).toBeInTheDocument();
    }
    const cqi = screen.getByRole('group', { name: 'Case Quality Index' });
    expect(within(cqi).getByText('72')).toBeInTheDocument();
    expect(within(cqi).getByText('Estimated range 64 to 80')).toBeInTheDocument();
    expect(within(cqi).getByRole('link', { name: /View score composition/ })).toHaveAttribute(
      'href',
      '/cases/case_1/quality',
    );
  });

  it('never invents a number: an unknown metric shows a dash and "Not enough data"', async () => {
    renderApp(<CommandCenterPage />, { api: api() });
    const card = await screen.findByRole('group', { name: 'Token Efficiency' });
    expect(within(card).getByText('—')).toBeInTheDocument();
    expect(within(card).getByText('Not enough data')).toBeInTheDocument();
    expect(within(card).queryByText(/Estimated range/)).toBeNull();
  });

  it('shows the leading hypothesis with its confidence band and the model-estimate notice', async () => {
    renderApp(<CommandCenterPage />, { api: api() });
    const panel = await screen.findByRole('group', { name: 'Leading hypothesis' });
    expect(within(panel).getByText('Proxy authentication misconfiguration')).toBeInTheDocument();
    expect(
      within(panel).getByRole('img', {
        name: /Confidence in Proxy authentication misconfiguration/,
      }),
    ).toBeInTheDocument();
    expect(within(panel).getByText(/Confidence values are model estimates/)).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: 'Compare hypotheses' })).toHaveAttribute(
      'href',
      '/cases/case_1/hypotheses?sel=hyp_1',
    );
  });

  it('lists the SkillDNA match, critical missing evidence and open warnings with evidence links', async () => {
    renderApp(<CommandCenterPage />, { api: api() });
    const skill = await screen.findByRole('group', { name: 'SkillDNA match' });
    expect(within(skill).getByText('Check proxy authentication first')).toBeInTheDocument();
    expect(within(skill).getByText('71%')).toBeInTheDocument();
    expect(within(skill).getByText('Applies')).toBeInTheDocument();

    const missing = screen.getByRole('group', { name: 'Critical missing evidence' });
    expect(
      within(missing).getByRole('link', { name: 'Client trace from an affected device' }),
    ).toHaveAttribute('href', '/cases/case_1/evidence?sel=req_1');
    expect(within(missing).getByText(/Could you capture a trace/)).toBeInTheDocument();

    const warnings = screen.getByRole('group', { name: 'Open warnings' });
    expect(within(warnings).getByText('The same logs were requested twice')).toBeInTheDocument();
    expect(within(warnings).getByRole('link', { name: 'Second log request' })).toHaveAttribute(
      'href',
      '/cases/case_1/timeline?sel=evt_9',
    );
    expect(within(warnings).getByText('High priority')).toBeInTheDocument();
  });

  it('lists recent cases, skill candidates and the system health summary', async () => {
    renderApp(<CommandCenterPage />, { api: api() });
    const recent = await screen.findByRole('group', { name: 'Recent cases' });
    expect(within(recent).getByRole('link', { name: 'SAMPLE-001' })).toHaveAttribute(
      'href',
      '/cases/case_1',
    );
    expect(within(recent).getByRole('link', { name: 'SAMPLE-002' })).toHaveAttribute(
      'href',
      '/cases/case_2',
    );
    expect(within(recent).getByText(/Quality 72 · 2 open warnings/)).toBeInTheDocument();
    expect(within(recent).getByText(/Quality not available · 0 open warnings/)).toBeInTheDocument();
    expect(within(recent).getByText('Not analysed')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Skill candidates' })).toHaveTextContent(
      'No skill candidates yet',
    );
    const health = screen.getByRole('group', { name: 'System health' });
    expect(within(health).getByText('Healthy')).toBeInTheDocument();
    expect(within(health).getByText('Simulated')).toBeInTheDocument();
  });

  it('labels synthetic data wherever it appears', async () => {
    renderApp(<CommandCenterPage />, { api: api() });
    expect((await screen.findAllByText('Demo data')).length).toBeGreaterThan(2);
    expect(
      screen.getByText(/All case data, people and organisations in this environment are synthetic/),
    ).toBeInTheDocument();
  });

  it('has no accessibility violations when loaded', async () => {
    const { container } = renderApp(<CommandCenterPage />, { api: api() });
    await screen.findByRole('heading', { name: 'Key metrics' });
    await expectNoAxeViolations(container);
  });
});

describe('[FR-CC-02] Command Center states', () => {
  it('shows the empty state with a working link to Cases when there are no cases', async () => {
    const empty = api({
      'dashboard.commandCenter': () =>
        commandCenter({
          activeCase: null,
          metrics: [],
          recentCases: [],
          openWarnings: [],
          criticalMissingEvidence: [],
          leadingHypothesis: null,
          skillMatch: null,
        }),
    });
    const { container } = renderApp(<CommandCenterPage />, { api: empty });
    expect(await screen.findByRole('heading', { name: 'No cases yet' })).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Open Cases to load the synthetic sample/ });
    expect(link).toHaveAttribute('href', '/cases');
    expect(screen.getByText(/Load the synthetic sample from Cases/)).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('tells a role without ingest permission who can load the sample', async () => {
    const empty = api({
      'session.me': () => session('reviewer', ['case:read']),
      'dashboard.commandCenter': () =>
        commandCenter({ activeCase: null, metrics: [], recentCases: [] }),
    });
    renderApp(<CommandCenterPage />, { api: empty });
    expect(
      await screen.findByText(
        /Someone with the Engineer or Administrator role can load the synthetic sample/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Open Cases to load the synthetic sample/ }),
    ).toBeInTheDocument();
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
    const { container } = renderApp(<CommandCenterPage />, { api: flaky });
    expect(await screen.findByText('The CaseGuard API is not reachable')).toBeInTheDocument();
    expect(screen.getByText(/Check that the API server is running/)).toBeInTheDocument();
    expect(screen.getByText('corr-1')).toBeInTheDocument();
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole('button', { name: /Retry/ }));
    expect(await screen.findByRole('heading', { name: 'Key metrics' })).toBeInTheDocument();
    expect(attempts).toBe(2);
  });

  it('asks the person to choose an identity (not an error) when nobody is signed in', async () => {
    const quiet = api();
    renderApp(<CommandCenterPage />, { api: quiet, persona: null });
    expect(
      await screen.findByRole('heading', { name: 'Choose who you are acting as' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Choose a development persona' }),
    ).toBeInTheDocument();
    expect(quiet.call).not.toHaveBeenCalledWith('dashboard.commandCenter', expect.anything());
  });

  it('does not offer Retry for a forbidden response', async () => {
    const forbidden = api({
      'dashboard.commandCenter': () => {
        throw new ApiError({ status: 403, code: 'forbidden', title: 'Forbidden' });
      },
    });
    renderApp(<CommandCenterPage />, { api: forbidden });
    expect(await screen.findByText('You do not have access to this')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
  });
});

describe('[FR-CC-03] active case selection', () => {
  it('requests the case from ?case=, shares it in the URL and remembers it in a cookie', async () => {
    const user = userEvent.setup();
    navigateTo('/?case=case_2');
    const handler = api();
    renderApp(<CommandCenterPage />, { api: handler });
    await screen.findByRole('heading', { name: 'Key metrics' });
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
    renderApp(<CommandCenterPage />, { api: handler });
    await screen.findByRole('heading', { name: 'Key metrics' });
    expect(handler.call).toHaveBeenCalledWith(
      'dashboard.commandCenter',
      expect.objectContaining({ query: {} }),
    );
  });

  it('remembers the case the API chose without requesting the dashboard a second time', async () => {
    const handler = api();
    renderApp(<CommandCenterPage />, { api: handler });
    await screen.findByRole('heading', { name: 'Key metrics' });
    await waitFor(() => expect(document.cookie).toContain('cg-case=case_1'));
    const dashboardCalls = handler.call.mock.calls.filter(
      ([routeId]) => routeId === 'dashboard.commandCenter',
    );
    expect(dashboardCalls).toHaveLength(1);
  });
});
