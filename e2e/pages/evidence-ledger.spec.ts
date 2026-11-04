import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import { asPersona } from '../support/api';
import {
  confirmDialog,
  confirmWithReason,
  createThrowawayCase,
  deleteCase,
  toast,
  type ThrowawayCase,
} from '../support/flows';
import { mainRegion, openPage, settle } from '../support/ui';

const CATEGORIES = [
  'Confirmed fact',
  'Customer-reported observation',
  'Engineer assumption',
  'Diagnostic evidence',
  'AI inference',
  'Conflicting evidence',
  'Missing evidence',
  'Simulated outcome',
] as const;

/** `All categories 59` / `Confirmed fact 8` → the number at the end of a tile's name. */
const countOf = (name: string): number => Number(/(\d+)$/.exec(name.trim())![1]);

/** The sentence that says how many claims are listed and how many filters are on ("Showing 9 claims, 1 filter on."). */
const claimsStatus = (page: Page): Locator =>
  page.getByRole('status').filter({ hasText: /^(Showing \d+ claims?|No claims to show)/ });

const shownCount = async (page: Page): Promise<number> =>
  Number(/^Showing (\d+)/.exec((await claimsStatus(page).innerText()).trim())![1]);

/** The side panel: what was known at the chosen moment and, once a claim is chosen, that claim in full. */
const claimPanel = (page: Page): Locator =>
  page.getByRole('complementary', { name: 'What was known, and the selected claim' });

