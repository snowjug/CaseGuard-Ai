import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { session } from '../../../test/fixtures';
import {
  expectNoAxeViolations,
  fakeApi,
  renderApp,
  type FakeHandlers,
} from '../../../test/harness';
import { navigateTo, router } from '../../../test/next-navigation';
import {
  CASE_ID,
  FORK_1_AT,
  SCENARIO_ID,
  STEP_1,
  STEP_3,
  caseDetail,
  fork,
  forkList,
  hindsightCheck,
  hypothesesResponse,
  investigationGraph,
  job,
  recordedActions,
  scenario,
  scenarioList,
} from '../../../test/reasoning-fixtures';
import { ApiError } from '../../lib/api/errors';
import { CounterfactualLabPage } from './CounterfactualLabPage';

// The page chains several reads (identity, case, forks, paths, then the section's own); a loaded machine needs room.
configure({ asyncUtilTimeout: 8000 });
vi.setConfig({ testTimeout: 90_000 });

const REVIEWER = ['case:read', 'quality:review', 'fork:review', 'counterfactual:review'] as const;
const ENGINEER = ['case:read', 'counterfactual:run', 'skill:extract'] as const;

type Role = 'reviewer' | 'engineer';

const accepted = (overrides: Record<string, unknown> = {}) =>
  scenario({
    reviewState: 'confirmed',
    reviewReason: 'The path is realistic: every step uses only what was known before the decision.',
    reviewedBy: 'user_riley_reviewer',
    reviewedAt: '2026-10-30T05:07:20.000Z',
    version: 2,
    ...overrides,
  });

function api(overrides: FakeHandlers = {}, role: Role = 'reviewer') {
  return fakeApi({
    'session.me': () =>
      role === 'reviewer' ? session('reviewer', REVIEWER) : session('engineer', ENGINEER),
    'cases.get': () => caseDetail(),
    'forks.list': () => forkList(),
    'counterfactuals.list': () => scenarioList(),
    'actions.list': () => ({ items: recordedActions() }),
    'hypotheses.list': () => hypothesesResponse(),
    'graph.get': () => investigationGraph(),
    'counterfactuals.hindsight': () => hindsightCheck(),
    ...overrides,
  });
}

const renderLab = (handler = api()) =>
  renderApp(<CounterfactualLabPage caseId={CASE_ID} />, { api: handler });

const forkList_ = () => screen.findByRole('list', { name: 'Decision forks in time order' });
const tab = (name: string | RegExp) => screen.getByRole('tab', { name });

const queryOf = (input: unknown): Record<string, string> =>
  (input as { query?: Record<string, string> }).query ?? {};

/** The API's answer for a case (or anything of it) that does not exist. */
const missing = (): never => {
  throw new ApiError({ status: 404, code: 'not_found', title: 'Not found' });
};

// A gated button is replaced by a plain one when the permission check settles, so it is looked up again each time.
async function ready(
  name: string | RegExp,
  scope: HTMLElement = document.body,
): Promise<HTMLElement> {
  await waitFor(() => {
    const button = within(scope).getByRole('button', { name });
    expect(button).not.toHaveAttribute('aria-disabled', 'true');
    expect(button).toBeEnabled();
  });
  return within(scope).getByRole('button', { name });
}

describe('[FR-CF-01] Counterfactual Lab: fork selector', () => {
  it('lists every decision fork in time order with the earliest meaningful one highlighted and its paths counted', async () => {
    const others = scenarioList().items.slice(1);
    renderLab(api({ 'counterfactuals.list': () => ({ items: [accepted(), ...others] }) }));
    const items = within(await forkList_()).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    const [first, second] = items as [HTMLElement, HTMLElement];
    const firstButton = within(first).getByRole('button', {
      name: /Heavy customer request when a lighter ask was available/,
    });
    expect(firstButton).toHaveAttribute('aria-pressed', 'true');
    expect(within(first).getByText('Earliest meaningful')).toBeInTheDocument();
    expect(within(first).getByText('Fork 1 of 2 · 9 Mar 2026, 09:41 UTC')).toBeInTheDocument();
    expect(within(second).queryByText('Earliest meaningful')).toBeNull();
    expect(
      within(second).getByRole('button', {
        name: /Disruptive change made before the cause was established/,
      }),
    ).toHaveAttribute('aria-pressed', 'false');
    expect(within(second).getByText('High severity')).toBeInTheDocument();
    await waitFor(() =>
      expect(within(first).getByText('2 simulated paths · 1 accepted')).toBeInTheDocument(),
    );
    expect(within(second).getByText('1 simulated path')).toBeInTheDocument();
  });

  it('opens the earliest meaningful fork first, labelled as simulation and not history', async () => {
    renderLab();
    expect(
      await screen.findByRole('heading', {
        name: 'Heavy customer request when a lighter ask was available',
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('Simulation, not history')).toBeInTheDocument();
    expect(screen.getAllByText('Simulated').length).toBeGreaterThan(0);
    expect(await screen.findByText('Synthetic')).toBeInTheDocument();
    expect(await screen.findByText('CG-SYN-1001')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /See the hypotheses just before this decision/ }),
    ).toHaveAttribute('href', '/cases/case_1/hypotheses?asOf=2026-03-09T09%3A40%3A59Z');
    expect(
      screen.getByRole('link', { name: /Open the decision event in the timeline/ }),
    ).toHaveAttribute('href', '/cases/case_1/timeline?sel=e03');
    expect(screen.getByRole('link', { name: 'Hypothesis Arena' })).toHaveAttribute(
      'href',
      '/cases/case_1/hypotheses',
    );
  });

  it('switches fork and keeps the choice in the URL', async () => {
    const user = userEvent.setup();
    renderLab();
    await forkList_();
    await user.click(
      screen.getByRole('button', {
        name: /Disruptive change made before the cause was established/,
      }),
    );
    await waitFor(() => expect(window.location.search).toBe('?sel=fork_2'));
    expect(
      await screen.findByRole('heading', {
        name: 'Disruptive change made before the cause was established',
      }),
    ).toBeInTheDocument();
    const strategies = screen.getByRole('tablist', { name: 'Simulated path strategies' });
    expect(within(strategies).getAllByRole('tab')).toHaveLength(1);
  });

  it('opens a scenario, its fork, its section and its step straight from the URL', async () => {
    navigateTo('/?sel=scn_2&tab=evidence&step=cfs_2_b');
    renderLab();
    await forkList_();
    await waitFor(() =>
      expect(tab(/Fastest to diagnosis/)).toHaveAttribute('aria-selected', 'true'),
    );
    expect(tab('Evidence behind each step')).toHaveAttribute('aria-selected', 'true');
    expect(
      await screen.findByRole('heading', {
        name: 'Step 2: Correlate failing attempts with Entra sign-in logs',
      }),
    ).toBeInTheDocument();
  });

  it('says when a fork cannot be simulated', async () => {
    const blocked = fork({
      eligibility: {
        eligible: false,
        boundary: FORK_1_AT,
        checks: [
          {
            id: 'boundary-excludes-future',
            passed: false,
            detail: 'The window leaks a later event.',
          },
        ],
        reasons: ['The window leaks a later event.'],
      },
    });
    renderLab(
      api(
        {
          'forks.list': () => ({ items: [blocked], earliestMeaningfulForkId: 'fork_1' }),
          'counterfactuals.list': () => ({ items: [] }),
        },
        'engineer',
      ),
    );
    expect(await screen.findByText('Not eligible for simulation')).toBeInTheDocument();
    expect(
      await screen.findByText(/This fork cannot be simulated: The window leaks a later event\./),
    ).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Generate simulated paths' })).toBeDisabled();
  });
});

