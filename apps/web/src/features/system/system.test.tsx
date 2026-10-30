import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, session } from '../../../test/fixtures';
import {
  expectNoAxeViolations,
  fakeApi,
  renderApp,
  type FakeHandlers,
} from '../../../test/harness';
import { providerStatus, requestMetrics, systemHealth } from '../../../test/u4-fixtures';
import { ApiError } from '../../lib/api/errors';
import { SystemHealthPage } from './SystemHealthPage';

const admin = () => session('administrator', ALL_PERMISSIONS);

function api(overrides: FakeHandlers = {}) {
  return fakeApi({
    'session.me': admin,
    'system.health': () => systemHealth(),
    'system.metrics': () => requestMetrics(),
    'system.provider': () => providerStatus(),
    ...overrides,
  });
}

const serverError = () =>
  new ApiError({ status: 500, code: 'internal', title: 'Internal server error' });

describe('[FR-SYS-01] System Health page', () => {
  it('shows a skeleton first, then the overall status, service facts and migrations', async () => {
    renderApp(<SystemHealthPage />, { api: api() });
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
    expect(await screen.findByRole('heading', { level: 1, name: 'System Health' })).toBeVisible();

    const overall = await screen.findByRole('group', { name: 'Overall status' });
    expect(within(overall).getByText('Healthy')).toBeInTheDocument();
    expect(within(overall).getByText('caseguard-api 0.1.0')).toBeInTheDocument();
    expect(within(overall).getByText('local')).toBeInTheDocument();
    expect(within(overall).getByText('1 h 02 min')).toBeInTheDocument();
    expect(within(overall).getByText('Not recorded')).toBeInTheDocument();

    const migrations = await screen.findByRole('group', { name: 'Migrations' });
    expect(within(migrations).getByText('Up to date')).toBeInTheDocument();
    expect(within(migrations).getByText('0012_review_target_type_idx')).toBeInTheDocument();
  });

  it('labels every simulated stand-in in the table and says Azure was validated against mocks only', async () => {
    renderApp(<SystemHealthPage />, { api: api() });
    const table = await screen.findByRole('table', { name: 'Dependencies and their health' });
    const rows = within(table).getAllByRole('row');
    // Header + seven dependencies.
    expect(rows).toHaveLength(8);
    expect(within(table).getAllByText('Simulated stand-in')).toHaveLength(5);
    expect(within(table).getAllByText('Configured service')).toHaveLength(2);
    const storage = rows.find((row) => within(row).queryByText('Object storage'));
    expect(storage).toBeDefined();
    expect(within(storage as HTMLElement).getByText('Simulated stand-in')).toBeInTheDocument();
    expect(
      within(storage as HTMLElement).getByText(/local object store reachable/),
    ).toBeInTheDocument();

    const honesty = screen.getByRole('group', { name: 'What is real here' });
    expect(
      within(honesty).getByText(/validated against mocks or locally generated test data only/),
    ).toBeInTheDocument();
    expect(within(honesty).getByText(/No live Azure service was called/)).toBeInTheDocument();
    const standIns = within(honesty).getByRole('list', { name: 'Simulated stand-ins' });
    expect(within(standIns).getAllByRole('listitem')).toHaveLength(5);
    // The API's per-dependency repetition is not listed twice; its other notices are.
    expect(within(honesty).queryByText(/is an in-process or synthetic stand-in/)).toBeNull();
    expect(within(honesty).getByText(/No cloud language model is connected/)).toBeInTheDocument();
  });

  it('shows an unknown dependency as unknown, never healthy', async () => {
    const health = systemHealth();
    renderApp(<SystemHealthPage />, {
      api: api({
        'system.health': () => ({
          ...health,
          status: 'degraded',
          dependencies: health.dependencies.map((dependency) =>
            dependency.name === 'search'
              ? {
                  ...dependency,
                  status: 'unknown',
                  simulated: false,
                  detail:
                    'Azure AI Search is configured but not probed here; validated against mocks only.',
                }
              : dependency,
          ),
        }),
      }),
    });
    const table = await screen.findByRole('table', { name: 'Dependencies and their health' });
    const row = within(table)
      .getAllByRole('row')
      .find((candidate) => /Azure AI Search is configured/.test(candidate.textContent ?? ''));
    expect(row).toBeDefined();
    expect(within(row as HTMLElement).getByText('Unknown')).toBeInTheDocument();
    expect(within(row as HTMLElement).queryByText('Healthy')).toBeNull();
    expect(within(row as HTMLElement).getByText(/not probed here/)).toBeInTheDocument();
    expect(await screen.findByText('Degraded')).toBeInTheDocument();
  });

  it('shows the provider with its validation note and the simulated label', async () => {
    renderApp(<SystemHealthPage />, { api: api() });
    const provider = await screen.findByRole('group', { name: 'AI provider' });
    expect(within(provider).getByText('Deterministic provider')).toBeInTheDocument();
    expect(within(provider).getByText('Simulated')).toBeInTheDocument();
    expect(within(provider).getByText(/fully offline, reproducible/)).toBeInTheDocument();
    expect(within(provider).getByText('deterministic-knowledge-pack')).toBeInTheDocument();
    expect(within(provider).getByText('24,000')).toBeInTheDocument();
    expect(within(provider).getByText('30 s')).toBeInTheDocument();
  });

  it('reports an unknown provider health as unknown (no call has been made), not healthy', async () => {
    renderApp(<SystemHealthPage />, {
      api: api({
        'system.provider': () =>
          providerStatus({
            kind: 'azure-openai',
            healthy: null,
            simulated: false,
            validationNote: 'Implemented, validated against mocks only.',
          }),
      }),
    });
    const provider = await screen.findByRole('group', { name: 'AI provider' });
    expect(within(provider).getByText('Azure OpenAI')).toBeInTheDocument();
    expect(within(provider).getByText('Unknown: not checked by a call')).toBeInTheDocument();
    expect(within(provider).queryByText('Simulated')).toBeNull();
    expect(
      within(provider).getByText('Implemented, validated against mocks only.'),
    ).toBeInTheDocument();
  });

  it('shows request, model-execution and security counters with their in-memory caveat', async () => {
    renderApp(<SystemHealthPage />, { api: api() });
    const requests = await screen.findByRole('group', { name: 'Requests' });
    expect(within(requests).getByText(/reset when it restarts/)).toBeInTheDocument();
    expect(within(requests).getByText('120')).toBeInTheDocument();
    expect(within(requests).getByText('2.5%')).toBeInTheDocument();
    expect(within(requests).getByText('143.9 ms')).toBeInTheDocument();
    const routes = within(requests).getByRole('table', { name: 'Requests by route' });
    expect(within(routes).getByText('GET /api/v1/cases')).toBeInTheDocument();

    const model = screen.getByRole('group', { name: 'Model executions' });
    expect(within(model).getByText('Simulated')).toBeInTheDocument();
    expect(within(model).getByText(/no language model was called/)).toBeInTheDocument();
    const security = screen.getByRole('group', { name: 'Security events' });
    expect(within(security).getByText('Authentication failures')).toBeInTheDocument();
    expect(within(security).getByText('Injection flags')).toBeInTheDocument();
  });

  it('keeps the page when the metrics fail and retries just that section', async () => {
    const user = userEvent.setup();
    let calls = 0;
    renderApp(<SystemHealthPage />, {
      api: api({
        'system.metrics': () => {
          calls += 1;
          if (calls === 1) throw serverError();
          return requestMetrics({ totalRequests: 77 });
        },
      }),
    });
    expect(
      await screen.findByRole('table', { name: 'Dependencies and their health' }),
    ).toBeVisible();
    expect(await screen.findByText('The request metrics could not be loaded')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('77')).toBeInTheDocument();
  });
});