test.describe('[FR-EV-01] Evidence Ledger: claims classified into eight categories', () => {
  test('59 claims of Case One in eight categories whose counts add up, with each category named in words', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/evidence`);
    await expect(page.getByRole('heading', { level: 1, name: 'Evidence Ledger' })).toBeVisible();
    const tiles = page.getByRole('list', { name: 'Filter by evidence category' });
    await expect(tiles.getByRole('button', { name: /^All categories 59$/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    let total = 0;
    for (const category of CATEGORIES) {
      const tile = tiles.getByRole('button', { name: new RegExp(`^${category} \\d+$`) });
      await expect(tile, category).toBeVisible();
      total += countOf(
        (await tile.getAttribute('aria-label')) ?? (await tile.innerText()).replace(/\s+/g, ' '),
      );
    }
    expect(total, 'the eight categories add up to the 59 claims').toBe(59);
    await expect(claimsStatus(page)).toHaveText('Showing 59 claims.');
  });

  test('choosing a category filters the claims to exactly that many, and the filter is in the URL', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/evidence`);
    const tiles = page.getByRole('list', { name: 'Filter by evidence category' });
    const tile = tiles.getByRole('button', { name: /^Engineer assumption \d+$/ });
    const expected = countOf((await tile.innerText()).replace(/\s+/g, ' '));
    expect(expected).toBeGreaterThan(0);
    await tile.click();
    await expect(tile).toHaveAttribute('aria-pressed', 'true');
    await expect(claimsStatus(page)).toHaveText(
      new RegExp(`^Showing ${expected} claims?, 1 filter on\\.$`),
    );
    const list = page.getByRole('list', { name: new RegExp(`^Claims, ${expected} shown`) });
    await expect(list.getByRole('article')).toHaveCount(expected);
    for (const article of await list.getByRole('article').all()) {
      await expect(article.getByText('Engineer assumption', { exact: true }).first()).toBeVisible();
    }
    await expect(page).toHaveURL(/category=/);
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(claimsStatus(page)).toHaveText('Showing 59 claims.');
    await expect(page).not.toHaveURL(/category=/);
  });

  test('search narrows the claims by their text, and an empty result says so with a way back', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/evidence`);
    const search = page.getByRole('searchbox', { name: 'Search claims' });
    await search.fill('Conditional Access');
    // The sentence changes with the filter at once; the claims follow when the narrower request has answered.
    await expect
      .poll(() => shownCount(page), { message: 'the search narrows the list' })
      .toBeLessThan(59);
    await expect(claimsStatus(page)).toHaveText(/^Showing \d+ claims?, 1 filter on\.$/);
    const found = await shownCount(page);
    expect(found).toBeGreaterThan(0);
    await expect(
      page.getByRole('list', { name: new RegExp(`^Claims, ${found} shown`) }),
    ).toBeVisible();

    await search.fill('zzz-no-such-words-zzz');
    await expect(claimsStatus(page)).toHaveText('No claims to show.');
    await expect(
      mainRegion(page).getByRole('heading', { name: 'No claims match these filters' }),
    ).toBeVisible();
    await mainRegion(page).getByRole('button', { name: 'Clear filters' }).last().click();
    await expect(claimsStatus(page)).toHaveText('Showing 59 claims.');
  });

  test('every claim says what it is, when, who said it and how sure the model is, and cites its source event', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/evidence?category=customer_reported`);
    const first = page.getByRole('article', { name: /^Customer-reported observation:/ }).first();
    await expect(first).toBeVisible();
    await expect(
      first.getByText('Customer-reported observation', { exact: true }).first(),
    ).toBeVisible();
    await expect(first.locator('time')).toBeVisible();
    await expect(first.locator('time')).toHaveText(/\d{1,2} \w{3} 2026, \d\d:\d\d UTC/);
    await expect(first).toContainText(/Confidence \d+% \(estimate\)/);
    await expect(first.getByRole('link', { name: /^Event e\d+$/ })).toHaveAttribute(
      'href',
      new RegExp(`/cases/${demo.caseOneId}/timeline\\?sel=e\\d+`),
    );
    await expect(first.getByRole('button', { name: /^Details of this claim/ })).toBeVisible();
  });

  test('opening a claim shows its classification history, why, source, support and contradiction, and its place in the URL', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/evidence?category=ai_inference`);
    await page
      .getByRole('article', { name: /^AI inference:/ })
      .first()
      .getByRole('button', { name: /^Details of this claim/ })
      .click();
    await settle(page);
    await expect(page).toHaveURL(/sel=clm_/);
    const panel = claimPanel(page);
    await expect(panel.getByRole('heading', { level: 2, name: 'Claim details' })).toBeVisible();
    const history = panel.getByRole('list', { name: 'Classification history' });
    await expect(history).toContainText('Original AI classification (never overwritten)');
    await expect(history).toContainText('It is a proposal for review, not a fact.');
    await expect(panel.getByRole('heading', { level: 3, name: 'Why' })).toBeVisible();
    await expect(panel.getByText(/a model estimate, not statistical truth/)).toBeVisible();
    await expect(panel.getByRole('heading', { level: 3, name: 'Source' })).toBeVisible();
    await expect(
      panel.getByRole('link', { name: /^Open event e\d+ in the timeline$/ }),
    ).toBeVisible();
    await expect(
      panel.getByRole('heading', { level: 3, name: /^Supporting evidence \(\d+\)$/ }),
    ).toBeVisible();
    await expect(
      panel.getByRole('heading', { level: 3, name: /^Contradicting evidence \(\d+\)$/ }),
    ).toBeVisible();
    await panel.getByRole('button', { name: 'Close claim details' }).click();
    await expect(page).not.toHaveURL(/sel=clm_/);
  });

  test('the evidence the investigation needed is listed, and the missing items are claims of their own', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/evidence`);
    const needed = page.getByRole('group', { name: 'Evidence the investigation needed' });
    await expect(needed.getByRole('heading', { name: 'Show the 13 requirements' })).toBeVisible();
    await needed.getByRole('button', { name: 'Show the 13 requirements' }).click();
    await expect(needed.getByRole('listitem').first()).toBeVisible();
  });
});

