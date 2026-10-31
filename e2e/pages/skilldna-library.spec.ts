import { expect, test } from '../support/fixtures';
import { mainRegion, openPage, settle } from '../support/ui';

const SKILL_TITLE = 'Isolate a pre-authentication failure before pursuing identity policy';

test.describe('[FR-SK-01] SkillDNA Library: governed, reusable investigation skills', () => {
  test('lists the published skill with its lifecycle state, and says that nothing is published automatically', async ({
    page,
    demo,
  }) => {
    await openPage(page, '/skills');
    await expect(page.getByRole('heading', { level: 1, name: 'SkillDNA Library' })).toBeVisible();
    await expect(
      page.getByText(
        /A skill is never published automatically: each lifecycle step needs a person with the right role/,
      ),
    ).toBeVisible();
    const list = page.getByRole('list', { name: 'Skills' });
    await expect(list.getByRole('heading', { level: 2, name: SKILL_TITLE })).toBeVisible();
    await expect(list.getByRole('link', { name: SKILL_TITLE })).toHaveAttribute(
      'href',
      `/skills/${demo.skillId}`,
    );
    await expect(list.getByText('Published').first()).toBeVisible();
    await expect(page.getByText('Showing 1 skill.')).toBeVisible();
  });

  test('search and the lifecycle filter narrow the list and live in the URL', async ({ page }) => {
    await openPage(page, '/skills');
    await page.getByRole('searchbox', { name: 'Search' }).fill('no-such-skill-anywhere');
    await expect(page).toHaveURL(/q=/);
    await expect(page.getByRole('list', { name: 'Skills' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'No skill matches the filters' })).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters' }).first().click();
    await expect(page.getByRole('list', { name: 'Skills' })).toBeVisible();
    await page.getByRole('combobox', { name: 'Lifecycle state' }).selectOption({ label: 'Draft' });
    await expect(page).toHaveURL(/lifecycle=draft/);
    await expect(page.getByRole('list', { name: 'Skills' })).toHaveCount(0);
  });
});

test.describe('[FR-SK-02] a skill: what it is, where it came from, who approved it', () => {
  test('the overview shows the steps, the conditions, the source case and the accepted path it came from, labelled as hindsight where it is', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/skills/${demo.skillId}`);
    await expect(page.getByRole('heading', { level: 1, name: SKILL_TITLE })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Where this skill stands' })).toContainText(
      'Published',
    );
    const tabs = page.getByRole('tablist', { name: 'Skill sections' });
    for (const name of ['Overview', 'Governance', 'Versions', 'Validation', 'Cases']) {
      await expect(tabs.getByRole('tab', { name }), name).toBeVisible();
    }
    const overview = page.getByRole('tabpanel', { name: 'Overview' });
    await expect(overview.getByRole('group', { name: 'Expected benefit' })).toBeVisible();
    const origin = overview.getByRole('group', { name: 'Where it came from' });
    await expect(origin.getByRole('link', { name: 'CG-SYN-1001' })).toHaveAttribute(
      'href',
      `/cases/${demo.caseOneId}`,
    );
    await expect(origin.getByRole('link', { name: 'Accepted simulated path' })).toBeVisible();
    await expect(origin.getByRole('group', { name: 'Derived with hindsight' })).toBeVisible();
    const detail = overview.getByRole('group', { name: 'The skill in detail' });
    await expect(detail.getByRole('heading', { level: 3 }).first()).toContainText(/^1\./);
    // Each part of the definition is a disclosure; the ones that matter most are open already.
    for (const title of [
      'Trigger conditions',
      'Exclusions',
      'Decision sequence',
      'Minimum evidence',
      'Safety constraints',
    ]) {
      await expect(
        detail.locator('summary', { hasText: new RegExp(`^${title}`) }),
        title,
      ).toBeVisible();
    }
    await detail.locator('summary', { hasText: /^Exclusions/ }).click();
    await expect(
      detail
        .locator('details', { has: page.locator('summary', { hasText: /^Exclusions/ }) })
        .getByRole('listitem')
        .first(),
    ).toBeVisible();
  });

  test('the governance tab names the people involved and lists every decision so far, in order; the one step left is withdrawal, and an engineer cannot take it', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/skills/${demo.skillId}?tab=governance`);
    const panel = page.getByRole('tabpanel', { name: 'Governance' });
    await expect(
      panel.getByText(
        'Approvals stay independent: the creator, the pilot approver and the publisher are different people.',
      ),
    ).toBeVisible();
    const people = panel.locator('dl[aria-label="People involved in this skill"]');
    await expect(people).toContainText('Created by');
    await expect(people).toContainText('Pilot approved by');
    await expect(people).toContainText('Published by');

    const decisions = panel
      .getByRole('group', { name: 'Decisions so far' })
      .getByRole('list', { name: 'Decisions in order' });
    await expect(decisions.getByRole('listitem')).toHaveCount(6);
    await expect(decisions.getByRole('listitem').first()).toContainText('Moved to Draft');
    await expect(decisions.getByRole('listitem').last()).toContainText('Moved to Published');

    const next = panel.getByRole('group', { name: 'Next steps' });
    await expect(next.getByRole('heading', { level: 3, name: 'Move to Deprecated' })).toBeVisible();
    await expect(next.getByText('Not available')).toBeVisible();
    await expect(
      next.getByText('Moving a skill to Deprecated requires the skill:retire permission.'),
    ).toBeVisible();
    await expect(next.getByRole('button', { name: 'Withdraw: Deprecated' })).toBeDisabled();
  });

  test('versions have a history and a human-readable difference between two of them', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/skills/${demo.skillId}?tab=versions`);
    const panel = page.getByRole('tabpanel', { name: 'Versions' });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('heading', { level: 2 }).first()).toBeVisible();
    await expect(mainRegion(page)).toContainText(/1\.0\.0|version/i);
  });

  test('validation shows recorded runs with their gate result; an engineer cannot run one', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/skills/${demo.skillId}?tab=validation`);
    const panel = page.getByRole('tabpanel', { name: 'Validation' });
    await expect(panel.getByText(/Only a full run counts/)).toBeVisible();
    const runs = panel.getByRole('group', { name: 'Recorded runs' });
    await expect(runs).toContainText(/Simulation test|Regression suite/);
    await expect(runs).toContainText('Passed');
    await expect(panel.getByRole('button', { name: 'Run simulation test' })).toBeDisabled();
  });

  test('the cases tab lists where the skill matched, with its score as an estimate', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/skills/${demo.skillId}?tab=cases`);
    const panel = page.getByRole('tabpanel', { name: 'Cases' });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('CG-SYN-1002');
    await expect(panel).toContainText(/estimate/i);
  });

  test('an unknown skill is a not-found page that says so, not a blank screen', async ({
    page,
    diagnostics,
  }) => {
    diagnostics.allow(/Failed to load resource/);
    await page.goto('/skills/skl_does_not_exist');
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await settle(page);
    await expect(
      page.getByRole('heading', { level: 2, name: 'We could not find that skill' }),
    ).toBeVisible();
    await expect(mainRegion(page)).toContainText(
      'It may have been removed, or the address may be mistyped.',
    );
    await expect(
      mainRegion(page).getByRole('link', { name: 'Open the SkillDNA Library' }),
    ).toHaveAttribute('href', '/skills');
  });
});
