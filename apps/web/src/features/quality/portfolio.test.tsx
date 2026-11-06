import { SYNTHETIC_EFFECTIVENESS_NOTICE } from '@caseguard/schemas';
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
import { analyticsOverview } from '../../../test/u3-fixtures';
import { ApiError } from '../../lib/api/errors';
import { PortfolioQualityPage } from './PortfolioQualityPage';
import {
  averageQuality,
  formatCount,
  formatPeriod,
  isEveryMonthOneCase,
  optionalRate,
  timeBasisText,
  timeDeltaText,
  trendChange,
  waitingTimeSaved,
} from './portfolio-model';

// A busy machine can take several seconds to settle a chain of requests; assertions stay exact, only the wait is longer.
configure({ asyncUtilTimeout: 15_000 });
vi.setConfig({ testTimeout: 120_000 });

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

// The skill results are a table folded under the figures of "Skills in use".
async function openSkillResults(): Promise<HTMLElement> {
  const skills = await screen.findByRole('group', { name: 'Skills in use' });
  await userEvent.click(within(skills).getByRole('button', { name: /Show results by skill/ }));
  await within(skills).findByRole('table', { name: 'Results by skill' });
  return skills;
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

  it('writes a count as a whole number and leaves the axis tick between two whole numbers blank', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(2)).toBe('2');
    expect(formatCount(12)).toBe('12');
    expect(formatCount(0.5)).toBe('');
    expect(formatCount(1.5)).toBe('');
  });

  it('averages the score over the cases, not over the months', () => {
    expect(averageQuality([])).toBeNull();
    expect(
      averageQuality([
        { period: '2026-03', caseCount: 1, avgQuality: null, avgEvidenceIntegrity: null },
      ]),
    ).toBeNull();
    // Two cases at 80 and one at 50 average 70; an average of the two months (80 and 50) would say 65.
    const trend = [
      { period: '2026-03', caseCount: 2, avgQuality: 80, avgEvidenceIntegrity: 70 },
      { period: '2026-04', caseCount: 1, avgQuality: 50, avgEvidenceIntegrity: 60 },
    ];
    expect(averageQuality(trend)).toEqual({ value: 70, caseCount: 3 });
  });

  it('reports a movement only when there is something to compare', () => {
    const month = (period: string, caseCount: number, avgQuality: number | null) => ({
      period,
      caseCount,
      avgQuality,
      avgEvidenceIntegrity: null,
    });
    // One case a month is not a trend, so no movement is claimed.
    expect(isEveryMonthOneCase([month('2026-03', 1, 36), month('2026-04', 1, 99)])).toBe(true);
    expect(trendChange([month('2026-03', 1, 36), month('2026-04', 1, 99)])).toBeNull();
    expect(trendChange([month('2026-03', 3, 60)])).toBeNull();
    expect(trendChange([month('2026-03', 3, 60), month('2026-04', 2, 54.5)])).toEqual({
      points: -5.5,
      from: '2026-03',
      to: '2026-04',
    });
  });

  it('takes the one time figure the overview has, and never makes up an overall one', () => {
    expect(waitingTimeSaved([])).toBeNull();
    expect(
      waitingTimeSaved([
        { component: 'escalations', label: 'Escalations', avgAvoidablePct: 100, caseCount: 1 },
      ]),
    ).toBeNull();
    expect(
      waitingTimeSaved([
        { component: 'escalations', label: 'Escalations', avgAvoidablePct: 100, caseCount: 1 },
        {
          component: 'waiting_time',
          label: 'Waiting time to diagnosis',
          avgAvoidablePct: 85.1,
          caseCount: 2,
        },
      ]),
    ).toEqual({ pct: 85.1, caseCount: 2 });
  });
});