test.describe('[FR-EV-03] only a reviewer may correct a classification', () => {
  test('the decision control is disabled for an engineer, and focusing it explains which permission is missing', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/evidence?category=ai_inference`);
    await page
      .getByRole('article', { name: /^AI inference:/ })
      .first()
      .getByRole('button', { name: /^Details of this claim/ })
      .click();
    const panel = claimPanel(page);
    await expect(panel.getByRole('heading', { level: 3, name: 'Reviewer decision' })).toBeVisible();
    const decide = panel.getByRole('button', { name: 'Confirm classification' });
    await expect(decide).toBeDisabled();
    await decide.focus();
    await expect(page.getByRole('tooltip')).toContainText(
      'does not include the "evidence:review" permission',
    );
    await decide.click({ force: true });
    await expect(confirmDialog(page)).toHaveCount(0);
  });

  test.describe('as a reviewer', () => {
    test.use({ persona: 'reviewer' });
    test.setTimeout(420_000);
    let copy: ThrowawayCase | null = null;

    test.afterAll(async () => {
      if (copy) await deleteCase(copy.id);
    });

    test('a correction needs a reason, keeps the original AI classification beside it, and is audited (on a throw-away copy)', async ({
      page,
      api,
    }) => {
      copy = await createThrowawayCase(api('engineer'));
      const claims = await api('reviewer').getOk<{
        items: { id: string; category: string; reviewState: string }[];
      }>(`/cases/${copy.id}/evidence`, { query: { category: 'ai_inference', limit: 5 } });
      const claim = claims.items.find((item) => item.reviewState === 'pending');
      expect(claim, 'the copy has an AI inference that nobody reviewed yet').toBeDefined();

      await openPage(page, `/cases/${copy.id}/evidence?category=ai_inference&sel=${claim!.id}`);
      const panel = claimPanel(page);
      await expect(
        panel.getByRole('heading', { level: 3, name: 'Reviewer decision' }),
      ).toBeVisible();
      await expect(panel.getByRole('button', { name: 'Confirm classification' })).toBeEnabled();

      await panel
        .getByRole('combobox', { name: 'Classification' })
        .selectOption({ label: 'Engineer assumption' });
      await panel.getByRole('button', { name: 'Correct classification' }).click();
      const dialog = confirmDialog(page);
      await expect(
        dialog.getByRole('heading', { name: 'Correct this classification?' }),
      ).toBeVisible();
      await expect(dialog).toContainText(
        'The original AI classification (AI inference) stays on record',
      );
      await dialog.getByRole('button', { name: 'Record the correction', exact: true }).click();
      await expect(dialog.getByText('Enter at least 5 characters.')).toBeVisible();
      await confirmWithReason(
        page,
        'Record the correction',
        'Checked the thread: the reply does not support this inference.',
      );
      await expect(toast(page, 'Classification corrected')).toBeVisible();

      // The corrected claim leaves the "AI inference" filter; the claim itself keeps both classifications.
      await openPage(page, `/cases/${copy.id}/evidence?sel=${claim!.id}`);
      const history = claimPanel(page).getByRole('list', { name: 'Classification history' });
      await expect(history).toContainText('Original AI classification (never overwritten)');
      await expect(history).toContainText('AI inference');
      await expect(history).toContainText('Reviewer correction');
      await expect(history).toContainText('Engineer assumption');
      await expect(history).toContainText(
        'Checked the thread: the reply does not support this inference.',
      );
      await expect(
        page
          .getByRole('article', { name: /^Engineer assumption:/ })
          .filter({ hasText: 'Originally classified by the AI as AI inference' }),
      ).toBeVisible();

      const audit = await asPersona('admin').getOk<{
        items: { action: string; actorId: string; caseId: string | null }[];
      }>('/audit', {
        query: { caseId: copy.id, limit: 100 },
      });
      expect(
        audit.items.some(
          (item) =>
            /claim/i.test(item.action) &&
            /review/i.test(item.action) &&
            item.actorId === 'user_riley_reviewer',
        ),
        `the review is in the audit log (actions seen: ${audit.items.map((item) => item.action).join(', ')})`,
      ).toBe(true);
    });
  });
});

test.describe('[FR-TL-06] the ledger is a window onto the past too', () => {
  test('an earlier moment in the URL shows only the claims known by then, and says how many events are withheld', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/evidence?asOf=2026-03-09T09%3A41%3A00Z`);
    await expect(
      page.getByRole('group', { name: 'What was known' }).getByRole('status'),
    ).toContainText('9 Mar 2026, 09:41 UTC');
    await expect(claimsStatus(page)).toHaveText(/^Showing \d+ claims?\./);
    const known = await shownCount(page);
    expect(known).toBeLessThan(59);
    expect(known).toBeGreaterThan(0);
    await expect(mainRegion(page)).toContainText(/withheld|later/i);
  });
});

test.describe('[FR-EV-04] the ledger shows what the record itself shows', () => {
  test('lists the patterns across events of Case One, which holds no statements that disagree, and quotes none that it does not have', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/evidence`);
    await expect(
      page.getByRole('heading', { level: 2, name: 'What the record itself shows' }),
    ).toBeVisible();
    await expect(
      page.getByText('Read without a model from the events of the whole record.'),
    ).toBeVisible();
    // A domain test pins that the shipped sample holds no two statements that cannot both stand.
    await expect(
      page.getByRole('button', { name: /^Statements that disagree \(0\)/ }),
    ).toBeVisible();
    await page.getByRole('button', { name: /^Patterns across events \(\d+\)/ }).click();
    const patterns = page.getByRole('list', { name: 'Patterns across events' });
    await expect(patterns).toContainText('The earliest moment a better step was open');
    await expect(patterns.getByRole('listitem').first()).toBeVisible();
  });
});
