import { expect, test } from '../support/fixtures';
import { listCases } from '../support/api';
import { mainRegion, openPage, settle } from '../support/ui';

const METRICS = [
  'Case Quality Index',
  'Evidence Integrity',
  'Avoidable Support Effort',
  'Reasoning Efficiency',
  'Customer Effort',
  'Resolution Confidence',
  'Token Efficiency',
] as const;

test.describe('[FR-UX-07] Home: the latest review at a glance', () => {
  test('shows the most recent case as a big score with its reason, the way into the review, and the three steps of the flow', async ({
    page,
    demo,
  }) => {
    await openPage(page, '/');
    await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
    const hero = page.getByRole('region', { name: 'Latest review' });
    await expect(hero).toContainText('CG-SYN-1002');
    await expect(hero).toContainText('Analysed');
    await expect(hero).toContainText('Demo data');
    await expect(hero.getByRole('img', { name: /^Case quality: \d+ out of 100/ })).toBeVisible();
    await expect(hero.getByRole('link', { name: 'Open review' })).toHaveAttribute(
      'href',
      `/cases/${demo.caseTwoId}/review`,
    );
    await expect(page.getByRole('list', { name: 'How CaseGuard works' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Add a case' }).first()).toHaveAttribute(
      'href',
      '/cases/new',
    );
  });

  test('the score equals the API, and says it is an estimate with a range', async ({
    page,
    api,
  }) => {
    const two = (await listCases(api('engineer'))).find(
      (item) => item.reference === 'CG-SYN-1002',
    )!;
    await openPage(page, '/');
    const ring = page
      .getByRole('region', { name: 'Latest review' })
      .getByRole('img', { name: /^Case quality: / });
    await expect(ring).toHaveAttribute(
      'aria-label',
      new RegExp(`^Case quality: ${Math.round(two.qualityIndex!)} out of 100, .*estimated range `),
    );
  });

  test('choosing another case reloads the figures: Case One is the costly investigation', async ({
    page,
    api,
  }) => {
    const one = (await listCases(api('engineer'))).find(
      (item) => item.reference === 'CG-SYN-1001',
    )!;
    await openPage(page, '/');
    const select = mainRegion(page).getByRole('combobox', { name: 'Case' });
    const label = (await select.getByRole('option', { name: /^CG-SYN-1001/ }).textContent()) ?? '';
    await select.selectOption({ label });
    await settle(page);
    const hero = page.getByRole('region', { name: 'Latest review' });
    await expect(hero).toContainText('CG-SYN-1001');
    await expect(hero.getByRole('img', { name: /^Case quality: / })).toHaveAttribute(
      'aria-label',
      new RegExp(`^Case quality: ${Math.round(one.qualityIndex!)} out of 100`),
    );
    await expect(
      page
        .getByRole('heading', { name: 'Time that could have been saved' })
        .locator('xpath=ancestor::*[2]'),
    ).toContainText(`${one.avoidableEffortPct!.toFixed(0)}%`);
  });

  test('keeps all seven metrics in "All metrics": each explains itself in a popover that Escape closes, and links to its score', async ({
    page,
    demo,
  }) => {
    await openPage(page, '/');
    await page.getByRole('button', { name: /All metrics/ }).click();
    for (const name of METRICS) {
      const card = page.getByRole('group', { name });
      await expect(card, name).toBeVisible();
      await expect(card.getByRole('button', { name: `What is ${name}?` })).toBeVisible();
      await expect(
        card.getByText('Estimated').first(),
        `${name} says it is an estimate`,
      ).toBeVisible();
    }
    const card = page.getByRole('group', { name: 'Case Quality Index' });
    const help = card.getByRole('button', { name: 'What is Case Quality Index?' });
    await help.click();
    const definition = page.getByRole('group', { name: 'Definition of Case Quality Index' });
    await expect(definition).toBeVisible();
    await expect(definition).toContainText(/weighted composite/i);
    await expect(help).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(definition).toBeHidden();
    await expect(help).toBeFocused();

    await card.getByRole('link', { name: 'Evidence behind Case Quality Index' }).click();
    await expect(page).toHaveURL(new RegExp(`/cases/${demo.caseTwoId}/quality`));
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  });

  test('nothing is presented as production data: the demo-data pill and the estimate notices stay one click away', async ({
    page,
  }) => {
    await openPage(page, '/');
    await page
      .getByRole('banner')
      .getByRole('button', { name: 'Demo data: what this means' })
      .click();
    await expect(
      page.getByText(
        'All case data, people and organisations in this environment are synthetic and for demonstration only.',
      ),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    const main = mainRegion(page);
    await main.getByRole('button', { name: /How to read these numbers/ }).click();
    await expect(
      main
        .getByText(
          'Confidence values are model estimates produced from an authored knowledge pack. They are not statistical truth.',
        )
        .first(),
    ).toBeVisible();
    await expect(
      main.getByText(/deterministic offline provider \(simulated\); token counts are estimates/),
    ).toBeVisible();
    await expect(main.getByText(/illustrative, not a trend over time/)).toBeVisible();
  });

  test('recent cases and the skill match lead to their pages', async ({ page, demo }) => {
    await openPage(page, '/');
    const recent = page.getByRole('region', { name: 'Recent cases' });
    await expect(recent.getByRole('link', { name: /CG-SYN-1002/ })).toHaveAttribute(
      'href',
      `/cases/${demo.caseTwoId}/review`,
    );
    await expect(recent.getByRole('link', { name: /CG-SYN-1001/ })).toHaveAttribute(
      'href',
      `/cases/${demo.caseOneId}/review`,
    );
    await expect(
      page
        .getByRole('region', { name: 'Skills you could reuse' })
        .getByRole('link', { name: /Isolate a pre-authentication failure/ }),
    ).toHaveAttribute('href', new RegExp(`^/skills/skl_`));
  });
});
