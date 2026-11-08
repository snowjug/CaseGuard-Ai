import { expect, test } from '../support/fixtures';
import { openPage, settle } from '../support/ui';
import {
  confirmDialog,
  createThrowawayCase,
  deleteCase,
  toast,
  type ThrowawayCase,
} from '../support/flows';

test.describe('[FR-FK-01] What if: key decisions and what a better path would have changed', () => {
  test('lists the nine key decisions of Case One in time order; the earliest meaningful one is first and selected', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/counterfactual`);
    await expect(page.getByRole('heading', { level: 1, name: 'What if' })).toBeVisible();
    // "Simulation, not history" is one persistent badge whose tooltip carries the sentence, never a banner.
    await expect(page.getByText('Simulation, not history')).toBeVisible();
    await expect(
      page.getByTitle(
        'Everything marked Simulated is an estimate made from what was on record before the decision. It is not something that happened.',
      ),
    ).toBeVisible();
    const forks = page.getByRole('list', { name: 'Key decisions in time order' });
    await expect(forks.getByRole('button')).toHaveCount(9);
    const first = forks.getByRole('button').first();
    await expect(first).toContainText('1 of 9');
    await expect(first).toContainText('Earliest');
    await expect(first).toContainText('9 Mar 2026, 09:41 UTC');
    await expect(first).toContainText('Heavy customer request when a lighter ask was available');
    await expect(first).toHaveAttribute('aria-pressed', 'true');
    await expect(
      page.getByRole('region', { name: 'Heavy customer request when a lighter ask was available' }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Open the decision event in the timeline' }),
    ).toHaveAttribute('href', /sel=e03/);
  });

  test('the no-hindsight check: the decision is judged on what was known strictly before it, and the check passed', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/counterfactual`);
    // Folded away, but the closed line already says that it passed.
    const toggle = page.getByRole('button', { name: /^No-hindsight check/ });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toContainText('Passed');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const boundary = page.getByRole('region', { name: /^No-hindsight check/ });
    await expect(
      boundary.getByRole('img', {
        name: '2 of 31 events were known at the decision instant; 29 later events were withheld',
      }),
    ).toBeVisible();
    await expect(boundary.getByText('No-hindsight check passed')).toBeVisible();
    const checks = boundary.getByRole('button', { name: 'Validity checks (8 of 8 passed)' });
    await expect(checks).toBeVisible();
    await checks.click();
    await expect(checks).toHaveAttribute('aria-expanded', 'true');
    await expect(
      boundary.getByRole('list', { name: 'Validity checks' }).getByRole('listitem').first(),
    ).toBeVisible();
  });

  test('three strategies are generated for the key decision, each with its review state; the comparison is labelled simulated and estimated', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/counterfactual`);
    const strategies = page.getByRole('radiogroup', { name: 'Simulated path strategies' });
    await expect(strategies.getByRole('radio')).toHaveCount(3);
    await expect(strategies.getByRole('radio', { name: /^Balanced path/ })).toBeVisible();
    await expect(strategies.getByRole('radio', { name: /^Lowest customer effort/ })).toBeVisible();
    await expect(strategies.getByRole('radio', { name: /^Fastest to diagnosis/ })).toBeVisible();

    // The answer is the hero, labelled as an estimate and a simulation, with its confidence; the detail is in Compare.
    const hero = page.getByRole('group', { name: 'What would have changed the outcome' });
    await expect(
      hero.getByRole('heading', { name: 'What would have changed the outcome' }),
    ).toBeVisible();
    await expect(hero.getByText('Estimated', { exact: true })).toBeVisible();
    await expect(hero.getByText('Simulated', { exact: true })).toBeVisible();
    await expect(hero.getByText(/Confidence in this comparison/)).toBeVisible();
    const compare = page.getByRole('tabpanel', { name: 'Compare' });
    for (const name of ['What could turn out differently', /^Assumptions/]) {
      const toggle = compare.getByRole('button', { name });
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await expect(compare.getByRole('region', { name })).toBeVisible();
    }
    await strategies.getByRole('radio', { name: /^Lowest customer effort/ }).click();
    await settle(page);
    await expect(
      strategies.getByRole('radio', { name: /^Lowest customer effort/ }),
    ).toHaveAttribute('aria-checked', 'true');
  });

  test('the five sections open: compare, evidence per step, decision moment, graph and review', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/counterfactual`);
    const sections = page.getByRole('tablist', { name: 'What if sections' });
    for (const name of ['Compare', 'Evidence per step', 'Decision moment', 'Graph', 'Review']) {
      await sections.getByRole('tab', { name }).click();
      await settle(page);
      await expect(page.getByRole('tabpanel', { name }), name).toBeVisible();
    }
  });

  test('the investigation graph has a keyboard route and a text alternative (a list of its nodes)', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/counterfactual?tab=graph`);
    await settle(page);
    const panel = page.getByRole('tabpanel', { name: 'Graph' });
    await expect(panel).toBeVisible();
    const canvas = panel.getByRole('group', {
      name: /^Investigation graph with \d+ nodes and \d+ connections\. Tab to enter the graph/,
    });
    await expect(canvas).toBeVisible();
    await expect(panel.getByRole('toolbar', { name: 'Graph controls' })).toBeVisible();
    await expect(panel.getByRole('group', { name: 'Graph legend' })).toBeVisible();

    // Keyboard route: the active node takes focus, Enter selects it, Escape clears the selection.
    const nodes = canvas.getByRole('button');
    expect(await nodes.count(), 'the graph has nodes').toBeGreaterThan(5);
    await canvas.locator('[role="button"][tabindex="0"]').focus();
    await page.keyboard.press('Enter');
    await expect(canvas.getByRole('button', { pressed: true })).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(canvas.getByRole('button', { pressed: true })).toHaveCount(0);

    // Text alternative: the same graph as a node table and a connection table, without the canvas.
    await panel
      .getByText('Text alternative: the graph as a summary, a node table and a connection table')
      .click();
    await expect(
      panel.getByRole('table', { name: /^Nodes in reading order \(\d+\)/ }),
    ).toBeVisible();
    await expect(panel.getByRole('table', { name: /^Connections \(\d+\)/ })).toBeVisible();
  });

  test('hindsight is kept apart, labelled as not used to generate the paths', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/counterfactual`);
    // Folded away, and the closed line already says why it is kept apart.
    const toggle = page.getByRole('button', { name: /^Known only later/ });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toContainText(
      'Hindsight: uses the final resolution and is never used to generate a path',
    );
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const hindsight = page.getByRole('region', { name: /^Known only later/ });
    await expect(hindsight).toBeVisible();
    await expect(hindsight.getByText(/Uses the final resolution/)).toBeVisible();
  });

  test('selecting another key decision changes the decision shown, and it is in the URL', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/counterfactual`);
    const forks = page.getByRole('list', { name: 'Key decisions in time order' });
    await forks.getByRole('button').nth(1).click();
    await settle(page);
    await expect(page).toHaveURL(/sel=fork_/);
    await expect(
      page.getByRole('region', { name: 'Cause stated as fact without supporting evidence' }),
    ).toBeVisible();
    await expect(forks.getByRole('button').nth(1)).toHaveAttribute('aria-pressed', 'true');
  });
});

test.describe('[FR-CF-01] "Generate more strategies" runs a counterfactual job with real progress', () => {
  test.setTimeout(480_000);
  let copy: ThrowawayCase | null = null;

  test.afterAll(async () => {
    if (copy) await deleteCase(copy.id);
  });

  test('on a throw-away copy of Case One, an engineer generates the missing strategies for a key decision and the three strategies appear', async ({
    page,
    api,
  }) => {
    copy = await createThrowawayCase(api('engineer'));
    const caseId = copy.id;

    await openPage(page, `/cases/${caseId}/counterfactual`);
    const forks = page.getByRole('list', { name: 'Key decisions in time order' });
    // A key decision with one simulated path: the other strategies can still be generated.
    const fork = forks.getByRole('button').filter({ hasText: '1 simulated path' }).first();
    await fork.click();
    await settle(page);
    await page.getByRole('button', { name: 'Generate more strategies' }).click();
    await expect(
      confirmDialog(page).getByRole('heading', { name: 'Generate paths' }),
    ).toBeVisible();
    await confirmDialog(page).getByRole('button', { name: 'Generate', exact: true }).click();
    await expect(toast(page, 'Simulated paths are ready')).toBeVisible({ timeout: 240_000 });
    await expect(
      page.getByRole('radiogroup', { name: 'Simulated path strategies' }).getByRole('radio'),
    ).toHaveCount(3);
  });
});
