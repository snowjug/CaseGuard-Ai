import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import { escapeRegExp, mainRegion, openPage, settle } from '../support/ui';

/**
 * Opens a collapsed section of the page from its heading button and returns its content region. A closed section keeps
 * its content mounted but clipped, so Playwright would call it visible: what proves it is open is `aria-expanded`.
 */
async function openSection(page: Page, name: RegExp): Promise<Locator> {
  // The button inside the section's heading: a table in the section may have a sort button of the same name.
  const trigger = page.getByRole('heading', { name }).getByRole('button');
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  return page.getByRole('region', { name });
}

test.describe('[FR-TK-01] Usage and cost: tokens and compute, as estimates', () => {
  test('every group says what it is made of and labels simulated and estimated values; unset budgets read "No limit set", never 0', async ({
    page,
  }) => {
    await openPage(page, '/efficiency');
    await expect(page.getByRole('heading', { level: 1, name: 'Usage and cost' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Scope' })).toBeVisible();
    // The page says when it read the figures: relative text, with the exact UTC moment next to it.
    await expect(page.getByText(/^Updated .+\d\d:\d\d UTC\)$/)).toBeVisible();

    const usage = page.getByRole('group', { name: 'Estimated spend' });
    await expect(usage.getByText('Estimated').first()).toBeVisible();
    await expect(usage.getByText('Simulated').first()).toBeVisible();

    // The savings are the section that is open when the page loads.
    const savings = await openSection(page, /^Estimated savings/);
    for (const name of [
      'Context compression',
      'Duplicate-note removal',
      'Cache hits',
      'Early stopping',
    ]) {
      await expect(savings.getByText(name, { exact: true }), name).toBeVisible();
    }
    await expect(savings.getByText('Estimated').first()).toBeVisible();

    const budgets = await openSection(page, /^Budgets and limits/);
    await expect(budgets.getByText('No limit set').first()).toBeVisible();
    await expect(budgets).not.toContainText(/Per case\s*0 tokens/);
    await expect(budgets.getByText('Per request (input)')).toBeVisible();
  });

  test('the real process and the simulated better path are compared in tokens, with a range and an honest label', async ({
    page,
    api,
  }) => {
    const overview = await api('engineer').getOk<Record<string, unknown>>('/efficiency/overview');
    expect(JSON.stringify(overview)).toMatch(/simulated|counterfactual/i);
    await openPage(page, '/efficiency');
    const comparison = await openSection(page, /^Real process versus a simulated better path/);
    await expect(comparison).toBeVisible();
    await expect(comparison.getByText('Estimated').first()).toBeVisible();
    await expect(comparison.getByText('Simulated').first()).toBeVisible();
    await expect(comparison).toContainText('Tokens used by the investigation');
    await expect(comparison).toContainText(/\(-?\d+%\)/);
    await expect(comparison.getByRole('columnheader', { name: 'Low' })).toBeVisible();
    await expect(comparison.getByRole('columnheader', { name: 'High' })).toBeVisible();
  });

  test('usage by analysis step and by model, and the model calls, are tables with named columns', async ({
    page,
  }) => {
    await openPage(page, '/efficiency');
    await openSection(page, /^Usage by analysis step and model/);
    const agents = page.getByRole('table', { name: 'Usage by analysis step' });
    for (const column of [
      'Analysis step',
      'Calls',
      'Tokens (in / out)',
      'Cached tokens',
      'Average latency',
      'Failures',
    ]) {
      await expect(
        agents.getByRole('columnheader', { name: new RegExp(`^${escapeRegExp(column)}`) }),
        column,
      ).toBeVisible();
    }
    // The prompt and the completion tokens share one column, as "prompt / completion".
    await expect(agents.getByRole('row').nth(1)).toContainText(/[\d,]+ \/ [\d,]+/);
    await expect(page.getByRole('table', { name: 'Usage by model' })).toBeVisible();
    await openSection(page, /^Model calls/);
    const executions = page.getByRole('table', { name: 'Model calls' });
    await expect(executions.getByRole('columnheader', { name: 'Status' })).toBeVisible();
    await expect(executions.getByRole('columnheader', { name: /^Answer came from/ })).toBeVisible();
    await expect(executions.getByRole('row').nth(1)).toContainText(
      /succeeded|simulated|deterministic/i,
    );
  });

  test('filtering model calls by analysis step narrows the table and keeps the choice in the URL', async ({
    page,
  }) => {
    await openPage(page, '/efficiency');
    await openSection(page, /^Model calls/);
    const filter = page.getByRole('combobox', { name: 'Analysis step' });
    const options = await filter.getByRole('option').allInnerTexts();
    expect(options.length).toBeGreaterThan(2);
    const agent = options.find((text) => !/^(all|any)/i.test(text.trim()))!;
    await filter.selectOption({ label: agent });
    await settle(page);
    await expect(page).toHaveURL(/agent=/);
    const rows = page.getByRole('table', { name: 'Model calls' }).getByRole('row');
    await expect(rows.nth(1)).toBeVisible();
  });

  test('the figures never claim to be Azure OpenAI usage: the provider is the deterministic offline engine and the cost is unknown, not zero', async ({
    page,
    api,
  }) => {
    const overview = await api('engineer').getOk<{
      notes: string[];
      totals: { estimatedCostUsd: number | null };
    }>('/efficiency/overview');
    expect(
      overview.totals.estimatedCostUsd,
      'no unit prices are configured, so no cost can be known',
    ).toBeNull();
    await openPage(page, '/efficiency');
    // Where the figures come from is said in "How to read these figures"; the summary says the cost is unknown.
    await openSection(page, /^How to read these figures/);
    const main = mainRegion(page);
    await expect(main).toContainText('deterministic offline provider (simulated)');
    await expect(main).toContainText('not Azure OpenAI usage');
    await expect(main).toContainText('Cost is unknown');
    await expect(page.getByRole('group', { name: 'Estimated spend' })).toContainText(
      'Cost unknown',
    );
    await expect(main).not.toContainText(/\$\s?0(\.0+)?\b/);
  });
});