describe('[FR-CF-02] temporal boundary and leak check', () => {
  it('shows the decision instant, how much was known and withheld, and the passed leak check', async () => {
    renderLab();
    const boundary = await screen.findByRole('group', { name: 'Temporal boundary and leak check' });
    expect(within(boundary).getByText('Known as of 9 Mar 2026, 09:41 UTC')).toBeInTheDocument();
    expect(
      await within(boundary).findByRole('img', {
        name: '2 of 31 events were known at the decision instant; 29 later events were withheld',
      }),
    ).toBeInTheDocument();
    expect(await within(boundary).findByText('Leak check passed')).toBeInTheDocument();
    expect(
      within(boundary).getByText(
        /No reference to the future was found\. The final resolution was excluded\./,
      ),
    ).toBeInTheDocument();
    const details = within(boundary).getByRole('list', { name: 'Leak check details' });
    expect(within(details).getAllByRole('listitem')).toHaveLength(3);
    expect(within(boundary).getByText('Validity checks (2 of 2 passed)')).toBeInTheDocument();
  });

  it('says plainly when the leak check failed or the resolution was not excluded', async () => {
    const leaky = scenario({
      boundary: {
        ...scenario().boundary,
        leakCheck: {
          ...scenario().boundary.leakCheck,
          passed: false,
          futureReferencesFound: 2,
          resolutionExcluded: false,
        },
      },
    });
    renderLab(api({ 'counterfactuals.list': () => ({ items: [leaky] }) }));
    const boundary = await screen.findByRole('group', { name: 'Temporal boundary and leak check' });
    expect(await within(boundary).findByText('Leak check failed')).toBeInTheDocument();
    expect(
      within(boundary).getByText(
        /2 references to the future found\. The final resolution was NOT excluded\./,
      ),
    ).toBeInTheDocument();
  });

  it('explains that no leak check exists before a path is generated', async () => {
    renderLab(api({ 'counterfactuals.list': () => ({ items: [] }) }));
    expect(
      await screen.findByText(
        /No simulated path exists for this fork yet, so there is no leak check to show/,
      ),
    ).toBeInTheDocument();
  });
});

describe('[FR-CF-03] actual versus simulated comparison', () => {
  it('draws the recorded path and the simulated alternative diverging at the fork, with estimates labelled', async () => {
    renderLab();
    const figure = await screen.findByRole('figure', {
      name: 'The recorded path and the simulated alternative, from the decision moment',
    });
    expect(within(figure).getByText('Simulated alternative')).toBeInTheDocument();
    expect(within(figure).getByText(/Fork: paths diverge after this step/)).toBeInTheDocument();
    expect(within(figure).getAllByText('Diagnosis reached (simulated)').length).toBeGreaterThan(0);
    expect(within(figure).getAllByText('Diagnosis reached').length).toBeGreaterThan(0);
    expect(
      within(figure).getByRole('group', {
        name: 'Metric differences between actual and simulated paths',
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('Confidence in this comparison: Low (0.25 of 1)')).toBeInTheDocument();
    const improvements = screen.getByRole('list', { name: 'Estimated improvements' });
    expect(within(improvements).getByText('85% less time to diagnosis')).toBeInTheDocument();
    expect(within(improvements).getByText('73% less customer effort')).toBeInTheDocument();
    expect(screen.getByText(/Estimated from 200 seeded simulations/)).toBeInTheDocument();
    expect(
      screen.getByRole('table', { name: 'Actual and simulated measures' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/After step 1: If the result is “Error tag indicates a connection timeout”/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Only the simulated side was generated from what was known at the decision/),
    ).toBeInTheDocument();
  });

  it('shows each strategy’s own wording and steps, never another strategy’s', async () => {
    const user = userEvent.setup();
    const [balanced] = scenarioList().items;
    const fastest = scenario({
      id: 'scn_2',
      strategy: 'fastest_diagnosis',
      label: 'Fastest to diagnosis',
      summary:
        'From 2026-03-09 09:41 UTC, the “Fastest to diagnosis” strategy would take 3 steps and is simulated to reach a diagnosis in about 6 h. Simulated estimate, not a measurement.',
      steps: scenario().steps.map((step) => ({
        ...step,
        scenarioId: 'scn_2',
        id: `${step.id}_b`,
        rationale:
          'Rank 1 under “Fastest to diagnosis”: this step is chosen for its time to a result.',
      })),
    });
    renderLab(
      api({ 'counterfactuals.list': () => ({ items: [balanced as typeof fastest, fastest] }) }),
    );
    expect(
      await screen.findByText(/the “Balanced path” strategy would take 3 steps/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/the “Fastest to diagnosis” strategy would take 3 steps/)).toBeNull();
    await user.click(await screen.findByRole('tab', { name: /Fastest to diagnosis/ }));
    expect(
      await screen.findByText(/the “Fastest to diagnosis” strategy would take 3 steps/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/the “Balanced path” strategy would take 3 steps/)).toBeNull();
    await user.click(tab('Evidence behind each step'));
    expect(
      await screen.findByText(/Rank 1 under “Fastest to diagnosis”: this step is chosen/),
    ).toBeInTheDocument();
  });

  it('only reads the recorded actions the comparison needs', async () => {
    const handler = api();
    renderLab(handler);
    await screen.findByRole('figure', { name: /The recorded path and the simulated alternative/ });
    expect(handler.call).toHaveBeenCalledWith('actions.list', expect.anything());
    expect(handler.call).not.toHaveBeenCalledWith('counterfactuals.hindsight', expect.anything());
  });

  it('offers to generate paths when the fork has none', async () => {
    renderLab(api({ 'counterfactuals.list': () => ({ items: [] }) }, 'engineer'));
    expect(await screen.findByText('No simulated path to show')).toBeInTheDocument();
    expect(
      screen.getByText('No simulated paths have been generated for this fork yet.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate simulated paths' })).toBeEnabled();
  });
});

describe('[FR-CF-04] evidence inspector', () => {
  it('shows the exact evidence behind a simulated step, bounded by the decision instant', async () => {
    const user = userEvent.setup();
    const handler = api();
    renderLab(handler);
    await forkList_();
    await user.click(tab('Evidence behind each step'));
    await waitFor(() => expect(window.location.search).toBe('?tab=evidence'));

    const inspector = await screen.findByRole('group', { name: 'Evidence inspector' });
    expect(within(inspector).getAllByRole('listitem').length).toBeGreaterThanOrEqual(3);
    const detail = within(inspector).getByRole('region', {
      name: 'Step 1 of 3: Ask for minimal scoping data',
    });
    expect(
      within(detail).getByText(
        /Only evidence on record before the decision instant can appear here/,
      ),
    ).toBeInTheDocument();
    expect(await within(detail).findByText('Failures are intermittent')).toBeInTheDocument();
    expect(
      within(detail).getByText(/Teams sign-in failing intermittently for branch users/),
    ).toBeInTheDocument();
    expect(
      within(detail).getByText(
        /Bears on: Egress proxy or TLS-inspection node failure \(supports\)/,
      ),
    ).toBeInTheDocument();
    expect(within(detail).getByRole('link', { name: /Source event e01/ })).toHaveAttribute(
      'href',
      '/cases/case_1/timeline?sel=e01',
    );
    expect(within(detail).getByText(/Error tag is other or not available/)).toBeInTheDocument();
    expect(within(detail).getByText('Simulated')).toBeInTheDocument();

    const reads = handler.call.mock.calls.filter(([route]) => route === 'hypotheses.list');
    expect(reads.length).toBeGreaterThan(0);
    for (const [, input] of reads) expect(queryOf(input)).toEqual({ asOf: FORK_1_AT });
  });

  it('says so when a step cites no case evidence and links to the steps it builds on', async () => {
    const user = userEvent.setup();
    navigateTo(`/?tab=evidence&step=${STEP_3}`);
    renderLab();
    const inspector = await screen.findByRole('group', { name: 'Evidence inspector' });
    const detail = within(inspector).getByRole('region', {
      name: 'Step 3 of 3: Review Conditional Access configuration',
    });
    expect(within(detail).getByText(/This step cites no case evidence\./)).toBeInTheDocument();
    expect(
      within(detail).getByText(/Ask for minimal scoping data; Correlate failing attempts/),
    ).toBeInTheDocument();
    await user.click(
      within(detail).getByRole('button', { name: /Step 1: Ask for minimal scoping data/ }),
    );
    await waitFor(() => expect(window.location.search).toContain(`step=${STEP_1}`));
    expect(
      await screen.findByRole('region', { name: 'Step 1 of 3: Ask for minimal scoping data' }),
    ).toBeInTheDocument();
  });

  it('warns instead of inventing evidence when the decision-time record does not contain what a step cites', async () => {
    navigateTo('/?tab=evidence');
    renderLab(api({ 'hypotheses.list': () => hypothesesResponse({ evidence: [], links: [] }) }));
    expect(await screen.findByText('Not in the record')).toBeInTheDocument();
    expect(
      screen.getByText(/that the decision-time record does not contain: evd_flaky/),
    ).toBeInTheDocument();
  });

  it('shows the evidence failure and keeps the rest of the step', async () => {
    navigateTo('/?tab=evidence');
    renderLab(
      api({
        'hypotheses.list': () => {
          throw new ApiError({ status: 500, code: 'internal_error', title: 'Server error' });
        },
      }),
    );
    expect(await screen.findByText('Evidence unavailable')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /Why the simulation chose it/ }),
    ).toBeInTheDocument();
  });

  it('explains a rate-limited decision-time read calmly, keeps the rest of the step, and recovers with Retry', async () => {
    const user = userEvent.setup();
    navigateTo('/?tab=evidence');
    let attempts = 0;
    const handler = api({
      'hypotheses.list': () => {
        attempts += 1;
        if (attempts === 1)
          throw new ApiError({
            status: 429,
            code: 'rate_limited',
            reason: 'engine_budget',
            title: 'Too many requests',
            retryAfterMs: 1000,
          });
        return hypothesesResponse();
      },
    });
    renderLab(handler);
    expect(await screen.findByText('Earlier views are limited')).toBeInTheDocument();
    expect(screen.getByText(/Computing earlier views is limited/)).toHaveTextContent(
      /the evidence on record at the decision/,
    );
    expect(
      screen.getByRole('heading', { name: /Why the simulation chose it/ }),
    ).toBeInTheDocument();
    expect(handler.call).toHaveBeenCalledWith(
      'hypotheses.list',
      expect.objectContaining({ query: { asOf: FORK_1_AT }, maxRetries: 0 }),
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled(), {
      timeout: 20_000,
    });
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Failures are intermittent')).toBeInTheDocument();
    expect(screen.queryByText('Earlier views are limited')).toBeNull();
  }, 60_000);

  it('shows the same notice on the decision moment when its evidence read is limited', async () => {
    navigateTo('/?tab=decision');
    renderLab(
      api({
        'hypotheses.list': () => {
          throw new ApiError({
            status: 429,
            code: 'rate_limited',
            reason: 'engine_budget',
            title: 'Too many requests',
            retryAfterMs: 30_000,
          });
        },
      }),
    );
    expect(await screen.findByText('Earlier views are limited')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'What was done' })).toBeInTheDocument();
  });

  it('treats a 429 that names another reason as an ordinary failure, whatever its wording says', async () => {
    navigateTo('/?tab=evidence');
    renderLab(
      api({
        'hypotheses.list': () => {
          throw new ApiError({
            status: 429,
            code: 'rate_limited',
            reason: 'provider_throttled',
            title: 'Too many requests',
            message: 'Too many views were recomputed in a short time.',
            retryAfterMs: 30_000,
          });
        },
      }),
    );
    expect(await screen.findByText('Evidence unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Earlier views are limited')).toBeNull();
  });
});

