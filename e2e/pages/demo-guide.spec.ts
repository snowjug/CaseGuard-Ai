import { expect, test } from '../support/fixtures';
import { completedSteps, demoState, ensurePortfolioDemo, type DemoState } from '../support/api';
import { confirmDialog } from '../support/flows';
import { navLink, openPage, settle } from '../support/ui';

const STEP_TITLES = [
  'Import Case One',
  'Timeline reconstructed',
  'Evidence ledger built',
  'Competing hypotheses shown',
  'Decision forks found',
  'A better path simulated and accepted',
  'Quality and efficiency metrics calculated',
  'Draft SkillDNA generated',
  'Governed approval completed',
  'Import Case Two',
  'The validated skill applies to Case Two',
  'The second investigation is shorter and more evidence-driven',
  'Outcomes compared',
] as const;

test.describe('[FR-DEMO-01] Demo Guide: the 13-step story, derived from stored data', () => {
  test('progress, the demo data and the next step come from the API, not from ticks', async ({
    page,
    demo,
    api,
  }) => {
    const state = await api('engineer').getOk<DemoState>('/demo/state');
    expect(completedSteps(state)).toBe(13);
    await openPage(page, '/demo');
    await expect(page.getByRole('heading', { level: 1, name: 'Demo Guide' })).toBeVisible();
    const progress = page.getByRole('group', { name: 'Progress' });
    await expect(
      progress.getByRole('progressbar', { name: 'Demo progress: 13 of 13 steps complete' }),
    ).toBeVisible();
    await expect(progress).toContainText('13 of 13 steps complete');
    await expect(progress.getByText('Synthetic demonstration data')).toBeVisible();

    const data = progress.locator('dl[aria-label="Demo data"]');
    await expect(data).toContainText('Deterministic');
    await expect(data.getByRole('link', { name: 'Open Case One' })).toHaveAttribute(
      'href',
      `/cases/${demo.caseOneId}`,
    );
    await expect(data.getByRole('link', { name: 'Open Case Two' })).toHaveAttribute(
      'href',
      `/cases/${demo.caseTwoId}`,
    );
    await expect(data.getByRole('link', { name: 'Open the skill' })).toHaveAttribute(
      'href',
      `/skills/${demo.skillId}`,
    );

    const next = progress.getByRole('group', { name: 'Next step' });
    await expect(next).toContainText('Every step is done. Last step: Outcomes compared');
    await expect(next).toContainText('Present as Support Manager');
    // Where the last step leads is the API's to say (it follows the data: the comparison of the two cases once both
    // exist), so the link is checked against the demo state, never against a path written here.
    const last = state.steps.find((step) => step.isNextAction);
    expect(last, 'the last step is the one still shown as next').toBeDefined();
    await expect(next.getByRole('link', { name: last!.actionLabel, exact: true })).toHaveAttribute(
      'href',
      last!.route,
    );
    await expect(navLink(page, 'Demo Guide')).toContainText('13 of 13');
  });

  test('the honest labels say what is synthetic, simulated and estimated', async ({
    page,
    api,
  }) => {
    const state = await api('engineer').getOk<DemoState>('/demo/state');
    await openPage(page, '/demo');
    const labels = page.getByRole('list', { name: 'What is synthetic, simulated or estimated' });
    await expect(labels.getByRole('listitem')).toHaveCount(state.notices.length);
    await expect(labels).toContainText('The AI provider is the deterministic offline engine');
    await expect(labels).toContainText('not Azure OpenAI usage');
    await expect(labels).toContainText('Nothing is deployed to Azure by this demo.');
  });

  test('thirteen steps in order, each done, with the role to present as and a link into the product', async ({
    page,
    api,
  }) => {
    const state = await api('engineer').getOk<DemoState>('/demo/state');
    await openPage(page, '/demo');
    const steps = page.getByRole('list', { name: 'Demo steps' });
    const items = steps.locator(':scope > li');
    await expect(items).toHaveCount(13);
    for (const [index, title] of STEP_TITLES.entries()) {
      const item = items.nth(index);
      await expect(item.getByRole('heading', { level: 3 }), `step ${index + 1}`).toHaveText(
        `Step ${index + 1} of 13: ${title}`,
      );
      await expect(item).toContainText('Done');
      await expect(item).toContainText(
        /Present as (Technical Support Engineer|Support Quality Reviewer|Support Manager|Knowledge \/ Skill Curator)/,
      );
      const step = state.steps[index]!;
      await expect(item.getByRole('link').first(), `step ${index + 1} link`).toHaveAttribute(
        'href',
        step.route,
      );
    }
    await expect(items.nth(0)).toContainText('you are acting as this role');
  });

  test("a step's presenter notes open from its button, and the step is in the URL", async ({
    page,
  }) => {
    await openPage(page, '/demo');
    const first = page.getByRole('list', { name: 'Demo steps' }).locator(':scope > li').first();
    const notes = first.getByRole('button', { name: 'Presenter notes' });
    await expect(notes).toHaveAttribute('aria-expanded', 'false');
    await notes.click();
    await expect(notes).toHaveAttribute('aria-expanded', 'true');
    await expect(page).toHaveURL(/step=import-case-one/);
    await expect(first.getByText('Presenter notes.')).toBeVisible();
    await notes.click();
    await expect(first.getByText('Presenter notes.')).toHaveCount(0);
    await expect(page).not.toHaveURL(/step=/);
  });

  test('"Start presentation mode" turns Presentation Mode on, and the page says the seeding controls are hidden', async ({
    page,
  }) => {
    await openPage(page, '/demo');
    const toggle = page.getByRole('button', { name: 'Start presentation mode' });
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(page.getByRole('region', { name: 'Presenter strip' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Exit presentation mode' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(
      page.getByText('Seeding and persona controls are hidden while presenting.'),
    ).toBeVisible();
    await expect(page.getByRole('group', { name: 'Reset demo data' })).toHaveCount(0);
  });
});

test.describe('[FR-DEMO-02] seeding and resetting are for administrators, and asked for twice', () => {
  test('an engineer sees the three controls disabled, with the missing permission explained', async ({
    page,
  }) => {
    await openPage(page, '/demo');
    for (const name of ['Play the whole story', 'Start from step 1', 'Reset demo data']) {
      const control = page.getByRole('group', { name }).getByRole('button', { name });
      await expect(control, name).toBeDisabled();
    }
    const reset = page
      .getByRole('group', { name: 'Reset demo data' })
      .getByRole('button', { name: 'Reset demo data' });
    await reset.focus();
    await expect(page.getByRole('tooltip')).toContainText(
      'does not include the "demo:manage" permission',
    );
  });

  test.describe('as an administrator', () => {
    test.use({ persona: 'admin' });

    test('each control opens a confirmation that says what it erases; cancelling changes nothing', async ({
      page,
      api,
    }) => {
      await openPage(page, '/demo');
      const before = completedSteps(await api('admin').getOk<DemoState>('/demo/state'));
      const cases: readonly (readonly [string, string, string])[] = [
        [
          'Play the whole story',
          'Play the whole story?',
          'Nothing outside the synthetic demo tenant is touched.',
        ],
        [
          'Start from step 1',
          'Erase case data and start from step 1?',
          'Users, governance settings and the audit trail are kept.',
        ],
        [
          'Reset demo data',
          'Reset the demo data?',
          'This erases the cases, analysis results, skills and jobs',
        ],
      ];
      for (const [button, title, text] of cases) {
        await page
          .getByRole('group', { name: button })
          .getByRole('button', { name: button })
          .click();
        const dialog = confirmDialog(page);
        await expect(dialog.getByRole('heading', { name: title }), title).toBeVisible();
        await expect(dialog).toContainText(text);
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(dialog).toBeHidden();
      }
      expect(
        completedSteps(await api('admin').getOk<DemoState>('/demo/state')),
        'nothing was erased',
      ).toBe(before);
    });
  });
});

test.describe('[FR-DEMO-03] the whole story can be played from the Demo Guide, and starts from step 1 again', () => {
  test.use({ persona: 'admin' });
  test.setTimeout(900_000);
  test.describe.configure({ mode: 'serial' });

  test.afterAll(async () => {
    await ensurePortfolioDemo();
  });

  test('"Start from step 1" erases the case data: 0 of 13, only the first step open, the others locked with a reason', async ({
    page,
    api,
  }) => {
    await openPage(page, '/demo');
    await page
      .getByRole('group', { name: 'Start from step 1' })
      .getByRole('button', { name: 'Start from step 1' })
      .click();
    await confirmDialog(page).getByRole('button', { name: 'Erase and start over' }).click();
    await expect(confirmDialog(page)).toBeHidden({ timeout: 300_000 });
    await settle(page);
    await expect(
      page.getByRole('progressbar', { name: 'Demo progress: 0 of 13 steps complete' }),
    ).toBeVisible();
    await expect(page.getByText('Nothing has been loaded yet')).toBeVisible();
    const items = page.getByRole('list', { name: 'Demo steps' }).locator(':scope > li');
    await expect(items.nth(0)).toContainText('Next');
    await expect(items.nth(0).getByRole('link')).toBeVisible();
    await expect(items.nth(1)).toContainText('Locked');
    await expect(items.nth(1)).toContainText('Locked.');
    await expect(items.nth(1).getByRole('link')).toHaveCount(0);
    expect(completedSteps(await api('admin').getOk<DemoState>('/demo/state'))).toBe(0);
  });

  test('"Play the whole story" runs the 13 steps with progress, and every step ends up done and derived from stored data', async ({
    page,
    api,
  }) => {
    expect(completedSteps(await demoState())).toBe(0);
    await openPage(page, '/demo');
    await page
      .getByRole('group', { name: 'Play the whole story' })
      .getByRole('button', { name: 'Play the whole story' })
      .click();
    const dialog = confirmDialog(page);
    await expect(dialog.getByRole('heading', { name: 'Play the whole story?' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Play the story' }).click();
    await expect(
      dialog
        .getByRole('progressbar', { name: 'Seeding progress' })
        .or(dialog.getByText(/Playing the story/))
        .first(),
    ).toBeVisible({ timeout: 30_000 });
    await expect(dialog).toBeHidden({ timeout: 600_000 });
    await settle(page);
    await expect(
      page.getByRole('progressbar', { name: 'Demo progress: 13 of 13 steps complete' }),
    ).toBeVisible();
    const state = await api('admin').getOk<DemoState>('/demo/state');
    expect(completedSteps(state)).toBe(13);
    expect(state.caseOneId).toBeTruthy();
    expect(state.caseTwoId).toBeTruthy();
    expect(state.skillId).toBeTruthy();
  });
});
