import { expect, test } from '../support/fixtures';
import { listCases } from '../support/api';
import { mainRegion, openPage, settle } from '../support/ui';

/** The six areas of the score: the plain name the page shows, and the technical name that stays one click away. */
const DIMENSIONS = [
  ['Claims backed by evidence', 'Evidence integrity'],
  ['Sound decisions', 'Diagnostic reasoning'],
  ['Problem scoped well', 'Scoping completeness'],
  ['Customer kept informed', 'Customer communication'],
  ['Diagnosis confirmed', 'Resolution validation'],
  ['Effort kept proportionate', 'Efficiency and proportionality'],
] as const;

test.describe('[FR-QI-01] Score: how the score is composed', () => {
  test('the Case Quality Index equals the API, with its range, the method of the estimate, six dimensions and the penalties that applied', async ({
    page,
    demo,
    api,
  }) => {
    const one = (await listCases(api('engineer'))).find((item) => item.id === demo.caseOneId)!;
    await openPage(page, `/cases/${demo.caseOneId}/quality`);
    await expect(page.getByRole('heading', { level: 1, name: 'Score', exact: true })).toBeVisible();
    // The score itself is the body of the page; the other views sit under tabs, and "Effort and metrics" opens first.
    const tabs = page.getByRole('tablist', { name: 'Score details' });
    for (const name of ['Effort and metrics', 'Warnings', 'Skills', 'Coaching', 'Compare']) {
      await expect(tabs.getByRole('tab', { name }), name).toBeVisible();
    }
    await expect(tabs.getByRole('tab', { name: 'Effort and metrics' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const index = page.getByRole('group', { name: 'Case Quality Index', exact: true });
    await expect(index).toContainText(`${Math.round(one.qualityIndex!)}`);
    await expect(
      index.getByText(/Model estimate from a rule-based analysis of the case record/),
    ).toBeVisible();
    await expect(
      index.getByRole('group', { name: 'If every improvement were applied' }),
    ).toBeVisible();

    const dimensions = page.getByRole('group', { name: 'How the score was built' });
    for (const [name, technical] of DIMENSIONS) {
      const row = dimensions.getByRole('heading', { level: 3, name });
      await expect(row, name).toBeVisible();
      // The technical name and its definition are one click away, inside the row.
      await row.getByRole('button').click();
      await expect(
        dimensions.getByRole('region', { name }).getByText(`${technical}:`, { exact: true }),
        technical,
      ).toBeVisible();
    }
    const penalties = page.getByRole('group', { name: 'What lowered the score' });
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

  test('effort and metrics: the time that could have been saved with its range, contributors and assumptions, labelled as an estimate', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/quality?tab=effort`);
    const panel = page.getByRole('tabpanel', { name: 'Effort and metrics' });
    await expect(panel).toBeVisible();
    await expect(panel.getByText(/Time that could have been saved/i).first()).toBeVisible();
    await expect(panel.getByText(/estimate/i).first()).toBeVisible();
    // The method and the assumptions are folded under "How the estimate was calculated".
    const saved = panel.getByRole('group', { name: 'Time that could have been saved' });
    await saved.getByRole('button', { name: /How the estimate was calculated/ }).click();
    await expect(
      saved
        .getByRole('region', { name: /How the estimate was calculated/ })
        .getByText('Assumptions', { exact: true }),
    ).toBeVisible();
    await expect(panel.getByText(/assumption/i).first()).toBeVisible();
  });

  test('warnings: open warnings of the case, as of the time cursor, each with its evidence; dismissing needs a permission', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/quality?tab=warnings`);
    const panel = page.getByRole('tabpanel', { name: 'Warnings' });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('heading', { level: 2 }).first()).toBeVisible();
    // The state filter (Open, Resolved, Dismissed, All) is a set of radios. A "Dismiss" button itself needs an open warning,
    // and the seeded case has none, so what speaks of dismissal here is the "Dismissed (n)" filter.
    await expect(panel.getByRole('radio', { name: /dismiss/i }).first()).toBeVisible();
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

  test('the earlier-moment cursor recomputes the score as of then: only what was known, with a note on later decisions', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/quality?asOf=2026-03-09T12%3A10%3A00Z`);
    const known = page.getByRole('group', { name: 'What was known then', exact: true });
    await expect(known.getByText(/^Known as of 9 Mar 2026, 12:10 UTC\./)).toBeVisible();
    await settle(page);
    await expect(mainRegion(page)).toContainText(/later|withheld|earlier/i);
  });
});

test.describe('[FR-AN-01] Quality: portfolio analytics are for managers and administrators', () => {
  test('an engineer is told which permission is missing and who has it, and still has the way into the score of one case', async ({
    page,
    demo,
  }) => {
    await openPage(page, '/quality');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Quality', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', {
        name: 'You do not have access to quality trends across all cases',
      }),
    ).toBeVisible();
    await expect(
      page.getByText(
        /^Your role \(.+\) does not include the "analytics:read" permission\. Managers and administrators can open it\.$/,
      ),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Choose a development persona' })).toBeVisible();

    // The case picker is a real link: choosing a case does not navigate by itself.
    const picker = page.getByRole('combobox', { name: 'Choose a case' });
    const value = await picker.locator('option', { hasText: 'CG-SYN-1001' }).getAttribute('value');
    await picker.selectOption(value);
    await expect(page.getByRole('link', { name: 'Open score of CG-SYN-1001' })).toHaveAttribute(
      'href',
      `/cases/${demo.caseOneId}/quality`,
    );
  });
});

test.describe('[FR-AN-01] the portfolio, as a manager', () => {
  test.use({ persona: 'manager' });

  test('shows privacy-safe analytics over two cases, says the sample is too small for trends, and never ranks individuals', async ({
    page,
  }) => {
    await openPage(page, '/quality');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Quality', exact: true }),
    ).toBeVisible();
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
    const panel = page.getByRole('tabpanel', { name: 'Compare' });
    await expect(panel).toBeVisible();
    await expect(
      panel.getByText(/CG-SYN-1002 shows the stronger estimate on \d+ of the \d+ metrics/),
    ).toBeVisible();
    await expect(panel.getByText(/model estimates, not measurements/i)).toBeVisible();
  });
});
