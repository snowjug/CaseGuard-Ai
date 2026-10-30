import { SYNTHETIC_EFFECTIVENESS_NOTICE } from '@caseguard/schemas';
import { configure, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { caseSummary, session } from '../../../test/fixtures';
import {
  expectNoAxeViolations,
  fakeApi,
  renderApp,
  type FakeHandlers,
} from '../../../test/harness';
import { analyticsOverview } from '../../../test/u3-fixtures';
import { ApiError } from '../../lib/api/errors';
import { PortfolioQualityPage } from './PortfolioQualityPage';
import { formatPeriod, optionalRate, timeBasisText, timeDeltaText } from './portfolio-model';

// A busy machine can take several seconds to settle a chain of requests; assertions stay exact, only the wait is longer.
configure({ asyncUtilTimeout: 5000 });

function api(overrides: FakeHandlers = {}) {
  return fakeApi({
    'session.me': () => session('manager', ['case:read', 'analytics:read', 'quality:read']),
    'cases.list': () => ({
      items: [
        caseSummary({ id: 'case_1', reference: 'CG-SYN-1001' }),
        caseSummary({ id: 'case_2', reference: 'CG-SYN-1002', title: 'Rotterdam site' }),
        caseSummary({ id: 'case_3', reference: 'CG-SYN-1003', analysisState: 'not_analyzed' }),
      ],
      nextCursor: null,
    }),
    'analytics.overview': () => analyticsOverview(),
    ...overrides,
  });
}

describe('[FR-QA-01] Portfolio analytics model helpers', () => {
  it('names months and keeps any other bucket label', () => {
    expect(formatPeriod('2026-03')).toBe('Mar 2026');
    expect(formatPeriod('2026-03-02 (week)')).toBe('2026-03-02 (week)');
  });

  it('says whether time to diagnosis got faster or slower, and never invents a figure', () => {
    expect(timeDeltaText(25)).toBe('25.0% faster than the baseline');
    expect(timeDeltaText(-49.6)).toBe('49.6% slower than the baseline');
    expect(timeDeltaText(0)).toBe('No change from the baseline');
    expect(timeDeltaText(null)).toBe('Not enough data');
  });

  it('names what the time to diagnosis is compared with when the API says so', () => {
    expect(timeDeltaText(93.9, 'earlier_case')).toBe('93.9% faster');
    expect(timeDeltaText(-49.6, 'simulated_baseline')).toBe('49.6% slower');
    expect(timeDeltaText(0, 'earlier_case')).toBe('No change');
    expect(timeDeltaText(null, 'earlier_case')).toBe('Not enough data');
    expect(timeBasisText('earlier_case')).toBe('vs the case it came from');
    expect(timeBasisText('simulated_baseline')).toBe('vs a simulated baseline');
    expect(timeBasisText(undefined)).toBeNull();
  });

  it('keeps an absent rate absent', () => {
    expect(optionalRate(null, 'No rate yet')).toBe('No rate yet');
    expect(optionalRate(0.5, 'x')).toBe('50%');
  });
});

describe('[FR-QA-02] Portfolio analytics page', () => {
  it('shows a skeleton, then the cohort note, the responsible-use notice and every analysis', async () => {
    renderApp(<PortfolioQualityPage />, { api: api() });
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);

    const cohort = await screen.findByRole('group', { name: 'Cohort' });
    expect(within(cohort).getByText(/n=2: with so few analysed cases/)).toBeInTheDocument();
    expect(within(cohort).getByText('Small sample')).toBeInTheDocument();
    expect(
      screen.getAllByText(/must not be used to rank, rate or discipline individual employees/)
        .length,
    ).toBeGreaterThan(0);

    const trend = screen.getByRole('group', { name: 'Quality over time' });
    expect(within(trend).getByText('Individual cases, not a trend')).toBeInTheDocument();
    expect(
      within(trend).getByRole('table', { name: 'Quality by month opened' }),
    ).toBeInTheDocument();
    expect(within(trend).getByText('Estimated')).toBeInTheDocument();

    expect(
      screen.getByRole('img', { name: /Decision forks by category \(5 in total\)/ }),
    ).toBeInTheDocument();
    expect(screen.getByText('Seen 2 times')).toBeInTheDocument();
  });

  it('labels avoidable effort as estimated and simulated, and skill effectiveness as synthetic', async () => {
    renderApp(<PortfolioQualityPage />, { api: api() });
    const effort = await screen.findByRole('group', { name: 'Avoidable-effort patterns' });
    expect(within(effort).getByText('Estimated')).toBeInTheDocument();
    expect(within(effort).getAllByText('Simulated').length).toBeGreaterThan(0);

    const skills = screen.getByRole('group', { name: 'SkillDNA adoption and effectiveness' });
    const table = within(skills).getByRole('table', { name: 'Skill effectiveness' });
    expect(
      within(table).getByRole('link', { name: 'Isolate a pre-authentication failure' }),
    ).toHaveAttribute('href', '/skills/skl_1');
    expect(within(table).getByText('93.9% faster')).toBeInTheDocument();
    expect(within(table).getByText('vs the case it came from')).toBeInTheDocument();
    expect(within(table).getByText('Estimated')).toBeInTheDocument();
    expect(within(table).getByText('Synthetic')).toBeInTheDocument();
    expect(within(skills).getByText(SYNTHETIC_EFFECTIVENESS_NOTICE)).toBeInTheDocument();
  });

  it('names what each skill’s time to diagnosis is compared with: the case it came from or a simulated baseline', async () => {
    renderApp(<PortfolioQualityPage />, {
      api: api({
        'analytics.overview': () =>
          analyticsOverview({
            skillAdoption: {
              totalSkills: 3,
              published: 2,
              pilotOrValidated: 1,
              matchedCases: 4,
              appliedCases: 4,
            },
            skillEffectiveness: [
              {
                skillId: 'skl_1',
                name: 'Isolate a pre-authentication failure',
                applications: 2,
                timeToDiagnosisDeltaPct: 93.9,
                timeToDiagnosisBasis: 'earlier_case',
                synthetic: true,
              },
              {
                skillId: 'skl_2',
                name: 'Check the client trace first',
                applications: 1,
                timeToDiagnosisDeltaPct: -49.6,
                timeToDiagnosisBasis: 'simulated_baseline',
                synthetic: true,
              },
              {
                skillId: 'skl_3',
                name: 'Reset the sign-in token cache',
                applications: 1,
                timeToDiagnosisDeltaPct: null,
                synthetic: true,
              },
            ],
          }),
      }),
    });
    const skills = await screen.findByRole('group', {
      name: 'SkillDNA adoption and effectiveness',
    });
    const table = within(skills).getByRole('table', { name: 'Skill effectiveness' });
    const rowOf = (name: string): HTMLElement =>
      within(table).getByRole('link', { name }).closest('tr') as HTMLElement;

    const earlier = rowOf('Isolate a pre-authentication failure');
    expect(within(earlier).getByText('93.9% faster')).toBeInTheDocument();
    expect(within(earlier).getByText('vs the case it came from')).toBeInTheDocument();
    expect(within(earlier).getByText('Estimated')).toBeInTheDocument();
    expect(within(earlier).getByText('Synthetic')).toBeInTheDocument();

    const simulated = rowOf('Check the client trace first');
    expect(within(simulated).getByText('49.6% slower')).toBeInTheDocument();
    expect(within(simulated).getByText('vs a simulated baseline')).toBeInTheDocument();

    // No basis and no figure: nothing to compare, no caption to claim otherwise and nothing to call an estimate.
    const missing = rowOf('Reset the sign-in token cache');
    expect(within(missing).getByText('Not enough data')).toBeInTheDocument();
    expect(within(missing).queryByText(/^vs /)).toBeNull();
    expect(within(missing).queryByText('Estimated')).toBeNull();
    expect(within(missing).getByText('Synthetic')).toBeInTheDocument();

    // The labels sit with the figure they qualify: a column of badges alone is cut to a few pixels on a phone.
    expect(within(table).queryByRole('columnheader', { name: 'Data' })).toBeNull();

    // The note says what each basis means, once, under the table.
    expect(
      within(skills).getByText(
        /compared with the recorded path of the case each skill came from where there is one/,
      ),
    ).toBeInTheDocument();
    expect(
      within(skills).getByText(/no waiting between steps, so recorded times read longer/),
    ).toBeInTheDocument();
  });

  it('keeps the older wording, and claims no basis, when the API sends a figure without one', async () => {
    renderApp(<PortfolioQualityPage />, {
      api: api({
        'analytics.overview': () =>
          analyticsOverview({
            skillEffectiveness: [
              {
                skillId: 'skl_1',
                name: 'Isolate a pre-authentication failure',
                applications: 1,
                timeToDiagnosisDeltaPct: -49.6,
                synthetic: true,
              },
            ],
          }),
      }),
    });
    const skills = await screen.findByRole('group', {
      name: 'SkillDNA adoption and effectiveness',
    });
    const table = within(skills).getByRole('table', { name: 'Skill effectiveness' });
    expect(within(table).getByText('49.6% slower than the baseline')).toBeInTheDocument();
    expect(within(table).queryByText(/^vs /)).toBeNull();
    expect(
      within(skills).queryByText(/compared with the recorded path of the case each skill/),
    ).toBeNull();
  });

  it('states missing data as missing: no rate, no reviews, no gaps', async () => {
    renderApp(<PortfolioQualityPage />, {
      api: api({
        'analytics.overview': () =>
          analyticsOverview({
            missingEvidence: [],
            tokenEfficiency: { avgBitsPer1kTokens: null, avgEstimatedSavingsPct: null },
            counterfactualAcceptance: { reviewed: 0, accepted: 0, rejected: 0, rate: null },
            reviewerDisagreement: { reviewedClaims: 0, corrected: 0, rate: null },
            skillAdoption: {
              totalSkills: 0,
              published: 0,
              pilotOrValidated: 0,
              matchedCases: 0,
              appliedCases: 0,
            },
            skillEffectiveness: [],
            frequentUnsupportedAssumptions: [],
          }),
      }),
    });
    expect(await screen.findByText('No evidence gap found')).toBeInTheDocument();
    expect(screen.getAllByText('Not enough data')).toHaveLength(2);
    expect(screen.getByText(/No simulated path has been reviewed yet/)).toBeInTheDocument();
    expect(screen.getByText(/No claim has been reviewed yet/)).toBeInTheDocument();
    expect(screen.getByText('No skills yet')).toBeInTheDocument();
    expect(screen.getByText('No unsupported assumption found')).toBeInTheDocument();
  });

  it('shows an empty state with a next action when no case has been analysed', async () => {
    renderApp(<PortfolioQualityPage />, {
      api: api({
        'analytics.overview': () =>
          analyticsOverview({
            cohort: { caseCount: 1, analyzedCaseCount: 0, syntheticCaseCount: 1, note: 'n=0' },
          }),
      }),
    });
    expect(await screen.findByText('No analysed cases yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Cases' })).toHaveAttribute('href', '/cases');
  });

  it('shows an error with Retry and recovers', async () => {
    let attempts = 0;
    renderApp(<PortfolioQualityPage />, {
      api: api({
        'analytics.overview': () => {
          attempts += 1;
          if (attempts === 1)
            throw new ApiError({
              status: 500,
              code: 'internal',
              title: 'Internal error',
              message: 'Boom',
            });
          return analyticsOverview();
        },
      }),
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The portfolio analytics could not be loaded',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('group', { name: 'Cohort' })).toBeInTheDocument();
  });

  it('keeps the way into a single review for a role without analytics access, and says why the portfolio is not theirs', async () => {
    const fake = api({ 'session.me': () => session('engineer', ['case:read', 'quality:read']) });
    renderApp(<PortfolioQualityPage />, { api: fake });
    expect(
      await screen.findByText('You do not have access to portfolio analytics'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/does not include the "analytics:read" permission/),
    ).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Review a case' })).toBeInTheDocument();
    expect(
      await screen.findByRole('link', { name: 'Open the review of CG-SYN-1001' }),
    ).toHaveAttribute('href', '/cases/case_1/quality');
    expect(fake.call.mock.calls.some(([id]) => id === 'analytics.overview')).toBe(false);
  });

  it('explains a role with neither analytics nor quality access and makes no request', async () => {
    const fake = api({ 'session.me': () => session('skill_curator', ['case:read', 'skill:read']) });
    renderApp(<PortfolioQualityPage />, { api: fake });
    expect(await screen.findByText('You do not have access to Quality Review')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Review a case' })).toBeNull();
    expect(fake.call.mock.calls.some(([id]) => id === 'analytics.overview')).toBe(false);
  });

  it('links to the review of an analysed case, chosen explicitly', async () => {
    renderApp(<PortfolioQualityPage />, { api: api() });
    await screen.findByRole('group', { name: 'Cohort' });
    const select = screen.getByRole('combobox', { name: 'Review a case' });
    // The case that has not been analysed has no review to open.
    expect(within(select).queryByText(/CG-SYN-1003/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Open the review of CG-SYN-1001' })).toHaveAttribute(
      'href',
      '/cases/case_1/quality',
    );
    await userEvent.selectOptions(select, 'case_2');
    expect(screen.getByRole('link', { name: 'Open the review of CG-SYN-1002' })).toHaveAttribute(
      'href',
      '/cases/case_2/quality',
    );
  });
});

describe('[FR-QA-03] Portfolio analytics accessibility', () => {
  it('has no axe violations when loaded', async () => {
    const { container } = renderApp(<PortfolioQualityPage />, { api: api() });
    await screen.findByRole('group', { name: 'Cohort' });
    await expectNoAxeViolations(container);
  }, 120_000);

  it('has no axe violations in dark mode with missing data', async () => {
    const { container } = renderApp(<PortfolioQualityPage />, {
      mode: 'dark',
      api: api({
        'analytics.overview': () =>
          analyticsOverview({
            tokenEfficiency: { avgBitsPer1kTokens: null, avgEstimatedSavingsPct: null },
            counterfactualAcceptance: { reviewed: 0, accepted: 0, rejected: 0, rate: null },
          }),
      }),
    });
    await screen.findByRole('group', { name: 'Cohort' });
    await expectNoAxeViolations(container);
  }, 120_000);
});
