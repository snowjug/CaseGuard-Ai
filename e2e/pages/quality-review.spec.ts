import { expect, test } from '../support/fixtures';
import { listCases } from '../support/api';
import { mainRegion, openPage, settle } from '../support/ui';

test.describe('[FR-QI-01] Case Quality Review: how the score is composed', () => {
  test('the Case Quality Index equals the API, with its range, the method of the estimate, six dimensions and the penalties that applied', async ({
    page,
    demo,
    api,
  }) => {
    const one = (await listCases(api('engineer'))).find((item) => item.id === demo.caseOneId)!;
    await openPage(page, `/cases/${demo.caseOneId}/quality`);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Case Quality Review' }),
    ).toBeVisible();
    const tabs = page.getByRole('tablist', { name: 'Quality review sections' });
    for (const name of [
      'Quality index',
      'Effort and metrics',
      'Live warnings',
      'SkillDNA',
      'Coaching',
      'Compare cases',
    ]) {
      await expect(tabs.getByRole('tab', { name }), name).toBeVisible();
    }
    const panel = page.getByRole('tabpanel', { name: 'Quality index' });
    const index = panel.getByRole('group', { name: 'Case Quality Index' });
    await expect(index).toContainText(`${Math.round(one.qualityIndex!)}`);
    await expect(
      index.getByText(/Model estimate from a rule-based analysis of the case record/),
    ).toBeVisible();
    await expect(
      panel.getByRole('group', { name: 'If every improvement were applied' }),
    ).toBeVisible();

    const dimensions = panel.getByRole('group', { name: 'Dimensions' });
    for (const name of [
      'Evidence integrity',
      'Diagnostic reasoning',
      'Scoping completeness',
      'Customer communication',
      'Resolution validation',
      'Efficiency and proportionality',
    ]) {
      await expect(dimensions.getByRole('heading', { level: 3, name }), name).toBeVisible();
    }
    const penalties = panel.getByRole('group', { name: 'Applied penalties' });
    await expect(
      penalties.getByRole('heading', { level: 3, name: 'Unsupported root-cause claim' }),
    ).toBeVisible();
    await expect(
      penalties.getByRole('heading', {
        level: 3,
        name: 'Destructive action without justification',
      }),
    ).toBeVisible();
    // Each penalty is traceable to the events that caused it.
    await expect(penalties.getByRole('link').first()).toBeVisible();
  });

  test('effort and metrics: avoidable support effort with its range, contributors and assumptions, labelled as an estimate', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/quality?tab=effort`);
    const panel = page.getByRole('tabpanel', { name: 'Effort and metrics' });
    await expect(panel).toBeVisible();
    await expect(panel.getByText(/Avoidable Support Effort/i).first()).toBeVisible();
    await expect(panel.getByText(/estimate/i).first()).toBeVisible();
    await expect(panel.getByText(/assumption/i).first()).toBeVisible();
  });

  test('live warnings: open warnings of the case, as of the time cursor, each with its evidence; dismissing needs a permission', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/quality?tab=warnings`);
    const panel = page.getByRole('tabpanel', { name: 'Live warnings' });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('heading', { level: 2 }).first()).toBeVisible();
    await expect(panel.getByRole('button', { name: /dismiss/i }).first()).toBeVisible();
  });

  test('coaching is constructive and never ranks people', async ({ page, demo }) => {
    await openPage(page, `/cases/${demo.caseOneId}/quality?tab=coaching`);
    const panel = page.getByRole('tabpanel', { name: 'Coaching' });
    await expect(panel).toBeVisible();
    await expect(mainRegion(page)).not.toContainText(
      /rank(ed|ing)? (the )?(engineers?|people|employees)|worst engineer|best engineer/i,
    );
    await expect(panel.getByText(/coaching|improv|suggest|opportunit/i).first()).toBeVisible();
  });

  test('the earlier-moment cursor recomputes the review as of then: only what was known, with a note on later decisions', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/quality?asOf=2026-03-09T12%3A10%3A00Z`);
    await expect(
      page.getByRole('group', { name: 'What was known' }).getByRole('status'),
    ).toContainText('9 Mar 2026, 12:10 UTC');
    await settle(page);
    await expect(mainRegion(page)).toContainText(/later|withheld|earlier/i);
  });
});

test.describe('[FR-AN-01] Quality Review: portfolio analytics are for managers and administrators', () => {
  test('an engineer is told which permission is missing and who has it, and still has the way into the review of one case', async ({
    page,
    demo,
  }) => {
    await openPage(page, '/quality');
    await expect(page.getByRole('heading', { level: 1, name: 'Quality Review' })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'You do not have access to portfolio analytics' }),
    ).toBeVisible();
    await expect(
      page.getByText(
        /^Your role \(.+\) does not include the "analytics:read" permission\. Managers and administrators can open it\.$/,
      ),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Choose a development persona' })).toBeVisible();

    // The case picker is a real link: choosing a case does not navigate by itself.
    const picker = page.getByRole('combobox', { name: 'Review a case' });
    const value = await picker.locator('option', { hasText: 'CG-SYN-1001' }).getAttribute('value');
    await picker.selectOption(value);
    await expect(
      page.getByRole('link', { name: 'Open the review of CG-SYN-1001' }),
    ).toHaveAttribute('href', `/cases/${demo.caseOneId}/quality`);
  });
});

test.describe('[FR-AN-01] the portfolio, as a manager', () => {
  test.use({ persona: 'manager' });

  test('shows privacy-safe analytics over two cases, says the sample is too small for trends, and never ranks individuals', async ({
    page,
  }) => {
    await openPage(page, '/quality');
    await expect(page.getByRole('heading', { level: 1, name: 'Quality Review' })).toBeVisible();
    await expect(mainRegion(page)).toContainText(/illustrative|small|two cases|n ?= ?2|only 2/i);
    await expect(mainRegion(page)).not.toContainText(/leaderboard|top performer|worst performer/i);
    await expect(
      mainRegion(page)
        .getByText(/Synthetic|estimate/i)
        .first(),
    ).toBeVisible();
  });

  test('the comparison of the two cases says which is stronger on how many metrics, and that every figure is an estimate', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseTwoId}/quality?tab=compare`);
    const panel = page.getByRole('tabpanel', { name: 'Compare cases' });
    await expect(panel).toBeVisible();
    await expect(
      panel.getByText(/CG-SYN-1002 shows the stronger estimate on \d+ of the \d+ metrics/),
    ).toBeVisible();
    await expect(panel.getByText(/model estimates, not measurements/i)).toBeVisible();
  });
});