describe('[FR-SYS-02] System Health states', () => {
  it('shows an error with Retry when the health check cannot be loaded, then recovers', async () => {
    const user = userEvent.setup();
    let calls = 0;
    renderApp(<SystemHealthPage />, {
      api: api({
        'system.health': () => {
          calls += 1;
          if (calls === 1) throw serverError();
          return systemHealth();
        },
      }),
    });
    expect(await screen.findByText('System health could not be loaded')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('group', { name: 'Overall status' })).toBeVisible();
    expect(calls).toBe(2);
  });

  it('refreshes every section from the Refresh button', async () => {
    const user = userEvent.setup();
    const fake = api();
    renderApp(<SystemHealthPage />, { api: fake });
    await screen.findByRole('group', { name: 'Security events' });
    const count = (route: string): number =>
      fake.call.mock.calls.filter((call) => call[0] === route).length;
    expect([count('system.health'), count('system.metrics'), count('system.provider')]).toEqual([
      1, 1, 1,
    ]);
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(count('system.health')).toBe(2));
    await waitFor(() => expect(count('system.metrics')).toBe(2));
    await waitFor(() => expect(count('system.provider')).toBe(2));
  });

  it('R refreshes every section too', async () => {
    const user = userEvent.setup();
    const fake = api();
    renderApp(<SystemHealthPage />, { api: fake });
    await screen.findByRole('group', { name: 'Security events' });
    const count = (route: string): number =>
      fake.call.mock.calls.filter((call) => call[0] === route).length;
    await user.keyboard('r');
    await waitFor(() => expect(count('system.health')).toBe(2));
    await waitFor(() => expect(count('system.metrics')).toBe(2));
  });

  it('explains a role without telemetry:read instead of requesting the data', async () => {
    const user = userEvent.setup();
    const fake = api({
      'session.me': () => session('skill_curator', ['case:read', 'skill:read']),
    });
    renderApp(<SystemHealthPage />, { api: fake });
    expect(await screen.findByText('You do not have access to System Health')).toBeInTheDocument();
    expect(
      screen.getByText(/does not include the "telemetry:read" permission/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Knowledge \/ Skill Curator/)).toBeInTheDocument();
    await user.keyboard('r');
    expect(fake.call.mock.calls.some((call) => call[0] === 'system.health')).toBe(false);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('asks for an identity when nobody is signed in', async () => {
    renderApp(<SystemHealthPage />, { api: api(), persona: null });
    expect(await screen.findByText('Choose who you are acting as')).toBeInTheDocument();
  });

  it('has no accessibility violations (loaded)', async () => {
    const { container } = renderApp(<SystemHealthPage />, { api: api() });
    await screen.findByRole('group', { name: 'Security events' });
    await expectNoAxeViolations(container);
  });

  it('has no accessibility violations (permission needed)', async () => {
    const { container } = renderApp(<SystemHealthPage />, {
      api: api({ 'session.me': () => session('manager', ['case:read']) }),
    });
    await screen.findByText('You do not have access to System Health');
    await expectNoAxeViolations(container);
  });
});
