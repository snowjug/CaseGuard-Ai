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

test.describe('[FR-UX-07] Command Center: quality at a glance for the active case', () => {
  test('shows the most recent case with its provenance, and seven metric cards that explain themselves and link to their evidence', async ({
    page,
    demo,
  }) => {
    await openPage(page, '/');
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible();
    const active = page.getByRole('group', { name: 'Active case' });
    await expect(active).toContainText('CG-SYN-1002');
    await expect(active).toContainText('Analysed');
    await expect(active).toContainText('Synthetic');
    await expect(active.getByRole('link', { name: 'Open case' })).toHaveAttribute(
      'href',
      `/cases/${demo.caseTwoId}`,
    );
    await expect(page.getByText(/Updated \d\d:\d\d UTC/)).toBeVisible();

    const metrics = page.getByRole('region', { name: 'Key metrics' });
    for (const name of METRICS) {
      const card = metrics.getByRole('group', { name });
      await expect(card, name).toBeVisible();
      await expect(card.getByRole('heading', { level: 3, name })).toBeVisible();
      await expect(card.getByRole('button', { name: `What is ${name}?` })).toBeVisible();
      await expect(card.getByRole('link', { name: `Evidence behind ${name}` })).toBeVisible();
      await expect(
        card.getByText('Estimated').first(),
        `${name} says it is an estimate`,
      ).toBeVisible();
    }
  });

  test('the quality card equals the API, with its estimated range as a text alternative', async ({
    page,
    api,
  }) => {
    const two = (await listCases(api('engineer'))).find(
      (item) => item.reference === 'CG-SYN-1002',
    )!;
    await openPage(page, '/');
    const card = page
      .getByRole('region', { name: 'Key metrics' })
      .getByRole('group', { name: 'Case Quality Index' });
    await expect(card).toContainText(`${Math.round(two.qualityIndex!)} / 100`);
    await expect(
      card.getByRole('img', {
        name: new RegExp(`estimated range: estimate ${two.qualityIndex!.toFixed(1)},`),
      }),
    ).toBeVisible();
    await expect(card).toContainText(/Estimated range [\d.]+ to [\d.]+/);
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
    await expect(page.getByRole('group', { name: 'Active case' })).toContainText('CG-SYN-1001');
    const card = page
      .getByRole('region', { name: 'Key metrics' })
      .getByRole('group', { name: 'Case Quality Index' });
    await expect(card).toContainText(`${Math.round(one.qualityIndex!)} / 100`);
    await expect(
      page
        .getByRole('region', { name: 'Key metrics' })
        .getByRole('group', { name: 'Avoidable Support Effort' }),
    ).toContainText(`${one.avoidableEffortPct!.toFixed(0)}%`);
  });

  test('a metric explains its definition in a popover that Escape closes, and its evidence link opens the case review', async ({
    page,
    demo,
  }) => {
    await openPage(page, '/');
    const card = page
      .getByRole('region', { name: 'Key metrics' })
      .getByRole('group', { name: 'Case Quality Index' });
    const help = card.getByRole('button', { name: 'What is Case Quality Index?' });
    await help.click();
    const definition = page.getByRole('group', { name: 'Definition of Case Quality Index' });
    await expect(definition).toBeVisible();
    await expect(definition).toContainText(/How it is calculated/);
    await expect(definition).toContainText(/weighted composite/i);
    await expect(help).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(definition).toBeHidden();
    await expect(help).toBeFocused();

    await card.getByRole('link', { name: 'Evidence behind Case Quality Index' }).click();
    await expect(page).toHaveURL(new RegExp(`/cases/${demo.caseTwoId}/quality`));
    await expect(
      page.getByRole('heading', { level: 1, name: 'Case Quality Review' }),
    ).toBeVisible();
  });

  test('nothing is presented as production data: the synthetic, estimate and simulated notices are on the page', async ({
    page,
  }) => {
    await openPage(page, '/');
    const main = mainRegion(page);
    await expect(
      main.getByText(
        'All case data, people and organisations in this environment are synthetic and for demonstration only.',
      ),
    ).toBeVisible();
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

  test('recent cases, the SkillDNA match and the system health summary lead to their pages', async ({
    page,
    demo,
  }) => {
    await openPage(page, '/');
    const recent = page.getByRole('group', { name: 'Recent cases' });
    await expect(recent.getByRole('link', { name: 'CG-SYN-1002' })).toHaveAttribute(
      'href',
      `/cases/${demo.caseTwoId}`,
    );
    await expect(recent.getByRole('link', { name: 'CG-SYN-1001' })).toHaveAttribute(
      'href',
      `/cases/${demo.caseOneId}`,
    );
    await expect(
      page
        .getByRole('group', { name: 'SkillDNA match' })
        .getByRole('link', { name: 'Open the skill' }),
    ).toHaveAttribute('href', `/skills/${demo.skillId}`);
    await expect(page.getByRole('group', { name: 'System health' })).toContainText(
      'deterministic, rule-based provider',
    );
  });
});
