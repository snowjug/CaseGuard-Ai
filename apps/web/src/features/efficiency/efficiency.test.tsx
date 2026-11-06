import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
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
import { budgetState, dailyShare, failedChecks, rateText, tokenLimitText, usdText } from './model';

// A busy machine can take several seconds to settle a chain of requests; assertions stay exact, only the wait is longer.
configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 120_000 });

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

/** Opens a collapsed section the way a person does (its trigger is a button) and returns its content region. */
async function openSection(
  user: ReturnType<typeof userEvent.setup>,
  name: RegExp,
): Promise<HTMLElement> {
  await user.click(await screen.findByRole('button', { name }));
  return screen.findByRole('region', { name });
}

describe('[FR-EFF-01] Usage and cost model helpers', () => {
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

  it('names the budget state: none without a daily limit, then within, close to and at the limit', () => {
    const budgets = efficiencyOverview().budgets;
    const state = (perDayMaxTokens: number | null) =>
      budgetState({ ...budgets, perDayMaxTokens, consumedToday: 100 });
    expect(state(null)).toMatchObject({ label: 'No daily limit set', status: 'neutral' });
    expect(state(1000)).toMatchObject({ label: 'Within the daily limit', status: 'productive' });
    expect(state(120)).toMatchObject({ label: 'Close to the daily limit', status: 'uncertain' });
    expect(state(100)).toMatchObject({ label: 'Daily limit reached', status: 'unsupported' });
  });

  it('lists the checks a call failed', () => {
    const validation = modelExecution().validation;
    expect(failedChecks({ validation })).toEqual([]);
    expect(failedChecks({ validation: { ...validation, citationsValid: false } })).toEqual([
      'Citations',
    ]);
  });
});

