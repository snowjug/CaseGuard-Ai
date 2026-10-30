import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { caseSummary, session } from '../../../test/fixtures';
import {
  expectNoAxeViolations,
  fakeApi,
  renderApp,
  type FakeHandlers,
} from '../../../test/harness';
import { navigateTo } from '../../../test/next-navigation';
import { efficiencyOverview, modelExecution } from '../../../test/u3-fixtures';
import { ApiError } from '../../lib/api/errors';
import { EfficiencyPage } from './EfficiencyPage';
import { dailyShare, rateText, tokenLimitText, usdText } from './model';

// A busy machine can take several seconds to settle a chain of requests; assertions stay exact, only the wait is longer.
configure({ asyncUtilTimeout: 5000 });

function api(overrides: FakeHandlers = {}) {
  return fakeApi({
    'session.me': () => session('manager', ['case:read', 'telemetry:read']),
    'cases.list': () => ({
      items: [caseSummary(), caseSummary({ id: 'case_2', reference: 'SAMPLE-002' })],
      nextCursor: null,
    }),
    'efficiency.overview': () => efficiencyOverview(),
    'efficiency.executions': () => ({
      items: [modelExecution(), modelExecution({ id: 'exec_2', agent: 'timeline_analyzer' })],
      nextCursor: null,
    }),
    ...overrides,
  });
}

describe('[FR-EFF-01] Efficiency model helpers', () => {
  it('states an unset limit as "No limit set" and never as zero', () => {
    expect(tokenLimitText(null)).toBe('No limit set');
    expect(tokenLimitText(24000)).toBe('24,000 tokens');
    expect(usdText(null, 'No limit set')).toBe('No limit set');
    expect(usdText(1.5, 'Unknown')).toBe('$1.50');
  });

  it('shows a rate only once something ran', () => {
    expect(rateText(0, 0)).toBe('—');
    expect(rateText(0, 4)).toBe('0%');
  });

  it('measures the daily budget only when a daily limit is configured', () => {
    const budgets = efficiencyOverview().budgets;
    expect(dailyShare(budgets)).toBeNull();
    expect(dailyShare({ ...budgets, perDayMaxTokens: 200000 })).toBeCloseTo(0.598, 2);
  });
});

