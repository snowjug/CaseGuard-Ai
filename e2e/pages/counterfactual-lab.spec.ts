import { expect, test } from '../support/fixtures';
import { openPage, settle } from '../support/ui';
import {
  confirmDialog,
  createThrowawayCase,
  deleteCase,
  toast,
  type ThrowawayCase,
} from '../support/flows';

test.describe('[FR-FK-01] Counterfactual Lab: decision forks and what a better path would have changed', () => {
  test('lists the nine forks of Case One in time order; the earliest meaningful one is first and selected', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/counterfactual`);
    await expect(page.getByRole('heading', { level: 1, name: 'Counterfactual Lab' })).toBeVisible();
    await expect(
      page.getByText(
        'Everything marked Simulated is an estimate made from what was on record before the decision. It is not something that happened.',
      ),
    ).toBeVisible();
    const forks = page.getByRole('list', { name: 'Decision forks in time order' });
    await expect(forks.getByRole('button')).toHaveCount(9);
    const first = forks.getByRole('button').first();
    await expect(first).toContainText('Fork 1 of 9');
    await expect(first).toContainText('Earliest meaningful');
    await expect(first).toContainText('9 Mar 2026, 09:41 UTC');
    await expect(first).toContainText('Heavy customer request when a lighter ask was available');
    await expect(
      page.getByRole('group', { name: 'Heavy customer request when a lighter ask was available' }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Open the decision event in the timeline' }),
    ).toHaveAttribute('href', /sel=e03/);
  });

  test('the temporal boundary: the decision is judged on what was known strictly before it, and the leak check passed', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/counterfactual`);
    const boundary = page.getByRole('group', { name: 'Temporal boundary and leak check' });
    await expect(
      boundary.getByRole('img', {
        name: '2 of 31 events were known at the decision instant; 29 later events were withheld',
      }),
    ).toBeVisible();
    await expect(boundary.getByText('Validity checks (8 of 8 passed)')).toBeVisible();
    await boundary.getByText('Validity checks (8 of 8 passed)').click();
    await expect(boundary.getByRole('listitem').first()).toBeVisible();
  });

  test('three strategies are generated for the fork, each with its review state; the comparison is labelled simulated and estimated', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/counterfactual`);
    const strategies = page.getByRole('tablist', { name: 'Simulated path strategies' });
    await expect(strategies.getByRole('tab')).toHaveCount(3);
    await expect(strategies.getByRole('tab', { name: /^Balanced path/ })).toBeVisible();
    await expect(strategies.getByRole('tab', { name: /^Lowest customer effort/ })).toBeVisible();
    await expect(strategies.getByRole('tab', { name: /^Fastest to diagnosis/ })).toBeVisible();

    const compare = page.getByRole('tabpanel', { name: 'Compare paths' });
    await expect(compare.getByRole('heading', { name: 'What would have changed' })).toBeVisible();
    await expect(compare.getByText(/Confidence in this comparison/)).toBeVisible();
    await expect(
      compare.getByRole('region', { name: 'What could turn out differently' }),
    ).toBeVisible();
    await expect(compare.getByRole('region', { name: /^Assumptions/ })).toBeVisible();
    await strategies.getByRole('tab', { name: /^Lowest customer effort/ }).click();
    await settle(page);
    await expect(strategies.getByRole('tab', { name: /^Lowest customer effort/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  test('the five sections of the lab open: paths, evidence behind each step, decision moment, graph and review', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/counterfactual`);
    const sections = page.getByRole('tablist', { name: 'Lab sections' });
    for (const name of [
      'Compare paths',
      'Evidence behind each step',
      'Decision moment',
      'Investigation graph',
      'Review and SkillDNA',
    ]) {
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
    const panel = page.getByRole('tabpanel', { name: 'Investigation graph' });
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
    const hindsight = page.getByRole('region', { name: 'Hindsight (not used to generate)' });
    await expect(hindsight).toBeVisible();
    await expect(hindsight.getByText(/Uses the final resolution/)).toBeVisible();
  });

  test('selecting another fork changes the decision shown, and the fork is in the URL', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/counterfactual`);
    const forks = page.getByRole('list', { name: 'Decision forks in time order' });
    await forks.getByRole('button').nth(1).click();
    await settle(page);
    await expect(page).toHaveURL(/sel=fork_/);
    await expect(
      page.getByRole('group', { name: 'Cause stated as fact without supporting evidence' }),
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

  test('on a throw-away copy of Case One, an engineer generates the missing strategies for a fork and the tabs appear', async ({
    page,
    api,
  }) => {
    copy = await createThrowawayCase(api('engineer'));
    const caseId = copy.id;

    await openPage(page, `/cases/${caseId}/counterfactual`);
    const forks = page.getByRole('list', { name: 'Decision forks in time order' });
    // A fork with one simulated path: the other strategies can still be generated.
    const fork = forks.getByRole('button').filter({ hasText: '1 simulated path' }).first();
    await fork.click();
    await settle(page);
    await page.getByRole('button', { name: 'Generate more strategies' }).click();
    await expect(
      confirmDialog(page).getByRole('heading', { name: 'Generate simulated paths' }),
    ).toBeVisible();
    await confirmDialog(page).getByRole('button', { name: 'Generate', exact: true }).click();
    await expect(toast(page, 'Simulated paths are ready')).toBeVisible({ timeout: 240_000 });
    await expect(
      page.getByRole('tablist', { name: 'Simulated path strategies' }).getByRole('tab'),
    ).toHaveCount(3);
  });
});