describe('[FR-EFF-02] Usage and cost page', () => {
  it('shows a skeleton, then the estimated spend, usage and honest labels', async () => {
    const user = userEvent.setup();
    renderApp(<EfficiencyPage />, { api: api() });
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
    expect(await screen.findByRole('heading', { level: 1, name: 'Usage and cost' })).toBeVisible();

    const spend = await screen.findByRole('group', { name: 'Estimated spend' });
    // The figures count up for a moment when they appear: wait for the final value.
    expect(await within(spend).findByText('119,698')).toBeInTheDocument();
    expect(within(spend).getByText('Estimated')).toBeInTheDocument();
    expect(within(spend).getByText('Simulated')).toBeInTheDocument();
    // Cost is unknown, not $0.
    expect(within(spend).getByText('Cost unknown')).toBeInTheDocument();
    expect(within(spend).queryByText('$0.00')).toBeNull();
    expect(within(spend).getByText('No daily limit set')).toBeInTheDocument();

    const notes = await openSection(user, /^How to read these figures/);
    expect(
      within(notes).getByText(
        /Token counts and latencies come from the deterministic offline provider/,
      ),
    ).toBeInTheDocument();
    // The first section is open, so the savings are there without a click.
    const savings = screen.getByRole('region', { name: /^Estimated savings/ });
    expect(
      within(savings).getByText(/No context trimming, cache reuse or early stopping/),
    ).toBeInTheDocument();
  });

  it('keeps the savings open and every other section collapsed', async () => {
    renderApp(<EfficiencyPage />, { api: api() });
    await screen.findByRole('group', { name: 'Estimated spend' });
    expect(screen.getByRole('button', { name: /^Estimated savings/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    for (const name of [
      /^Real process versus a simulated better path/,
      /^Budgets and limits/,
      /^Safety limits/,
      /^Usage by analysis step and model/,
      /^Model calls/,
      /^How to read these figures/,
    ])
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-expanded', 'false');
  });

  it('renders unset budgets as "No limit set", never 0', async () => {
    const user = userEvent.setup();
    renderApp(<EfficiencyPage />, { api: api() });
    const budgets = await openSection(user, /^Budgets and limits/);
    expect(within(budgets).getAllByText('No limit set')).toHaveLength(3);
    expect(within(budgets).getByText('24,000 tokens')).toBeInTheDocument();
    expect(within(budgets).getByText('119,698 tokens')).toBeInTheDocument();
    expect(within(budgets).getByText(/No daily limit is set/)).toBeInTheDocument();
    expect(within(budgets).queryByRole('progressbar')).toBeNull();
    expect(
      within(budgets).getByRole('link', { name: 'Change limits in Settings and audit' }),
    ).toHaveAttribute('href', '/governance?tab=model');
  });

  it('measures today against the daily limit when one is configured', async () => {
    const user = userEvent.setup();
    const overview = efficiencyOverview();
    renderApp(<EfficiencyPage />, {
      api: api({
        'efficiency.overview': () =>
          efficiencyOverview({ budgets: { ...overview.budgets, perDayMaxTokens: 200000 } }),
      }),
    });
    const budgets = await openSection(user, /^Budgets and limits/);
    expect(within(budgets).getByRole('progressbar')).toHaveAccessibleName(/60 percent/);
    expect(within(budgets).getByText('200,000 tokens')).toBeInTheDocument();
    // The state is in the summary, so nobody has to open the section to learn it.
    const spend = screen.getByRole('group', { name: 'Estimated spend' });
    expect(within(spend).getByText('Within the daily limit')).toBeInTheDocument();
  });

  it('compares the real and the simulated path, labelled as estimated and simulated', async () => {
    const user = userEvent.setup();
    renderApp(<EfficiencyPage />, { api: api() });
    const panel = await openSection(user, /^Real process versus a simulated better path/);
    expect(within(panel).getByText('Estimated')).toBeInTheDocument();
    expect(within(panel).getAllByText(/Simulated/).length).toBeGreaterThan(0);
    expect(within(panel).getByText(/Estimated saving: 80.7%/)).toBeInTheDocument();
  });

  it('claims no saving when no simulated path exists', async () => {
    const user = userEvent.setup();
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
    const panel = await openSection(user, /^Real process versus a simulated better path/);
    expect(within(panel).getByText('No comparison is available yet')).toBeInTheDocument();
    expect(within(panel).queryByText(/Estimated saving/)).toBeNull();
  });

  it('explains why there is no safety limit, and shows one that has tripped', async () => {
    const user = userEvent.setup();
    const { unmount } = renderApp(<EfficiencyPage />, { api: api() });
    const empty = await openSection(user, /^Safety limits/);
    expect(within(empty).getByText('No safety limit is in use')).toBeInTheDocument();
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
    // A limit that is not normal is visible in the section's header before it is opened.
    expect(
      await screen.findByRole('button', { name: /^Safety limits.*1 not normal/ }),
    ).toBeInTheDocument();
    const group = await openSection(user, /^Safety limits/);
    const tripped = within(group).getByText('Tripped');
    expect(tripped).toBeInTheDocument();
    // The technical term stays available as the tooltip.
    expect(tripped.closest('[title]')).toHaveAttribute('title', 'Circuit breaker state: open');
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
    expect(await screen.findByText('No model calls recorded yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open cases' })).toHaveAttribute('href', '/cases');
    // The limits do not depend on usage, so they are still shown (open, as the first section), and a rate is never 0% of nothing.
    expect(screen.getByRole('button', { name: /^Budgets and limits/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.queryByRole('button', { name: /^Model calls/ })).toBeNull();
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
      'Usage and cost could not be loaded',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('group', { name: 'Estimated spend' })).toBeInTheDocument();
  });

  it('explains a role without telemetry access and makes no request', async () => {
    const fake = api({ 'session.me': () => session('skill_curator', ['case:read', 'skill:read']) });
    renderApp(<EfficiencyPage />, { api: fake });
    expect(await screen.findByText('You do not have access to Usage and cost')).toBeInTheDocument();
    expect(
      screen.getByText(/does not include the "telemetry:read" permission/),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/');
    expect(fake.call.mock.calls.some(([id]) => id === 'efficiency.overview')).toBe(false);
  });
});

describe('[FR-EFF-03] URL state and the model calls', () => {
  it('scopes the page to the case in the URL and writes the choice back', async () => {
    navigateTo('/efficiency?case=case_2');
    const fake = api();
    renderApp(<EfficiencyPage />, { api: fake });
    const spend = await screen.findByRole('group', { name: 'Estimated spend' });
    expect(within(spend).getByText('Case SAMPLE-002')).toBeInTheDocument();
    const overviewCalls = () => fake.call.mock.calls.filter(([id]) => id === 'efficiency.overview');
    expect(overviewCalls()[0]?.[1]).toMatchObject({ query: { caseId: 'case_2' } });

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Scope' }), '');
    await waitFor(() => expect(window.location.search).toBe(''));
    await waitFor(() => expect(overviewCalls().at(-1)?.[1]).toMatchObject({ query: {} }));
  });

  it('asks for the model calls only when their section is opened', async () => {
    navigateTo('/efficiency');
    const user = userEvent.setup();
    const fake = api();
    renderApp(<EfficiencyPage />, { api: fake });
    await screen.findByRole('group', { name: 'Estimated spend' });
    expect(fake.call.mock.calls.some(([id]) => id === 'efficiency.executions')).toBe(false);
    await openSection(user, /^Model calls/);
    await screen.findByRole('table', { name: 'Model calls' });
    expect(fake.call.mock.calls.some(([id]) => id === 'efficiency.executions')).toBe(true);
  });

  it('filters the calls by analysis step through the URL and loads more on request', async () => {
    navigateTo('/efficiency');
    const user = userEvent.setup();
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
    await openSection(user, /^Model calls/);
    const table = await screen.findByRole('table', { name: 'Model calls' });
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(screen.getByText(/Showing 2 calls; more are available/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(4));
    expect(screen.getByText(/Showing 3 calls\./)).toBeInTheDocument();

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Analysis step' }),
      'quality_judge',
    );
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

  it('opens the model calls by itself when the URL names an analysis step', async () => {
    navigateTo('/efficiency?agent=quality_judge');
    renderApp(<EfficiencyPage />, { api: api() });
    expect(await screen.findByRole('table', { name: 'Model calls' })).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Analysis step' })).toHaveValue('quality_judge');
  });

  it('shows each call with its status and checks, and its full record in a drawer', async () => {
    const user = userEvent.setup();
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
    await openSection(user, /^Model calls/);
    const table = await screen.findByRole('table', { name: 'Model calls' });
    expect(within(table).getByText('Rejected by validation')).toBeInTheDocument();
    expect(within(table).getByText('Failed: Citations')).toBeInTheDocument();
    // The issues are in the drawer, not crowding the table.
    expect(screen.queryByText('Citation e99 is not in the evidence set.')).toBeNull();

    await user.click(
      within(table).getByRole('button', { name: 'Details of the Quality Judge call' }),
    );
    const drawer = await screen.findByRole('dialog');
    expect(
      within(drawer).getByText('Citation e99 is not in the evidence set.'),
    ).toBeInTheDocument();
    expect(within(drawer).getByText('Citations: failed')).toBeInTheDocument();
    expect(within(drawer).getByText('Schema: passed')).toBeInTheDocument();
    expect(within(drawer).getByText('Token usage (estimated)')).toBeInTheDocument();
  });
});

describe('[FR-EFF-04] Usage and cost accessibility', () => {
  it('has no axe violations when loaded with every section open', async () => {
    const user = userEvent.setup();
    const { container } = renderApp(<EfficiencyPage />, { api: api() });
    await screen.findByRole('group', { name: 'Estimated spend' });
    for (const name of [
      /^Real process versus a simulated better path/,
      /^Budgets and limits/,
      /^Safety limits/,
      /^Usage by analysis step and model/,
      /^Model calls/,
      /^How to read these figures/,
    ])
      await openSection(user, name);
    await screen.findByRole('table', { name: 'Model calls' });
    await expectNoAxeViolations(container);
  }, 120_000);

  it('has no axe violations in dark mode with a safety limit that is checking again', async () => {
    const user = userEvent.setup();
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
    await openSection(user, /^Safety limits/);
    await screen.findByText('Checking');
    await expectNoAxeViolations(container);
  }, 120_000);

  it('has no axe violations when nothing has run', async () => {
    const { container } = renderApp(<EfficiencyPage />, {
      api: api({
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
      }),
    });
    await screen.findByText('No model calls recorded yet');
    await expectNoAxeViolations(container);
  }, 120_000);
});