describe('[FR-QA-02] Quality page', () => {
  it('shows a skeleton, then the sample-size note, the responsible-use notice and every analysis', async () => {
    renderApp(<PortfolioQualityPage />, { api: api() });
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);

    expect(await screen.findByText(/n=2: with so few analysed cases/)).toBeInTheDocument();
    expect(screen.getByText('Small sample')).toBeInTheDocument();
    expect(
      screen.getAllByText(/must not be used to rank, rate or discipline individual employees/)
        .length,
    ).toBeGreaterThan(0);

    const trend = screen.getByRole('group', { name: 'Quality over time' });
    expect(within(trend).getByText('Individual cases, not a trend')).toBeInTheDocument();
    expect(within(trend).getByText('Estimated')).toBeInTheDocument();
    // The numbers behind the chart are one click away, as a table.
    expect(within(trend).queryByRole('table', { name: 'Quality by month opened' })).toBeNull();
    await userEvent.click(within(trend).getByRole('button', { name: /Show the numbers/ }));
    expect(
      await within(trend).findByRole('table', { name: 'Quality by month opened' }),
    ).toBeInTheDocument();

    expect(
      screen.getByRole('img', { name: /Key decisions by category \(5 in total\)/ }),
    ).toBeInTheDocument();
    expect(screen.getByText('Seen 2 times')).toBeInTheDocument();
  });

  it('puts three figures first: cases analysed, average score, time that could have been saved', async () => {
    renderApp(<PortfolioQualityPage />, { api: api() });
    const figure = async (name: string): Promise<HTMLElement> =>
      (await screen.findByRole('heading', { level: 2, name })).closest('div')!.parentElement!;

    const cases = await figure('Cases analysed');
    await waitFor(() => expect(cases).toHaveTextContent(/Cases analysed\s*2/));
    expect(cases).toHaveTextContent('2 cases in this view, 2 of them demo data.');

    // The average is over the cases (36 and 99.1), and the one-case months claim no movement.
    const score = await figure('Average score');
    await waitFor(() => expect(score).toHaveTextContent(/68\s*\/ 100/));
    expect(score).toHaveTextContent('Across 2 cases');
    expect(score).not.toHaveTextContent(/higher than|lower than/);

    const saved = await figure('Time that could have been saved');
    await waitFor(() => expect(saved).toHaveTextContent(/85%\s*of waiting time/));
    expect(saved).toHaveTextContent('Based on 1 case with an estimate');
    expect(within(saved).getByText('Estimated')).toBeInTheDocument();
    expect(within(saved).getByText('Simulated')).toBeInTheDocument();
  });

  it('says the time figure is missing when no case has one, rather than showing another number', async () => {
    renderApp(<PortfolioQualityPage />, {
      api: api({
        'analytics.overview': () => analyticsOverview({ avoidableEffortPatterns: [] }),
      }),
    });
    const heading = await screen.findByRole('heading', {
      level: 2,
      name: 'Time that could have been saved',
    });
    const card = heading.closest('div')!.parentElement!;
    expect(card).toHaveTextContent('—');
    expect(card).toHaveTextContent(/Needs an analysed case with a key decision/);
    expect(card).not.toHaveTextContent('%');
  });

  it('is one page with one heading, no primary button, the technical words in help and the tables folded', async () => {
    renderApp(<PortfolioQualityPage />, { api: api() });
    await screen.findByRole('group', { name: 'Quality over time' });
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Quality' })).toBeInTheDocument();
    // The plain names; the technical ones (cohort, adoption, effectiveness, decision fork) live in the help popovers.
    for (const name of [
      'Where a better step was available',
      'Evidence most often missing',
      'Where effort could be saved',
      'Skills in use',
      'Analysis usage',
      'Better paths reviewers accepted',
      'Reviewer corrections',
      'Assumptions without evidence',
      'Privacy and how to read this page',
    ]) {
      expect(screen.getByRole('group', { name }), name).toBeInTheDocument();
    }
    expect(screen.queryByText(/cohort|adoption|effectiveness|decision fork/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'About Cases analysed' })).toBeInTheDocument();
    // Tables are folded: the two readable ones are not in the page until their accordion is opened.
    expect(screen.queryByRole('table', { name: 'Quality by month opened' })).toBeNull();
    expect(screen.queryByRole('table', { name: 'Results by skill' })).toBeNull();
  });

  it('refreshes on request and says how old the figures are', async () => {
    const fake = api();
    renderApp(<PortfolioQualityPage />, { api: fake });
    await screen.findByRole('group', { name: 'Quality over time' });
    const reads = (): number =>
      fake.call.mock.calls.filter(([id]) => id === 'analytics.overview').length;
    expect(screen.getByText(/Updated/)).toBeInTheDocument();
    const before = reads();
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
  });

  it('labels time that could be saved as estimated and simulated, and skill results as demo data', async () => {
    renderApp(<PortfolioQualityPage />, { api: api() });
    const effort = await screen.findByRole('group', { name: 'Where effort could be saved' });
    expect(within(effort).getByText('Estimated')).toBeInTheDocument();
    expect(within(effort).getAllByText('Simulated').length).toBeGreaterThan(0);

    const skills = await openSkillResults();
    const table = within(skills).getByRole('table', { name: 'Results by skill' });
    expect(
      within(table).getByRole('link', { name: 'Isolate a pre-authentication failure' }),
    ).toHaveAttribute('href', '/skills/skl_1');
    expect(within(table).getByText('93.9% faster')).toBeInTheDocument();
    expect(within(table).getByText('vs the case it came from')).toBeInTheDocument();
    expect(within(table).getByText('Estimated')).toBeInTheDocument();
    expect(within(table).getByText('Demo data')).toBeInTheDocument();
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
    const skills = await openSkillResults();
    const table = within(skills).getByRole('table', { name: 'Results by skill' });
    const rowOf = (name: string): HTMLElement =>
      within(table).getByRole('link', { name }).closest('tr') as HTMLElement;

    const earlier = rowOf('Isolate a pre-authentication failure');
    expect(within(earlier).getByText('93.9% faster')).toBeInTheDocument();
    expect(within(earlier).getByText('vs the case it came from')).toBeInTheDocument();
    expect(within(earlier).getByText('Estimated')).toBeInTheDocument();
    expect(within(earlier).getByText('Demo data')).toBeInTheDocument();

    const simulated = rowOf('Check the client trace first');
    expect(within(simulated).getByText('49.6% slower')).toBeInTheDocument();
    expect(within(simulated).getByText('vs a simulated baseline')).toBeInTheDocument();

    // No basis and no figure: nothing to compare, no caption to claim otherwise and nothing to call an estimate.
    const missing = rowOf('Reset the sign-in token cache');
    expect(within(missing).getByText('Not enough data')).toBeInTheDocument();
    expect(within(missing).queryByText(/^vs /)).toBeNull();
    expect(within(missing).queryByText('Estimated')).toBeNull();
    expect(within(missing).getByText('Demo data')).toBeInTheDocument();

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
    const skills = await openSkillResults();
    const table = within(skills).getByRole('table', { name: 'Results by skill' });
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
    expect(screen.getByRole('link', { name: 'Add a case' })).toHaveAttribute('href', '/cases/new');
    expect(screen.getByRole('link', { name: 'Try a sample case' })).toHaveAttribute(
      'href',
      '/cases/new?mode=sample',
    );
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
      'The quality trends could not be loaded',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('group', { name: 'Quality over time' })).toBeInTheDocument();
  });

  it('keeps the way into a single score for a role without analytics access, and says why the portfolio is not theirs', async () => {
    const fake = api({ 'session.me': () => session('engineer', ['case:read', 'quality:read']) });
    renderApp(<PortfolioQualityPage />, { api: fake });
    expect(
      await screen.findByText('You do not have access to quality trends across all cases'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/does not include the "analytics:read" permission/),
    ).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Choose a case' })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Open score of CG-SYN-1001' })).toHaveAttribute(
      'href',
      '/cases/case_1/quality',
    );
    // The figures are not theirs, and neither is the refresh of them.
    expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull();
    expect(fake.call.mock.calls.some(([id]) => id === 'analytics.overview')).toBe(false);
  });

  it('explains a role with neither analytics nor quality access and makes no request', async () => {
    const fake = api({ 'session.me': () => session('skill_curator', ['case:read', 'skill:read']) });
    renderApp(<PortfolioQualityPage />, { api: fake });
    expect(await screen.findByText('You do not have access to quality trends')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Choose a case' })).toBeNull();
    expect(fake.call.mock.calls.some(([id]) => id === 'analytics.overview')).toBe(false);
  });

  it('links to the score of an analysed case, chosen explicitly', async () => {
    renderApp(<PortfolioQualityPage />, { api: api() });
    await screen.findByRole('group', { name: 'Quality over time' });
    const select = screen.getByRole('combobox', { name: 'Choose a case' });
    // The case that has not been analysed has no score to open.
    expect(within(select).queryByText(/CG-SYN-1003/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Open score of CG-SYN-1001' })).toHaveAttribute(
      'href',
      '/cases/case_1/quality',
    );
    // The link says "Open score" to the eye and names the case to a screen reader.
    expect(screen.getByRole('link', { name: 'Open score of CG-SYN-1001' })).toHaveTextContent(
      /^Open score of CG-SYN-1001$/,
    );
    await userEvent.selectOptions(select, 'case_2');
    expect(screen.getByRole('link', { name: 'Open score of CG-SYN-1002' })).toHaveAttribute(
      'href',
      '/cases/case_2/quality',
    );
  });
});

describe('[FR-QA-03] Quality page accessibility', () => {
  it('has no axe violations when loaded', async () => {
    const { container } = renderApp(<PortfolioQualityPage />, { api: api() });
    await screen.findByRole('group', { name: 'Quality over time' });
    await expectNoAxeViolations(container);
  }, 120_000);

  it('has no axe violations with the tables opened, in dark mode with missing data', async () => {
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
    const trend = await screen.findByRole('group', { name: 'Quality over time' });
    await userEvent.click(within(trend).getByRole('button', { name: /Show the numbers/ }));
    await openSkillResults();
    await expectNoAxeViolations(container);
  }, 120_000);
});