describe('[FR-CF-05] decision moment', () => {
  it('shows what was done, what was known, the alternatives, consequences and eligibility', async () => {
    const user = userEvent.setup();
    renderLab();
    await forkList_();
    await user.click(tab('Decision moment'));
    expect(await screen.findByRole('heading', { name: 'What was done' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Known at that moment' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Not available yet' })).toBeInTheDocument();
    expect(
      screen.getByText(/The final root cause and resolution \(not known at this point\)/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Reasonable alternatives (2)' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Estimated consequences' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'May it be simulated?' })).toBeInTheDocument();
  });
});

describe('[FR-CF-06] reviewer accepts or rejects a simulated path', () => {
  it('requires a reason, sends the version it saw, and shows the accepted decision with an attribution', async () => {
    const user = userEvent.setup();
    let state = scenarioList();
    const handler = api({
      'counterfactuals.list': () => state,
      'counterfactuals.review': (input) => {
        const { body } = input as { body: { decision: string; reason: string } };
        const updated = accepted({
          reviewedBy: 'user_reviewer',
          reviewReason: body.reason,
        });
        state = { items: state.items.map((s) => (s.id === updated.id ? updated : s)) };
        return updated;
      },
    });
    renderLab(handler);
    await forkList_();
    await user.click(tab('Review and SkillDNA'));
    const review = await screen.findByRole('group', { name: 'Review and SkillDNA' });
    expect(within(review).getByText('Awaiting review')).toBeInTheDocument();
    expect(within(review).getByText('Nobody has reviewed this path yet.')).toBeInTheDocument();
    expect(within(review).getByText('Version 1')).toBeInTheDocument();
    expect(within(review).getByText('Two sets of eyes')).toBeInTheDocument();

    await waitFor(() =>
      expect(within(review).getByRole('button', { name: 'Accept this path' })).not.toHaveAttribute(
        'aria-disabled',
        'true',
      ),
    );
    await user.click(within(review).getByRole('button', { name: 'Accept this path' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Accept this simulated path?' });
    await user.click(within(dialog).getByRole('button', { name: 'Accept path' }));
    expect(within(dialog).getByText('Enter at least 5 characters.')).toBeInTheDocument();
    expect(handler.call).not.toHaveBeenCalledWith('counterfactuals.review', expect.anything());

    await user.type(
      within(dialog).getByRole('textbox', { name: /Why is this path realistic\?/ }),
      'Every step uses only what was known.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Accept path' }));
    await waitFor(() =>
      expect(handler.call).toHaveBeenCalledWith(
        'counterfactuals.review',
        expect.objectContaining({
          params: { caseId: CASE_ID, scenarioId: SCENARIO_ID },
          body: {
            decision: 'accept',
            reason: 'Every step uses only what was known.',
            expectedVersion: 1,
          },
        }),
      ),
    );
    expect(await screen.findByText('Path accepted')).toBeInTheDocument();
    expect(await within(review).findByText(/by you on/)).toBeInTheDocument();
    expect(within(review).getByText('“Every step uses only what was known.”')).toBeInTheDocument();
    expect(within(review).getByText('Version 2')).toBeInTheDocument();
    // An accepted path can only be changed to rejected, never "accepted" again.
    expect(
      await within(review).findByRole('button', { name: 'Reject instead' }),
    ).toBeInTheDocument();
    expect(within(review).queryByRole('button', { name: /Accept/ })).toBeNull();
  });

  it('records a rejection with its reason', async () => {
    const user = userEvent.setup();
    const handler = api({
      'counterfactuals.review': () =>
        scenario({ reviewState: 'rejected', reviewReason: 'Step 3 assumes access.', version: 2 }),
    });
    navigateTo('/?tab=review');
    renderLab(handler);
    const review = await screen.findByRole('group', { name: 'Review and SkillDNA' });
    await waitFor(() =>
      expect(within(review).getByRole('button', { name: 'Reject this path' })).not.toHaveAttribute(
        'aria-disabled',
        'true',
      ),
    );
    await user.click(within(review).getByRole('button', { name: 'Reject this path' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Reject this simulated path?' });
    await user.type(
      within(dialog).getByRole('textbox', { name: /Why is this path unrealistic\?/ }),
      'Step 3 assumes access.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Reject path' }));
    await waitFor(() =>
      expect(handler.call).toHaveBeenCalledWith(
        'counterfactuals.review',
        expect.objectContaining({
          body: { decision: 'reject', reason: 'Step 3 assumes access.', expectedVersion: 1 },
        }),
      ),
    );
    expect(await screen.findByText('Path rejected')).toBeInTheDocument();
  });

  /** Opens the accept dialog on the review tab, submits a reason and returns the dialog once the API has refused. */
  async function acceptAndGetRefused(error: ApiError) {
    const user = userEvent.setup();
    const handler = api({
      'counterfactuals.review': () => {
        throw error;
      },
    });
    navigateTo('/?tab=review');
    renderLab(handler);
    const review = await screen.findByRole('group', { name: 'Review and SkillDNA' });
    await waitFor(() =>
      expect(within(review).getByRole('button', { name: 'Accept this path' })).not.toHaveAttribute(
        'aria-disabled',
        'true',
      ),
    );
    const reads = () =>
      handler.call.mock.calls.filter(([route]) => route === 'counterfactuals.list').length;
    const before = reads();
    await user.click(within(review).getByRole('button', { name: 'Accept this path' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Accept this simulated path?' });
    await user.type(
      within(dialog).getByRole('textbox', { name: /Why is this path realistic\?/ }),
      'It looks realistic.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Accept path' }));
    return { dialog, handler, reads, before };
  }

  it('explains a stale path by its version_conflict code, not its wording, and refreshes the path', async () => {
    const { dialog, reads, before } = await acceptAndGetRefused(
      new ApiError({
        status: 409,
        code: 'version_conflict',
        title: 'Version conflict',
        message: 'Some other wording the page must not depend on.',
      }),
    );
    expect(
      await within(dialog).findByText(
        /This path changed after you opened it .* so nothing was recorded\. The newest version is shown now: check it, then decide again\./,
      ),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(/Some other wording/)).toBeNull();
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
  });

  it('explains a four-eyes refusal by its separation_of_duties reason, not its wording', async () => {
    const { dialog } = await acceptAndGetRefused(
      new ApiError({
        status: 403,
        code: 'forbidden',
        reason: 'separation_of_duties',
        title: 'Forbidden',
        message: 'A different person has to take this step.',
      }),
    );
    expect(
      await within(dialog).findByText(
        /The four-eyes rule needs a second person to make this decision, so it was not recorded\. Ask another reviewer to accept or reject this path\. A different person has to take this step\./,
      ),
    ).toBeInTheDocument();
    // The dialog stays open so the reviewer reads why; nothing says the role is missing a permission.
    expect(within(dialog).queryByText(/Your role does not allow this/)).toBeNull();
  });

  it('keeps the generic refusal for a 403 that is not a four-eyes refusal', async () => {
    const { dialog } = await acceptAndGetRefused(
      new ApiError({ status: 403, code: 'forbidden', title: 'Forbidden' }),
    );
    expect(await within(dialog).findByText('Your role does not allow this.')).toBeInTheDocument();
    expect(within(dialog).queryByText(/four-eyes/)).toBeNull();
  });

  it('shows the API explanation when a path cannot be accepted, and refreshes it', async () => {
    const { dialog, reads, before } = await acceptAndGetRefused(
      new ApiError({
        status: 409,
        code: 'conflict',
        title: 'Conflict',
        message: 'This scenario cannot be accepted. It did not pass the temporal leak check.',
      }),
    );
    expect(
      await within(dialog).findByText(
        'This scenario cannot be accepted. It did not pass the temporal leak check.',
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
  });

  it('blocks acceptance of a path that failed the leak check, says why, and still allows a rejection', async () => {
    const leaky = scenario({
      boundary: {
        ...scenario().boundary,
        leakCheck: { ...scenario().boundary.leakCheck, passed: false, futureReferencesFound: 1 },
      },
    });
    navigateTo('/?tab=review');
    renderLab(api({ 'counterfactuals.list': () => ({ items: [leaky] }) }));
    const review = await screen.findByRole('group', { name: 'Review and SkillDNA' });
    expect(await within(review).findByText('Cannot be accepted')).toBeInTheDocument();
    expect(
      within(review).getByText('It did not pass the temporal leak check.'),
    ).toBeInTheDocument();
    expect(within(review).getByRole('button', { name: 'Accept this path' })).toBeDisabled();
    expect(within(review).getByRole('button', { name: 'Reject this path' })).toBeEnabled();
  });

  it('keeps both decisions unavailable, with the reason, for a role that cannot review', async () => {
    const user = userEvent.setup();
    navigateTo('/?tab=review');
    renderLab(api({}, 'engineer'));
    const review = await screen.findByRole('group', { name: 'Review and SkillDNA' });
    const accept = within(review).getByRole('button', { name: 'Accept this path' });
    await waitFor(() => expect(accept).toHaveAttribute('aria-disabled', 'true'));
    await user.click(accept);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await user.hover(accept);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      /does not include the "counterfactual:review" permission/,
    );
    expect(within(review).getByRole('button', { name: 'Reject this path' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('shows an earlier rejection and offers only to accept instead', async () => {
    navigateTo('/?tab=review');
    renderLab(
      api({
        'counterfactuals.list': () => ({
          items: [
            scenario({
              reviewState: 'rejected',
              reviewReason: 'Not realistic.',
              reviewedBy: 'user_other',
              reviewedAt: '2026-10-30T05:10:00.000Z',
              version: 2,
            }),
          ],
        }),
      }),
    );
    const review = await screen.findByRole('group', { name: 'Review and SkillDNA' });
    expect(await within(review).findByText(/by user_other on/)).toBeInTheDocument();
    expect(within(review).getByRole('button', { name: 'Accept instead' })).toBeInTheDocument();
    expect(within(review).queryByRole('button', { name: /Reject/ })).toBeNull();
  });

  it('says a regenerated path is pending again because the analysis changed, and not for a path nobody ever regenerated', async () => {
    navigateTo('/?tab=review');
    const { unmount } = renderLab(
      api({ 'counterfactuals.list': () => ({ items: [scenario({ version: 3 })] }) }),
    );
    const review = await screen.findByRole('group', { name: 'Review and SkillDNA' });
    expect(
      await within(review).findByText('Pending again because the analysis changed'),
    ).toBeInTheDocument();
    expect(
      within(review).getByText('No decision applies to this version of the path yet.'),
    ).toBeInTheDocument();
    expect(within(review).getByText(/it is now version 3/)).toBeInTheDocument();
    expect(within(review).getByText('Version 3')).toBeInTheDocument();
    // Accepting is still possible: the path is a fresh one and needs a new decision.
    await waitFor(() =>
      expect(within(review).getByRole('button', { name: 'Accept this path' })).not.toHaveAttribute(
        'aria-disabled',
        'true',
      ),
    );
    unmount();

    renderLab();
    const fresh = await screen.findByRole('group', { name: 'Review and SkillDNA' });
    expect(
      await within(fresh).findByText('Nobody has reviewed this path yet.'),
    ).toBeInTheDocument();
    expect(within(fresh).queryByText('Pending again because the analysis changed')).toBeNull();
  });
});

describe('[FR-CF-07] Extract SkillDNA', () => {
  it('stays disabled until a reviewer has accepted the path', async () => {
    navigateTo('/?tab=review');
    renderLab(api({}, 'engineer'));
    const review = await screen.findByRole('group', { name: 'Review and SkillDNA' });
    expect(within(review).getByText('Accept the path first')).toBeInTheDocument();
    expect(within(review).getByRole('button', { name: 'Extract SkillDNA' })).toBeDisabled();
  });

  it('extracts a draft skill from the accepted path, shows the job and opens the new skill', async () => {
    const user = userEvent.setup();
    const stage = (id: string, label: string, status: 'pending' | 'running' | 'done') => ({
      id,
      label,
      status,
      startedAt: null,
      completedAt: null,
      detail: null,
    });
    const running = job({
      id: 'job_skill',
      kind: 'skill_extraction',
      status: 'running',
      targetId: SCENARIO_ID,
      resultRef: null,
      completedAt: null,
      cancellable: true,
      progress: {
        percent: 40,
        stage: 'distil',
        stages: [
          stage('distil', 'Distil the accepted path', 'running'),
          stage('save', 'Save the draft skill', 'pending'),
        ],
      },
    });
    const finished = job({
      id: 'job_skill',
      kind: 'skill_extraction',
      targetId: SCENARIO_ID,
      resultRef: { type: 'skill', id: 'skl_9' },
      progress: {
        percent: 100,
        stage: 'save',
        stages: [
          stage('distil', 'Distil the accepted path', 'done'),
          stage('save', 'Save the draft skill', 'done'),
        ],
      },
    });
    // The job stays running until the test has looked at its progress: the finished poll navigates away (as in the app).
    let finish: () => void = () => undefined;
    const finishing = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let polls = 0;
    const handler = api(
      {
        'counterfactuals.list': () => ({ items: [accepted()] }),
        'skills.extract': () => ({ job: running }),
        'jobs.get': async () => {
          if (++polls === 1) return running;
          await finishing;
          return finished;
        },
      },
      'engineer',
    );
    navigateTo('/?tab=review');
    renderLab(handler);
    const review = await screen.findByRole('group', { name: 'Review and SkillDNA' });
    expect(await within(review).findByText(/by user_riley_reviewer on/)).toBeInTheDocument();
    await waitFor(() =>
      expect(within(review).getByRole('button', { name: 'Extract SkillDNA' })).toBeEnabled(),
    );
    expect(within(review).queryByText('Accept the path first')).toBeNull();
    await user.click(within(review).getByRole('button', { name: 'Extract SkillDNA' }));
    await waitFor(() =>
      expect(handler.call).toHaveBeenCalledWith(
        'skills.extract',
        expect.objectContaining({ params: { caseId: CASE_ID }, body: { scenarioId: SCENARIO_ID } }),
      ),
    );
    expect(
      await within(review).findByRole('heading', { level: 3, name: 'Extracting SkillDNA' }),
    ).toBeInTheDocument();
    const steps = await within(review).findByRole('list', { name: 'Steps' });
    const [distil, save] = within(steps).getAllByRole('listitem') as [HTMLElement, HTMLElement];
    expect(distil).toHaveTextContent('In progress: Distil the accepted path');
    expect(save).toHaveTextContent('Waiting: Save the draft skill');
    expect(within(review).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    finish();
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/skills/skl_9'));
    expect(await screen.findByText('Draft SkillDNA created')).toBeInTheDocument();
  });

  it('asks before cancelling a running extraction, then says nothing was created and allows a new one', async () => {
    const user = userEvent.setup();
    const stage = (id: string, label: string, status: 'pending' | 'running') => ({
      id,
      label,
      status,
      startedAt: null,
      completedAt: null,
      detail: null,
    });
    const running = job({
      id: 'job_skill',
      kind: 'skill_extraction',
      status: 'running',
      targetId: SCENARIO_ID,
      resultRef: null,
      completedAt: null,
      cancellable: true,
      progress: {
        percent: 40,
        stage: 'distil',
        stages: [
          stage('distil', 'Distil the accepted path', 'running'),
          stage('save', 'Save the draft skill', 'pending'),
        ],
      },
    });
    const cancelled = job({
      ...running,
      status: 'cancelled',
      cancellable: false,
      completedAt: '2026-10-30T06:00:05.000Z',
    });
    let stopped = false;
    const handler = api(
      {
        'counterfactuals.list': () => ({ items: [accepted()] }),
        'skills.extract': () => ({ job: running }),
        'jobs.get': () => (stopped ? cancelled : running),
        'jobs.cancel': () => {
          stopped = true;
          return cancelled;
        },
      },
      'engineer',
    );
    navigateTo('/?tab=review');
    renderLab(handler);
    const review = await screen.findByRole('group', { name: 'Review and SkillDNA' });
    await user.click(await ready('Extract SkillDNA', review));
    await user.click(await within(review).findByRole('button', { name: 'Cancel' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Cancel this job?' });
    expect(handler.call).not.toHaveBeenCalledWith('jobs.cancel', expect.anything());
    await user.click(within(dialog).getByRole('button', { name: 'Cancel the job' }));
    await waitFor(() =>
      expect(handler.call).toHaveBeenCalledWith(
        'jobs.cancel',
        expect.objectContaining({ params: { jobId: 'job_skill' } }),
      ),
    );
    expect(
      await within(review).findByText(
        'The extraction was cancelled before it finished, so no skill was created.',
      ),
    ).toBeInTheDocument();
    expect(within(review).queryByRole('list', { name: 'Steps' })).toBeNull();
    await waitFor(() =>
      expect(within(review).getByRole('button', { name: 'Extract SkillDNA' })).toBeEnabled(),
    );
    expect(router.push).not.toHaveBeenCalled();
  });

  it('shows the failure of the extraction job where it can be read, and allows a new one', async () => {
    const user = userEvent.setup();
    const failed = job({
      id: 'job_skill',
      kind: 'skill_extraction',
      status: 'failed',
      targetId: SCENARIO_ID,
      resultRef: null,
      error: { code: 'extraction_failed', message: 'The path has no steps to distil.' },
    });
    navigateTo('/?tab=review');
    renderLab(
      api(
        {
          'counterfactuals.list': () => ({ items: [accepted()] }),
          'skills.extract': () => ({ job: failed }),
          'jobs.get': () => failed,
        },
        'engineer',
      ),
    );
    const review = await screen.findByRole('group', { name: 'Review and SkillDNA' });
    await user.click(await ready('Extract SkillDNA', review));
    expect(await within(review).findByText('The skill could not be extracted')).toBeInTheDocument();
    expect(within(review).getByText('The path has no steps to distil.')).toBeInTheDocument();
    await waitFor(() =>
      expect(within(review).getByRole('button', { name: 'Extract SkillDNA' })).toBeEnabled(),
    );
    expect(router.push).not.toHaveBeenCalled();
  });

  it('shows why the skill could not be extracted', async () => {
    const user = userEvent.setup();
    navigateTo('/?tab=review');
    renderLab(
      api(
        {
          'counterfactuals.list': () => ({ items: [accepted()] }),
          'skills.extract': () => {
            throw new ApiError({
              status: 409,
              code: 'conflict',
              title: 'Conflict',
              message: 'This scenario cannot seed a skill.',
              issues: [{ path: 'scenarioId', message: 'Its leak check did not pass.' }],
            });
          },
        },
        'engineer',
      ),
    );
    const review = await screen.findByRole('group', { name: 'Review and SkillDNA' });
    await user.click(await ready('Extract SkillDNA', review));
    expect(await within(review).findByText('The skill could not be extracted')).toBeInTheDocument();
    expect(
      within(review).getByText(/This scenario cannot seed a skill\. Its leak check did not pass\./),
    ).toBeInTheDocument();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('says a skill is already being extracted when the API reports an active job, by its reason', async () => {
    const user = userEvent.setup();
    navigateTo('/?tab=review');
    renderLab(
      api(
        {
          'counterfactuals.list': () => ({ items: [accepted()] }),
          'skills.extract': () => {
            throw new ApiError({
              status: 409,
              code: 'conflict',
              reason: 'job_active',
              title: 'Conflict',
              message: 'Another job is running.',
            });
          },
        },
        'engineer',
      ),
    );
    const review = await screen.findByRole('group', { name: 'Review and SkillDNA' });
    await user.click(await ready('Extract SkillDNA', review));
    expect(await within(review).findByText('The skill could not be extracted')).toBeInTheDocument();
    expect(
      within(review).getByText(
        /A skill is already being extracted for this case\. Wait for that job to finish/,
      ),
    ).toBeInTheDocument();
    expect(within(review).queryByText(/Another job is running/)).toBeNull();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('tells a reviewer who cannot extract skills who can', async () => {
    navigateTo('/?tab=review');
    renderLab(api({ 'counterfactuals.list': () => ({ items: [accepted()] }) }));
    const review = await screen.findByRole('group', { name: 'Review and SkillDNA' });
    expect(await within(review).findByText(/Your role cannot extract skills/)).toBeInTheDocument();
    expect(within(review).getByRole('button', { name: 'Extract SkillDNA' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });
});

describe('[FR-CF-08] generating simulated paths', () => {
  it('generates the missing strategies for the fork and shows the real job progress', async () => {
    const user = userEvent.setup();
    const handler = api(
      {
        'counterfactuals.run': () => ({ job: job({ id: 'job_run', targetId: 'fork_2' }) }),
        'jobs.get': () => job({ id: 'job_run', targetId: 'fork_2' }),
      },
      'engineer',
    );
    navigateTo('/?sel=fork_2');
    renderLab(handler);
    await user.click(await ready('Generate more strategies'));
    const dialog = await screen.findByRole('alertdialog', { name: 'Generate simulated paths' });
    expect(
      within(dialog).getByRole('checkbox', { name: 'Balanced path (already generated)' }),
    ).not.toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: 'Lowest customer effort' })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: 'Fastest to diagnosis' })).toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'Generate' }));
    await waitFor(() =>
      expect(handler.call).toHaveBeenCalledWith(
        'counterfactuals.run',
        expect.objectContaining({
          params: { caseId: CASE_ID, forkId: 'fork_2' },
          body: { strategies: ['lowest_customer_effort', 'fastest_diagnosis'] },
        }),
      ),
    );
    expect(
      await screen.findByRole('heading', { level: 3, name: 'Generating simulated paths' }),
    ).toBeInTheDocument();
    const steps = await screen.findByRole('list', { name: 'Steps' });
    expect(
      within(steps).getByText('Simulate alternative paths from the decision moment').closest('li'),
    ).toHaveTextContent('Done: Simulate alternative paths from the decision moment');
    expect(await screen.findByText('Simulated paths are ready')).toBeInTheDocument();
  });

  it('says simulated paths are already being generated when the API reports an active job, by its reason', async () => {
    const user = userEvent.setup();
    navigateTo('/?sel=fork_2');
    renderLab(
      api(
        {
          'counterfactuals.run': () => {
            throw new ApiError({
              status: 409,
              code: 'conflict',
              reason: 'job_active',
              title: 'Conflict',
              message: 'Another job is running.',
            });
          },
        },
        'engineer',
      ),
    );
    await user.click(await ready('Generate more strategies'));
    const dialog = await screen.findByRole('alertdialog', { name: 'Generate simulated paths' });
    await user.click(within(dialog).getByRole('button', { name: 'Generate' }));
    expect(
      await within(dialog).findByText(
        /Simulated paths are already being generated for this case\. Wait for that job to finish/,
      ),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(/Another job is running/)).toBeNull();
  });

  it('shows the API reasons when a fork cannot be simulated (a conflict without a reason)', async () => {
    const user = userEvent.setup();
    navigateTo('/?sel=fork_2');
    renderLab(
      api(
        {
          'counterfactuals.run': () => {
            throw new ApiError({
              status: 409,
              code: 'conflict',
              title: 'Conflict',
              message: 'This fork cannot be simulated: its leak check could not run.',
            });
          },
        },
        'engineer',
      ),
    );
    await user.click(await ready('Generate more strategies'));
    const dialog = await screen.findByRole('alertdialog', { name: 'Generate simulated paths' });
    await user.click(within(dialog).getByRole('button', { name: 'Generate' }));
    expect(
      await within(dialog).findByText(
        'This fork cannot be simulated: its leak check could not run.',
      ),
    ).toBeInTheDocument();
  });

  it('keeps the action unavailable, with the reason, for a role that cannot run simulations', async () => {
    const user = userEvent.setup();
    navigateTo('/?sel=fork_2');
    renderLab(api({}, 'reviewer'));
    const generate = await screen.findByRole('button', { name: 'Generate more strategies' });
    await waitFor(() => expect(generate).toHaveAttribute('aria-disabled', 'true'));
    await user.hover(generate);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      /does not include the "counterfactual:run" permission/,
    );
  });

  it('shows the job failure message when the simulation fails', async () => {
    const user = userEvent.setup();
    const failed = job({
      id: 'job_bad',
      status: 'failed',
      error: { code: 'simulation_failed', message: 'The simulation could not finish.' },
      cancellable: false,
    });
    renderLab(
      api(
        {
          'counterfactuals.list': () => ({ items: [] }),
          'counterfactuals.run': () => ({ job: failed }),
          'jobs.get': () => failed,
        },
        'engineer',
      ),
    );
    await user.click(await ready('Generate simulated paths'));
    const dialog = await screen.findByRole('alertdialog', { name: 'Generate simulated paths' });
    await user.click(within(dialog).getByRole('button', { name: 'Generate' }));
    expect(await screen.findByText('The job failed')).toBeInTheDocument();
    expect(await screen.findByText('The paths could not be generated')).toBeInTheDocument();
    expect(screen.getAllByText('The simulation could not finish.').length).toBeGreaterThan(0);
  });

  it('says the generation was cancelled, not that it failed, when the job ends cancelled', async () => {
    const user = userEvent.setup();
    const stopped = job({ id: 'job_stop', status: 'cancelled', cancellable: false });
    renderLab(
      api(
        {
          'counterfactuals.list': () => ({ items: [] }),
          'counterfactuals.run': () => ({ job: stopped }),
          'jobs.get': () => stopped,
        },
        'engineer',
      ),
    );
    await user.click(await ready('Generate simulated paths'));
    const dialog = await screen.findByRole('alertdialog', { name: 'Generate simulated paths' });
    await user.click(within(dialog).getByRole('button', { name: 'Generate' }));
    expect(await screen.findByText('Path generation was cancelled')).toBeInTheDocument();
    expect(screen.queryByText('The paths could not be generated')).toBeNull();
  });
});

describe('[FR-CF-09] hindsight is separate from generation', () => {
  it('is locked, and loads nothing from the recorded outcome, for a role without quality review', async () => {
    const handler = api({}, 'engineer');
    renderLab(handler);
    const hindsight = await screen.findByRole('region', {
      name: 'Hindsight (not used to generate)',
    });
    expect(
      await within(hindsight).findByText(/Hindsight is limited to people who review quality/),
    ).toBeInTheDocument();
    expect(within(hindsight).queryByRole('button', { name: /hindsight check/ })).toBeNull();
    expect(handler.call).not.toHaveBeenCalledWith('counterfactuals.hindsight', expect.anything());
  });

  it('is not requested on load and appears only after the reviewer asks, in its own labelled panel', async () => {
    const user = userEvent.setup();
    const handler = api();
    renderLab(handler);
    const hindsight = await screen.findByRole('region', {
      name: 'Hindsight (not used to generate)',
    });
    expect(within(hindsight).getByText('Uses the final resolution')).toBeInTheDocument();
    await forkList_();
    expect(screen.queryByText('hyp.dns-resolution')).toBeNull();
    expect(handler.call).not.toHaveBeenCalledWith('counterfactuals.hindsight', expect.anything());

    const show = await within(hindsight).findByRole('button', { name: 'Show the hindsight check' });
    await waitFor(() => expect(show).toBeEnabled());
    await user.click(show);
    expect(await within(hindsight).findByText('hyp.dns-resolution')).toBeInTheDocument();
    expect(handler.call).toHaveBeenCalledWith(
      'counterfactuals.hindsight',
      expect.objectContaining({ params: { caseId: CASE_ID, scenarioId: SCENARIO_ID } }),
    );
    expect(within(hindsight).getByText('Not consistent')).toBeInTheDocument();
    expect(
      within(hindsight).getByText(
        /Conditional Access or MFA policy enforcement \(66%, simulated\)/,
      ),
    ).toBeInTheDocument();
    expect(
      within(hindsight).getByText(/The simulated path ends leaning towards Conditional Access/),
    ).toBeInTheDocument();
    expect(
      within(hindsight).getByText(/What the recorded step eventually produced:/),
    ).toBeInTheDocument();
    expect(
      within(hindsight).getByRole('button', { name: 'Hide the hindsight check' }),
    ).toHaveAttribute('aria-expanded', 'true');
  });

  it('says it is not available when the API refuses it', async () => {
    const user = userEvent.setup();
    renderLab(
      api({
        'counterfactuals.hindsight': () => {
          throw new ApiError({ status: 403, code: 'forbidden', title: 'Forbidden' });
        },
      }),
    );
    const hindsight = await screen.findByRole('region', {
      name: 'Hindsight (not used to generate)',
    });
    const show = await within(hindsight).findByRole('button', { name: 'Show the hindsight check' });
    await waitFor(() => expect(show).toBeEnabled());
    await user.click(show);
    expect(await within(hindsight).findByText('Not available to your role')).toBeInTheDocument();
  });
});

describe('[FR-CF-10] Investigation Graph integration', () => {
  const nodeOf = (id: string): Element => {
    const node = document.querySelector(`[data-node-id="${id}"]`);
    if (!node) throw new Error(`no graph node ${id}`);
    return node;
  };

  it('requests the graph with the scenario, then with the decision instant, then without a scenario', async () => {
    const user = userEvent.setup();
    const handler = api();
    navigateTo('/?tab=graph');
    renderLab(handler);
    const graph = await screen.findByRole('group', { name: 'Investigation graph' });
    await waitFor(() =>
      expect(handler.call).toHaveBeenCalledWith(
        'graph.get',
        expect.objectContaining({
          params: { caseId: CASE_ID },
          query: { scenarioId: SCENARIO_ID },
        }),
      ),
    );
    expect(await within(graph).findByRole('radio', { name: 'Compare both paths' })).toBeChecked();
    expect(
      await within(graph).findByText('Simulated step: Ask for minimal scoping data', {
        exact: false,
      }),
    ).toBeInTheDocument();

    await user.click(within(graph).getByRole('radio', { name: 'Decision-time view' }));
    await waitFor(() => expect(window.location.search).toContain('mode=counterfactual'));
    await waitFor(() =>
      expect(handler.call).toHaveBeenCalledWith(
        'graph.get',
        expect.objectContaining({ query: { scenarioId: SCENARIO_ID, asOf: FORK_1_AT } }),
      ),
    );

    await user.click(within(graph).getByRole('radio', { name: 'Recorded path only' }));
    await waitFor(() => expect(window.location.search).toContain('mode=actual'));
    await waitFor(() =>
      expect(handler.call).toHaveBeenCalledWith(
        'graph.get',
        expect.objectContaining({ query: {} }),
      ),
    );
  });

  it('opens the details of a selected node with links to the evidence behind it, and jumps to the simulated step', async () => {
    const user = userEvent.setup();
    navigateTo('/?tab=graph');
    renderLab();
    const graph = await screen.findByRole('group', { name: 'Investigation graph' });
    await within(graph).findByRole('radio', { name: 'Compare both paths' });
    await waitFor(() =>
      expect(document.querySelector('[data-node-id="evidence:evd_name"]')).not.toBeNull(),
    );

    fireEvent.click(nodeOf('evidence:evd_name'));
    const details = await screen.findByRole('region', {
      name: 'Details of Client reports a name-resolution failure',
    });
    expect(
      within(details).getByRole('link', { name: /Source event e04|Event e04/ }),
    ).toHaveAttribute('href', '/cases/case_1/timeline?sel=e04');
    expect(window.location.search).toContain('node=evidence%3Aevd_name');
    await user.click(within(details).getByRole('button', { name: 'Close the node details' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: /Details of Client reports/ })).toBeNull(),
    );

    fireEvent.click(nodeOf(`step:${STEP_1}`));
    const step = await screen.findByRole('region', {
      name: 'Details of Ask for minimal scoping data',
    });
    expect(within(step).getByText('Simulated')).toBeInTheDocument();
    await user.click(within(step).getByRole('button', { name: 'Inspect this simulated step' }));
    await waitFor(() => expect(window.location.search).toContain(`step=${STEP_1}`));
    expect(window.location.search).toContain('tab=evidence');
  });

  it('shows the graph error inside its own panel with Retry', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    navigateTo('/?tab=graph');
    renderLab(
      api({
        'graph.get': () => {
          attempts += 1;
          if (attempts === 1)
            throw new ApiError({ status: 500, code: 'internal_error', title: 'Server error' });
          return investigationGraph();
        },
      }),
    );
    expect(
      await screen.findByText('The investigation graph could not be loaded'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Retry/ }));
    expect(await screen.findByRole('radio', { name: 'Compare both paths' })).toBeInTheDocument();
  });

  it('says the decision-time view shows no later reviewer decisions, and the whole-record views do not', async () => {
    const user = userEvent.setup();
    navigateTo('/?tab=graph');
    renderLab();
    const graph = await screen.findByRole('group', { name: 'Investigation graph' });
    await within(graph).findByRole('radio', { name: 'Compare both paths' });
    expect(
      within(graph).queryByText(
        'Reviewer decisions recorded later are not shown in this earlier view.',
      ),
    ).toBeNull();
    await user.click(within(graph).getByRole('radio', { name: 'Decision-time view' }));
    expect(
      await within(graph).findByText(
        'Reviewer decisions recorded later are not shown in this earlier view.',
      ),
    ).toBeInTheDocument();
  });

  it('explains a rate-limited decision-time graph calmly and falls back to the whole record on request', async () => {
    const user = userEvent.setup();
    navigateTo('/?tab=graph&mode=counterfactual');
    const handler = api({
      'graph.get': (input) => {
        if (queryOf(input).asOf)
          throw new ApiError({
            status: 429,
            code: 'rate_limited',
            reason: 'engine_budget',
            title: 'Too many requests',
            retryAfterMs: 30_000,
          });
        return investigationGraph();
      },
    });
    renderLab(handler);
    expect(await screen.findByText('Earlier views are limited')).toBeInTheDocument();
    expect(screen.getByText(/Computing earlier views is limited/)).toHaveTextContent(
      /the decision-time graph/,
    );
    expect(handler.call).toHaveBeenCalledWith(
      'graph.get',
      expect.objectContaining({
        query: { scenarioId: SCENARIO_ID, asOf: FORK_1_AT },
        maxRetries: 0,
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Show the whole record' }));
    expect(await screen.findByRole('radio', { name: 'Compare both paths' })).toBeChecked();
    await waitFor(() => expect(window.location.search).not.toContain('mode='));
    expect(screen.queryByText('Earlier views are limited')).toBeNull();
  });

  it('shows only that the graph is loading while the decision-time view is looked up, none of the graph before it', async () => {
    const user = userEvent.setup();
    navigateTo('/?tab=graph');
    renderLab(
      api({
        'graph.get': (input) =>
          queryOf(input).asOf ? new Promise(() => undefined) : investigationGraph(),
      }),
    );
    const graph = await screen.findByRole('group', { name: 'Investigation graph' });
    await within(graph).findByRole('radio', { name: 'Compare both paths' });
    await waitFor(() =>
      expect(document.querySelector('[data-node-id="evidence:evd_name"]')).not.toBeNull(),
    );
    await user.click(within(graph).getByRole('radio', { name: 'Decision-time view' }));
    expect(await within(graph).findByText(/Loading the investigation graph/)).toBeInTheDocument();
    // Not one node or connection of the whole record stays under the name of the decision-time view.
    expect(document.querySelector('[data-node-id]')).toBeNull();
    expect(
      within(graph).queryByText('Simulated step: Ask for minimal scoping data', { exact: false }),
    ).toBeNull();
    expect(
      within(graph)
        .getByText(/Loading the investigation graph/)
        .closest('[aria-busy="true"]'),
    ).not.toBeNull();
  });

  it('shows only that the graph is loading when another strategy’s path is chosen, none of the first path’s graph', async () => {
    const user = userEvent.setup();
    const [balanced] = scenarioList().items;
    const fastest = scenario({
      id: 'scn_2',
      strategy: 'fastest_diagnosis',
      label: 'Fastest to diagnosis',
      steps: scenario().steps.map((step) => ({
        ...step,
        scenarioId: 'scn_2',
        id: `${step.id}_b`,
      })),
    });
    navigateTo('/?tab=graph');
    renderLab(
      api({
        'counterfactuals.list': () => ({ items: [balanced as typeof fastest, fastest] }),
        'graph.get': (input) =>
          queryOf(input).scenarioId === 'scn_2'
            ? new Promise(() => undefined)
            : investigationGraph(),
      }),
    );
    await screen.findByRole('group', { name: 'Investigation graph' });
    await waitFor(() =>
      expect(document.querySelector('[data-node-id="evidence:evd_name"]')).not.toBeNull(),
    );
    await user.click(await screen.findByRole('tab', { name: /Fastest to diagnosis/ }));
    expect(await screen.findByText(/Loading the investigation graph/)).toBeInTheDocument();
    expect(document.querySelector('[data-node-id]')).toBeNull();
  });

  it('shows only the calm notice, never the graph of the whole record, when the decision-time view is refused, also while Retry waits', async () => {
    const user = userEvent.setup();
    let refused = 0;
    navigateTo('/?tab=graph');
    renderLab(
      api({
        'graph.get': (input) => {
          if (!queryOf(input).asOf) return investigationGraph();
          refused += 1;
          if (refused === 1)
            throw new ApiError({
              status: 429,
              code: 'rate_limited',
              reason: 'engine_budget',
              title: 'Too many requests',
              retryAfterMs: 1000,
            });
          return new Promise(() => undefined);
        },
      }),
    );
    const graph = await screen.findByRole('group', { name: 'Investigation graph' });
    await waitFor(() =>
      expect(document.querySelector('[data-node-id="evidence:evd_name"]')).not.toBeNull(),
    );
    await user.click(within(graph).getByRole('radio', { name: 'Decision-time view' }));
    expect(await screen.findByText('Earlier views are limited')).toBeInTheDocument();
    expect(document.querySelector('[data-node-id]')).toBeNull();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled(), {
      timeout: 20_000,
    });
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/Loading the investigation graph/)).toBeInTheDocument();
    expect(document.querySelector('[data-node-id]')).toBeNull();
    expect(refused).toBe(2);
  }, 60_000);

  it('shows only the recorded path, with a notice, when the fork has no simulated path', async () => {
    navigateTo('/?tab=graph');
    const handler = api({ 'counterfactuals.list': () => ({ items: [] }) });
    renderLab(handler);
    expect(
      await screen.findByText('Recorded path only', { selector: 'p, div, span, h4' }),
    ).toBeInTheDocument();
    expect(await screen.findByRole('radio', { name: 'Compare both paths' })).toBeDisabled();
    expect(handler.call).toHaveBeenCalledWith('graph.get', expect.objectContaining({ query: {} }));
  });
});

describe('[FR-CF-11] Counterfactual Lab states', () => {
  it('explains that a case without decision forks is a good sign, and offers a next step', async () => {
    const { container } = renderLab(
      api({ 'forks.list': () => ({ items: [], earliestMeaningfulForkId: null }) }),
    );
    expect(
      await screen.findByRole('heading', { name: 'No decision forks in this case' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/That is a good sign for this case, not an error\./),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See the hypotheses' })).toHaveAttribute(
      'href',
      '/cases/case_1/hypotheses',
    );
    expect(screen.getByRole('link', { name: 'Open the timeline' })).toHaveAttribute(
      'href',
      '/cases/case_1/timeline',
    );
    await expectNoAxeViolations(container);
  });

  it('shows an error with Retry and recovers', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const { container } = renderLab(
      api({
        'forks.list': () => {
          attempts += 1;
          if (attempts === 1)
            throw new ApiError({
              status: 502,
              code: 'upstream_unavailable',
              title: 'API unavailable',
              correlationId: 'corr-7',
            });
          return forkList();
        },
      }),
    );
    expect(await screen.findByText('The CaseGuard API is not reachable')).toBeInTheDocument();
    expect(screen.getByText('corr-7')).toBeInTheDocument();
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole('button', { name: /Retry/ }));
    expect(
      await screen.findByRole('list', { name: 'Decision forks in time order' }),
    ).toBeInTheDocument();
  });

  it('keeps the page when only the simulated paths fail to load, and recovers with Retry', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    renderLab(
      api({
        'counterfactuals.list': () => {
          attempts += 1;
          if (attempts === 1)
            throw new ApiError({ status: 500, code: 'internal_error', title: 'Server error' });
          return scenarioList();
        },
      }),
    );
    expect(await screen.findByText('The simulated paths could not be loaded')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Decision forks in time order' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Retry/ }));
    expect(
      await screen.findByRole('tablist', { name: 'Simulated path strategies' }),
    ).toBeInTheDocument();
  });

  it('does not offer Retry for a forbidden response', async () => {
    renderLab(
      api({
        'forks.list': () => {
          throw new ApiError({ status: 403, code: 'forbidden', title: 'Forbidden' });
        },
      }),
    );
    expect(await screen.findByText('You do not have access to this')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
  });

  it('says the case cannot be found, with a way back and no Retry, when it does not exist', async () => {
    renderApp(<CounterfactualLabPage caseId="case_gone" />, {
      api: api({ 'cases.get': missing, 'forks.list': missing, 'counterfactuals.list': missing }),
    });
    expect(
      await screen.findByRole('heading', { name: 'We could not find that case' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Browse cases' })).toHaveAttribute('href', '/cases');
    // Not the generic failure of the page, whose Retry could never succeed, and none of the Lab around it.
    expect(screen.queryByText('The Counterfactual Lab could not be loaded')).toBeNull();
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
    expect(screen.queryByText('Simulation, not history')).toBeNull();
    expect(screen.queryByRole('list', { name: 'Decision forks in time order' })).toBeNull();
    // Nothing is left busy: a screen reader would otherwise announce a page that is loading for ever.
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it('does not wait for the forks of a case that does not exist', async () => {
    renderApp(<CounterfactualLabPage caseId="case_gone" />, {
      api: api({ 'cases.get': missing, 'forks.list': () => new Promise<never>(() => undefined) }),
    });
    expect(
      await screen.findByRole('heading', { name: 'We could not find that case' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Loading the decision forks/)).toBeNull();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it('asks for an identity instead of failing when nobody is signed in', async () => {
    const quiet = api();
    renderApp(<CounterfactualLabPage caseId={CASE_ID} />, { api: quiet, persona: null });
    expect(
      await screen.findByRole('heading', { name: 'Choose who you are acting as' }),
    ).toBeInTheDocument();
    expect(quiet.call).not.toHaveBeenCalledWith('forks.list', expect.anything());
  });

  it('registers the case reference as the breadcrumb label', async () => {
    renderLab();
    await forkList_();
    expect(await screen.findByText('CG-SYN-1001')).toBeInTheDocument();
  });
});

describe('[NFR-A11Y] Counterfactual Lab accessibility', () => {
  // axe walks the whole DOM, which is slow in jsdom on a busy machine.
  const SLOW = 120_000;

  it(
    'has no axe violations on the comparison',
    async () => {
      const { container } = renderLab();
      await screen.findByRole('figure', {
        name: /The recorded path and the simulated alternative/,
      });
      await expectNoAxeViolations(container);
    },
    SLOW,
  );

  it(
    'has no axe violations on the evidence inspector',
    async () => {
      navigateTo('/?tab=evidence');
      const { container } = renderLab();
      await within(await screen.findByRole('group', { name: 'Evidence inspector' })).findByText(
        'Failures are intermittent',
      );
      await expectNoAxeViolations(container);
    },
    SLOW,
  );

  it(
    'has no axe violations on the decision moment',
    async () => {
      navigateTo('/?tab=decision');
      const { container } = renderLab();
      await screen.findByRole('heading', { name: 'What was done' });
      await expectNoAxeViolations(container);
    },
    SLOW,
  );

  it(
    'has no axe violations on the review section, or with its dialog open',
    async () => {
      const user = userEvent.setup();
      navigateTo('/?tab=review');
      const { container } = renderLab();
      const review = await screen.findByRole('group', { name: 'Review and SkillDNA' });
      await waitFor(() =>
        expect(
          within(review).getByRole('button', { name: 'Accept this path' }),
        ).not.toHaveAttribute('aria-disabled', 'true'),
      );
      await expectNoAxeViolations(container);
      await user.click(within(review).getByRole('button', { name: 'Accept this path' }));
      const dialog = await screen.findByRole('alertdialog', {
        name: 'Accept this simulated path?',
      });
      await expectNoAxeViolations(dialog);
    },
    SLOW,
  );

  it(
    'has no axe violations in the generate dialog',
    async () => {
      const user = userEvent.setup();
      navigateTo('/?sel=fork_2');
      renderLab(api({}, 'engineer'));
      await user.click(await ready('Generate more strategies'));
      const dialog = await screen.findByRole('alertdialog', { name: 'Generate simulated paths' });
      await expectNoAxeViolations(dialog);
    },
    SLOW,
  );

  it(
    'has no axe violations on the graph with a node selected',
    async () => {
      navigateTo('/?tab=graph&node=step%3Acfs_1');
      const { container } = renderLab();
      await screen.findByRole('region', { name: 'Details of Ask for minimal scoping data' });
      await expectNoAxeViolations(container);
    },
    SLOW,
  );
});
