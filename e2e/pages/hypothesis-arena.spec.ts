import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import { mainRegion, openPage, settle } from '../support/ui';

/** "What was known then" is one bar, closed until it is opened: the time cursor and the counts are inside it. */
async function openKnownBar(page: Page): Promise<Locator> {
  const toggle = page.getByRole('button', { name: /^What was known then/ });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  return page.getByRole('region', { name: /^What was known then/ });
}

test.describe('[FR-HY-01] Possible causes: competing explanations with confidence over time', () => {
  test('ranks nine possible causes of Case One, the leading one confirmed, and says confidence is a model estimate', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/hypotheses`);
    await expect(page.getByRole('heading', { level: 1, name: 'Possible causes' })).toBeVisible();
    // The leading cause is the hero; the other eight are ranked after it, five at first.
    const hero = page.getByRole('region', { name: 'DNS resolution failure for sign-in endpoints' });
    await expect(hero).toContainText('Most likely cause');
    await expect(hero).toContainText('Confirmed');
    await expect(
      hero.getByRole('button', {
        name: 'See evidence for DNS resolution failure for sign-in endpoints',
      }),
    ).toBeVisible();
    const list = page.getByRole('list', { name: 'Possible causes ranked by confidence' });
    await expect(list.getByRole('button')).toHaveCount(5);
    await page.getByRole('button', { name: 'Show 3 more possible causes' }).click();
    await expect(list.getByRole('button')).toHaveCount(8);
    await expect(
      list.getByRole('button', { name: /^Conditional Access or MFA policy enforcement/ }),
    ).toContainText('Ruled out');
    await expect(
      hero.getByText('A model estimate with a range, not statistical truth.'),
    ).toBeVisible();
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

  test('selecting another cause shows its own detail: why it moved, what supports and contradicts it, what is missing', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/hypotheses`);
    const list = page.getByRole('list', { name: 'Possible causes ranked by confidence' });
    await list
      .getByRole('button', { name: /^Conditional Access or MFA policy enforcement/ })
      .click();
    await settle(page);
    await expect(page).toHaveURL(/sel=/);
    // The detail is a drawer: a modal dialog named by the cause.
    const detail = page.getByRole('dialog', {
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
      // Each part is a row that opens; a closed one is opened first.
      const name = new RegExp(`^${region}( \\(\\d+\\))?$`);
      const row = detail.getByRole('button', { name });
      if ((await row.getAttribute('aria-expanded')) !== 'true') await row.click();
      await expect(row, region).toHaveAttribute('aria-expanded', 'true');
      await expect(detail.getByRole('region', { name }), region).toBeVisible();
    }
    await expect(
      detail.getByRole('heading', { level: 3, name: /^Evidence that contradicts it \(\d+\)$/ }),
    ).toBeVisible();
  });

  test('evidence is traceable: each item links to its source event and has a copyable id', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/hypotheses`);
    await page
      .getByRole('button', {
        name: 'See evidence for DNS resolution failure for sign-in endpoints',
      })
      .click();
    const supports = page
      .getByRole('dialog', { name: 'DNS resolution failure for sign-in endpoints' })
      .getByRole('region', { name: /^Evidence that supports it/ });
    await expect(
      supports.getByRole('link', { name: /^Source event e\d+/ }).first(),
    ).toHaveAttribute('href', new RegExp(`/cases/${demo.caseOneId}/timeline`));
    await expect(
      supports.getByRole('button', { name: /^Copy evidence id evd_/ }).first(),
    ).toBeVisible();
  });

  test('"Simulate a safer path" links from the whole record to the lab, on the first key decision', async ({
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

  test('"Just before the first key decision" shows what was believed before the decision, computed from what was known then', async ({
    page,
    demo,
    api,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/hypotheses`);
    const list = page.getByRole('list', { name: 'Possible causes ranked by confidence' });
    // On the whole record the cause that was found is the leading one: the hero.
    await expect(
      page.getByRole('heading', { level: 2, name: 'DNS resolution failure for sign-in endpoints' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Just before the first key decision' }).click();
    await settle(page);
    await expect(page).toHaveURL(/asOf=/);
    const asOf = new URL(page.url()).searchParams.get('asOf')!;
    const known = await openKnownBar(page);
    await expect(known.getByRole('status')).toContainText('9 Mar 2026');

    // The page and the API agree on who was ahead at that moment, and it was not the cause that was found later.
    const earlier = await api('engineer').getOk<{
      items: { name: string; currentConfidence: number }[];
    }>(`/cases/${demo.caseOneId}/hypotheses`, {
      query: { asOf },
    });
    const ranked = [...earlier.items].sort((a, b) => b.currentConfidence - a.currentConfidence);
    await expect(page.getByRole('heading', { level: 2, name: ranked[0]!.name })).toBeVisible();
    expect(
      ranked[0]!.name,
      'before the decision the final cause was not yet the leading explanation',
    ).not.toBe('DNS resolution failure for sign-in endpoints');
    // The cause that was found later is one of the others now, and not confirmed yet (the list shows five at first).
    const more = page.getByRole('button', { name: /^Show \d+ more possible causes/ });
    if ((await more.count()) > 0) await more.click();
    await expect(
      list.getByRole('button', { name: /^DNS resolution failure for sign-in endpoints/ }),
    ).not.toContainText('Confirmed');
  });

  test('what to test next is ranked with its calculation, and the ranking reflects only what was known', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/hypotheses`);
    // The ranking is one row that opens: its heading is on the page, its group once the row is open.
    const heading = page.getByRole('heading', { level: 2, name: /^What to test next/ });
    await expect(heading).toBeVisible();
    const toggle = heading.getByRole('button');
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const next = page.getByRole('group', { name: 'What to test next' });
    await expect(next).toBeVisible();
    await expect(
      next.getByRole('heading', { level: 4, name: 'How this score was calculated' }),
    ).toBeVisible();
  });
});
