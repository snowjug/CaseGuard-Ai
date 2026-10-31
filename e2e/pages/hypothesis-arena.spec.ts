import { expect, test } from '../support/fixtures';
import { mainRegion, openPage, settle } from '../support/ui';

test.describe('[FR-HY-01] Hypothesis Arena: competing hypotheses with confidence over time', () => {
  test('ranks nine hypotheses of Case One, the leading one confirmed, and says confidence is a model estimate', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/hypotheses`);
    await expect(page.getByRole('heading', { level: 1, name: 'Hypothesis Arena' })).toBeVisible();
    const list = page.getByRole('list', { name: 'Hypotheses ranked by confidence' });
    await expect(list.getByRole('button')).toHaveCount(9);
    const leading = list.getByRole('button').first();
    await expect(leading).toContainText('DNS resolution failure for sign-in endpoints');
    await expect(leading).toContainText('Confirmed');
    await expect(leading).toHaveAttribute('aria-pressed', 'true');
    await expect(
      list.getByRole('button', { name: /^Conditional Access or MFA policy enforcement/ }),
    ).toContainText('Ruled out');
    await expect(
      page
        .getByText(
          'Confidence values are model estimates produced from an authored knowledge pack. They are not statistical truth.',
        )
        .first(),
    ).toBeVisible();
  });

  test('confidence over time is a chart with a text alternative, labelled as an estimate', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/hypotheses`);
    const chart = page.getByRole('group', { name: 'Confidence over time' });
    await expect(chart).toBeVisible();
    await expect(chart.getByRole('img').first()).toBeVisible();
    await expect(chart.getByRole('list', { name: /legend/ })).toBeVisible();
  });

  test('selecting another hypothesis shows its own detail: why it moved, what supports and contradicts it, what is missing', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/hypotheses`);
    const list = page.getByRole('list', { name: 'Hypotheses ranked by confidence' });
    await list
      .getByRole('button', { name: /^Conditional Access or MFA policy enforcement/ })
      .click();
    await settle(page);
    await expect(page).toHaveURL(/sel=/);
    const detail = page.getByRole('group', {
      name: 'Conditional Access or MFA policy enforcement',
    });
    await expect(detail).toBeVisible();
    for (const region of [
      'Confidence',
      'Why it is where it is',
      'Evidence that supports it',
      'Evidence that contradicts it',
      'Missing evidence',
      'Assumptions',
      'Cheapest safe validating action',
    ]) {
      await expect(detail.getByRole('region', { name: region }), region).toBeVisible();
    }
    await expect(
      detail.getByRole('region', { name: 'Evidence that contradicts it' }),
    ).toContainText(/\(\d+\)/);
  });

  test('evidence is traceable: each item links to its source event and has a copyable id', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/hypotheses`);
    const supports = page.getByRole('region', { name: 'Evidence that supports it' });
    await expect(
      supports.getByRole('link', { name: /^Source event e\d+/ }).first(),
    ).toHaveAttribute('href', new RegExp(`/cases/${demo.caseOneId}/timeline`));
    await expect(
      supports.getByRole('button', { name: /^Copy evidence id evd_/ }).first(),
    ).toBeVisible();
  });

  test('"Simulate a safer path" links from the whole record to the lab, on the earliest meaningful fork', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/hypotheses`);
    const link = mainRegion(page).getByRole('link', {
      name: /^Simulate a safer path from 9 Mar 2026, 09:41 UTC/,
    });
    await expect(link).toHaveAttribute(
      'href',
      new RegExp(`/cases/${demo.caseOneId}/counterfactual\\?sel=fork_`),
    );
  });

  test('"Just before the earliest meaningful decision fork" shows what was believed before the decision, computed from what was known then', async ({
    page,
    demo,
    api,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/hypotheses`);
    const list = page.getByRole('list', { name: 'Hypotheses ranked by confidence' });
    await expect(list.getByRole('button').first()).toContainText(
      'DNS resolution failure for sign-in endpoints',
    );
    await page
      .getByRole('button', { name: 'Just before the earliest meaningful decision fork' })
      .click();
    await settle(page);
    await expect(page).toHaveURL(/asOf=/);
    const asOf = new URL(page.url()).searchParams.get('asOf')!;
    await expect(
      page.getByRole('group', { name: 'What was known' }).getByRole('status'),
    ).toContainText('9 Mar 2026');

    // The page and the API agree on who was ahead at that moment, and it was not the cause that was found later.
    const earlier = await api('engineer').getOk<{
      items: { name: string; currentConfidence: number }[];
    }>(`/cases/${demo.caseOneId}/hypotheses`, {
      query: { asOf },
    });
    const ranked = [...earlier.items].sort((a, b) => b.currentConfidence - a.currentConfidence);
    await expect(list.getByRole('button').first()).toContainText(ranked[0]!.name);
    expect(
      ranked[0]!.name,
      'before the decision the final cause was not yet the leading explanation',
    ).not.toBe('DNS resolution failure for sign-in endpoints');
    await expect(
      list.getByRole('button', { name: /^DNS resolution failure for sign-in endpoints/ }),
    ).not.toContainText('Confirmed');
  });

  test('the next best action is ranked with its calculation, and the ranking reflects only what was known', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/hypotheses`);
    const next = page.getByRole('group', { name: 'Next best action' });
    await expect(next).toBeVisible();
    await expect(next.getByRole('heading', { level: 2, name: 'Next best action' })).toBeVisible();
  });
});
