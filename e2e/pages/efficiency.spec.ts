import { expect, test } from '../support/fixtures';
import { mainRegion, openPage, settle } from '../support/ui';

test.describe('[FR-TK-01] Efficiency Monitor: tokens and compute, as estimates', () => {
  test('every group says what it is made of and labels simulated and estimated values; unset budgets read "No limit set", never 0', async ({
    page,
  }) => {
    await openPage(page, '/efficiency');
    await expect(page.getByRole('heading', { level: 1, name: 'Efficiency Monitor' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Scope' })).toBeVisible();
    await expect(page.getByText(/Updated \d\d:\d\d UTC/)).toBeVisible();

    const usage = page.getByRole('group', { name: 'Token usage' });
    await expect(usage.getByText('Estimated').first()).toBeVisible();
    await expect(usage.getByText('Simulated').first()).toBeVisible();

    const savings = page.getByRole('group', { name: 'Estimated savings' });
    for (const name of [
      'Context compression',
      'Duplicate-note removal',
      'Cache hits',
      'Early stopping',
    ]) {
      await expect(savings.getByText(name, { exact: true }), name).toBeVisible();
    }
    await expect(savings.getByText('Estimated').first()).toBeVisible();

    const budgets = page.getByRole('group', { name: 'Budgets and limits' });
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
    const comparison = page.getByRole('group', {
      name: 'Real process versus a simulated better path',
    });
    await expect(comparison).toBeVisible();
    await expect(comparison.getByText('Estimated').first()).toBeVisible();
    await expect(comparison.getByText('Simulated').first()).toBeVisible();
    await expect(comparison).toContainText('Tokens used by the investigation');
    await expect(comparison).toContainText(/\(-?\d+%\)/);
    await expect(comparison.getByRole('columnheader', { name: 'Low' })).toBeVisible();
    await expect(comparison.getByRole('columnheader', { name: 'High' })).toBeVisible();
  });

  test('usage by agent and by model, and the model executions, are tables with named columns', async ({
    page,
  }) => {
    await openPage(page, '/efficiency');
    const agents = page.getByRole('table', { name: 'Usage by agent' });
    for (const column of [
      'Agent',
      'Calls',
      'Prompt tokens',
      'Completion tokens',
      'Cached tokens',
      'Average latency',
      'Failures',
    ]) {
      await expect(
        agents.getByRole('columnheader', { name: new RegExp(`^${column}`) }),
        column,
      ).toBeVisible();
    }
    await expect(page.getByRole('table', { name: 'Usage by model' })).toBeVisible();
    const executions = page.getByRole('table', { name: 'Model executions' });
    await expect(executions.getByRole('columnheader', { name: 'Status' })).toBeVisible();
    await expect(executions.getByRole('columnheader', { name: /^Answer came from/ })).toBeVisible();
    await expect(executions.getByRole('row').nth(1)).toContainText(
      /succeeded|simulated|deterministic/i,
    );
  });

  test('filtering executions by agent narrows the table and keeps the choice in the URL', async ({
    page,
  }) => {
    await openPage(page, '/efficiency');
    const filter = page.getByRole('combobox', { name: 'Agent' });
    const options = await filter.getByRole('option').allInnerTexts();
    expect(options.length).toBeGreaterThan(2);
    const agent = options.find((text) => !/^(all|any)/i.test(text.trim()))!;
    await filter.selectOption({ label: agent });
    await settle(page);
    await expect(page).toHaveURL(/agent=/);
    const rows = page.getByRole('table', { name: 'Model executions' }).getByRole('row');
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
    const main = mainRegion(page);
    await expect(main).toContainText('deterministic offline provider (simulated)');
    await expect(main).toContainText('not Azure OpenAI usage');
    await expect(main).toContainText('Cost is unknown');
    await expect(page.getByRole('group', { name: 'Token usage' })).toContainText(
      /Estimated cost\s*Unknown/,
    );
    await expect(main).not.toContainText(/\$\s?0(\.0+)?\b/);
  });
});