describe('[FR-EFF-02] Efficiency Monitor page', () => {
  it('shows a skeleton, then usage, estimated savings and honest labels', async () => {
    renderApp(<EfficiencyPage />, { api: api() });
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);

    const usage = await screen.findByRole('group', { name: 'Token usage' });
    expect(within(usage).getByText('119,698')).toBeInTheDocument();
    expect(within(usage).getByText('Estimated')).toBeInTheDocument();
    expect(within(usage).getByText('Simulated')).toBeInTheDocument();
    // Cost is unknown, not $0.
    expect(within(usage).getByText('Unknown')).toBeInTheDocument();
    expect(within(usage).queryByText('$0.00')).toBeNull();

    expect(
      screen.getByText(/Token counts and latencies come from the deterministic offline provider/),
    ).toBeInTheDocument();
    const savings = screen.getByRole('group', { name: 'Estimated savings' });
    expect(
      within(savings).getByText(/No context trimming, cache reuse or early stopping/),
    ).toBeInTheDocument();
  });

  it('renders unset budgets as "No limit set", never 0', async () => {
    renderApp(<EfficiencyPage />, { api: api() });
    const budgets = await screen.findByRole('group', { name: 'Budgets and limits' });
    expect(within(budgets).getAllByText('No limit set')).toHaveLength(3);
    expect(within(budgets).getByText('24,000 tokens')).toBeInTheDocument();
    expect(within(budgets).getByText('119,698 tokens')).toBeInTheDocument();
    expect(within(budgets).getByText(/No daily limit is set/)).toBeInTheDocument();
    expect(within(budgets).queryByRole('progressbar')).toBeNull();
  });

  it('measures today against the daily limit when one is configured', async () => {
    const overview = efficiencyOverview();
    renderApp(<EfficiencyPage />, {
      api: api({
        'efficiency.overview': () =>
          efficiencyOverview({ budgets: { ...overview.budgets, perDayMaxTokens: 200000 } }),
      }),
    });
    const budgets = await screen.findByRole('group', { name: 'Budgets and limits' });
    expect(within(budgets).getByRole('progressbar')).toHaveAccessibleName(/60 percent/);
    expect(within(budgets).getByText('200,000 tokens')).toBeInTheDocument();
  });

  it('compares the real and the simulated path, labelled as estimated and simulated', async () => {
    renderApp(<EfficiencyPage />, { api: api() });
    const panel = await screen.findByRole('group', {
      name: 'Real process versus a simulated better path',
    });
    expect(within(panel).getByText('Estimated')).toBeInTheDocument();
    expect(within(panel).getAllByText(/Simulated/).length).toBeGreaterThan(0);
    expect(within(panel).getByText(/Estimated saving: 80.7%/)).toBeInTheDocument();
  });

  it('claims no saving when no simulated path exists', async () => {
    renderApp(<EfficiencyPage />, {
      api: api({
        'efficiency.overview': () =>
          efficiencyOverview({
            caseProcess: {
              actualTokens: 0,
              counterfactualTokens: null,
              estimatedSavingsPct: null,
              caseId: null,
            },
          }),
      }),
    });
    const panel = await screen.findByRole('group', {
      name: 'Real process versus a simulated better path',
    });
    expect(within(panel).getByText('No comparison is available yet')).toBeInTheDocument();
    expect(within(panel).queryByText(/Estimated saving/)).toBeNull();
  });

  it('explains why there is no circuit breaker, and shows one that is open', async () => {
    const { unmount } = renderApp(<EfficiencyPage />, { api: api() });
    const empty = await screen.findByRole('group', { name: 'Circuit breakers' });
    expect(within(empty).getByText('No circuit breaker is in use')).toBeInTheDocument();
    expect(within(empty).getByText(/makes no remote calls/)).toBeInTheDocument();
    unmount();

    renderApp(<EfficiencyPage />, {
      api: api({
        'efficiency.overview': () =>
          efficiencyOverview({
            circuitBreakers: [
              {
                name: 'azure-openai',
                state: 'open',
                consecutiveFailures: 5,
                openedAt: '2026-10-30T07:00:00Z',
              },
            ],
          }),
      }),
    });
    const group = await screen.findByRole('group', { name: 'Circuit breakers' });
    expect(within(group).getByText('Open')).toBeInTheDocument();
    expect(within(group).getByText(/5 consecutive failures/)).toBeInTheDocument();
  });

  it('shows an empty state with a next action when nothing has run, and does not ask for executions', async () => {
    const executions = (): never => {
      throw new Error('executions must not be requested');
    };
    const fake = api({
      'efficiency.overview': () =>
        efficiencyOverview({
          totals: {
            executions: 0,
            promptTokens: 0,
            completionTokens: 0,
            cachedTokens: 0,
            totalTokens: 0,
            estimatedCostUsd: null,
            avgLatencyMs: 0,
            cacheHitRate: 0,
            failureRate: 0,
          },
          byAgent: [],
          byModel: [],
        }),
      'efficiency.executions': executions,
    });
    renderApp(<EfficiencyPage />, { api: fake });
    expect(await screen.findByText('No model executions recorded yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Cases' })).toHaveAttribute('href', '/cases');
    // The limits do not depend on usage, so they are still shown, and a rate is never 0% of nothing.
    expect(screen.getByRole('group', { name: 'Budgets and limits' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Model executions' })).toBeNull();
    expect(fake.call.mock.calls.some(([id]) => id === 'efficiency.executions')).toBe(false);
  });

  it('shows an error with Retry and recovers', async () => {
    let attempts = 0;
    renderApp(<EfficiencyPage />, {
      api: api({
        'efficiency.overview': () => {
          attempts += 1;
          if (attempts === 1)
            throw new ApiError({
              status: 500,
              code: 'internal',
              title: 'Internal error',
              message: 'Boom',
            });
          return efficiencyOverview();
        },
      }),
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The Efficiency Monitor could not be loaded',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('group', { name: 'Token usage' })).toBeInTheDocument();
  });

  it('explains a role without telemetry access and makes no request', async () => {
    const fake = api({ 'session.me': () => session('skill_curator', ['case:read', 'skill:read']) });
    renderApp(<EfficiencyPage />, { api: fake });
    expect(
      await screen.findByText('You do not have access to the Efficiency Monitor'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/does not include the "telemetry:read" permission/),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Command Center' })).toHaveAttribute('href', '/');
    expect(fake.call.mock.calls.some(([id]) => id === 'efficiency.overview')).toBe(false);
  });
});

describe('[FR-EFF-03] URL state and the executions table', () => {
  it('scopes the page to the case in the URL and writes the choice back', async () => {
    navigateTo('/efficiency?case=case_2');
    const fake = api();
    renderApp(<EfficiencyPage />, { api: fake });
    await screen.findByRole('group', { name: 'Token usage' });
    const overviewCalls = () => fake.call.mock.calls.filter(([id]) => id === 'efficiency.overview');
    expect(overviewCalls()[0]?.[1]).toMatchObject({ query: { caseId: 'case_2' } });

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Scope' }), '');
    await waitFor(() => expect(window.location.search).toBe(''));
    await waitFor(() => expect(overviewCalls().at(-1)?.[1]).toMatchObject({ query: {} }));
  });

  it('filters the executions by agent through the URL and loads more on request', async () => {
    navigateTo('/efficiency');
    const fake = api({
      'efficiency.executions': (input) => {
        const query = (input as { query: { cursor?: string; agent?: string } }).query;
        if (query.cursor === 'next') {
          return {
            items: [modelExecution({ id: 'exec_3', agent: 'evidence_classifier' })],
            nextCursor: null,
          };
        }
        return { items: [modelExecution(), modelExecution({ id: 'exec_2' })], nextCursor: 'next' };
      },
    });
    renderApp(<EfficiencyPage />, { api: fake });
    const table = await screen.findByRole('table', { name: 'Model executions' });
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(screen.getByText(/Showing 2 executions; more are available/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(4));
    expect(screen.getByText(/Showing 3 executions\./)).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Agent' }), 'quality_judge');
    await waitFor(() => expect(window.location.search).toBe('?agent=quality_judge'));
    await waitFor(() =>
      expect(
        fake.call.mock.calls.some(
          ([id, input]) =>
            id === 'efficiency.executions' &&
            (input as { query: { agent?: string } }).query.agent === 'quality_judge',
        ),
      ).toBe(true),
    );
  });

  it('shows each call with its status, checks and a details disclosure', async () => {
    renderApp(<EfficiencyPage />, {
      api: api({
        'efficiency.executions': () => ({
          items: [
            modelExecution({
              validation: {
                schemaValid: true,
                citationsValid: false,
                policyValid: true,
                temporalValid: true,
                issues: ['Citation e99 is not in the evidence set.'],
              },
              status: 'rejected_by_validation',
            }),
          ],
          nextCursor: null,
        }),
      }),
    });
    const table = await screen.findByRole('table', { name: 'Model executions' });
    expect(within(table).getByText('Rejected by validation')).toBeInTheDocument();
    expect(within(table).getByText('Failed: Citations')).toBeInTheDocument();
    expect(within(table).getByText('Citation e99 is not in the evidence set.')).toBeInTheDocument();
  });
});

describe('[FR-EFF-04] Efficiency Monitor accessibility', () => {
  it('has no axe violations when loaded', async () => {
    const { container } = renderApp(<EfficiencyPage />, { api: api() });
    await screen.findByRole('table', { name: 'Model executions' });
    await expectNoAxeViolations(container);
  }, 120_000);

  it('has no axe violations in dark mode with an open circuit breaker', async () => {
    const { container } = renderApp(<EfficiencyPage />, {
      mode: 'dark',
      api: api({
        'efficiency.overview': () =>
          efficiencyOverview({
            circuitBreakers: [
              { name: 'azure-openai', state: 'half_open', consecutiveFailures: 3, openedAt: null },
            ],
          }),
      }),
    });
    await screen.findByText('Half open');
    await expectNoAxeViolations(container);
  }, 120_000);
});
