import { expect, test } from '../support/fixtures';
import { mainRegion, openPage, settle } from '../support/ui';

const EVENT_COUNT = 31;

test.describe('[FR-TL-01] Case Timeline: every event in order, with what was known when', () => {
  test('reconstructs the 31 events of Case One in time order, with the gap since the previous event and the flags that matter', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/timeline`);
    await expect(page.getByRole('heading', { level: 1, name: 'Case Timeline' })).toBeVisible();
    await expect(page.getByText(`Showing ${EVENT_COUNT} of ${EVENT_COUNT} events.`)).toBeVisible();
    const events = page.getByRole('list', { name: new RegExp(`^Events, ${EVENT_COUNT} shown`) });
    await expect(events).toBeVisible();

    // The first event is the customer's email; the gap to the next one is shown (delays are a quality signal).
    const items = events.locator(':scope > li');
    await expect(items).toHaveCount(EVENT_COUNT);
    await expect(items.first()).toContainText('Customer email');
    await expect(items.first()).toContainText('Event e01');
    await expect(items.nth(1)).toContainText('18 min after the previous event');
    // e03 is the first decision fork; e09 revokes sign-in sessions, a destructive action.
    const e03 = items.filter({
      has: page.getByRole('button', { name: /^Details of Teams sign-in - information needed/ }),
    });
    await expect(e03).toContainText('Decision fork');
    await expect(e03).toContainText('Very high customer effort');
    const e09 = items.filter({
      has: page.getByRole('button', { name: /^Details of Revoke sign-in sessions/ }),
    });
    await expect(e09).toContainText('Destructive action');
    // Long text is clamped with an expand control, never cut off silently.
    await expect(
      events.getByRole('button', { name: 'Show more event text' }).first(),
    ).toBeVisible();
  });

  test('"Show only" toggles narrow the list to delays, repeated diagnostics or decision forks, and Clear filters restores it', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/timeline`);
    const filters = page.getByRole('search', { name: 'Filter events' });
    const status = filters.getByRole('status');
    await filters.getByRole('button', { name: 'Decision forks' }).click();
    await expect(status).toContainText(/Showing \d+ of 31 events, 1 filter on\./);
    const forksOnly = Number(/Showing (\d+) of/.exec((await status.textContent()) ?? '')![1]);
    expect(forksOnly).toBeGreaterThan(0);
    expect(forksOnly).toBeLessThan(EVENT_COUNT);
    await expect(
      page
        .getByRole('list', { name: new RegExp(`^Events, ${forksOnly} shown`) })
        .locator(':scope > li'),
    ).toHaveCount(forksOnly);

    await filters.getByRole('button', { name: 'Clear filters' }).click();
    await expect(status).toHaveText(`Showing ${EVENT_COUNT} of ${EVENT_COUNT} events.`);
    await filters.getByRole('button', { name: 'Repeated diagnostics' }).click();
    await expect(status).not.toContainText(`Showing ${EVENT_COUNT} of`);
    await filters.getByRole('button', { name: 'Clear filters' }).click();
  });

  test('an event opens in a side panel with its claims and evidence; the selection is in the URL and survives a reload', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/timeline`);
    await page
      .getByRole('button', { name: /^Details of Sign-in log query result, 9 Mar 2026, 11:41 UTC/ })
      .click();
    await settle(page);
    await expect(page).toHaveURL(/sel=e06/);
    await expect(mainRegion(page).getByText(/claim/i).first()).toBeVisible();
    await page.reload();
    await expect(page).toHaveURL(/sel=e06/);
    await settle(page);
    await expect(
      mainRegion(page)
        .getByText(/Sign-in log query result/)
        .first(),
    ).toBeVisible();
  });

  test('the time cursor shows only what was known: moving it back withholds later events and says how many', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/timeline`);
    const known = page.getByRole('group', { name: 'What was known' });
    await expect(known.getByRole('status')).toContainText(
      'Showing everything up to 12 Mar 2026, 10:20 UTC',
    );
    await expect(known.getByRole('button', { name: 'Next event' })).toBeDisabled();

    await known.getByRole('button', { name: 'Previous event' }).click();
    await settle(page);
    await expect(page).toHaveURL(/asOf=/);
    await expect(known.getByRole('status')).not.toContainText('12 Mar 2026, 10:20 UTC');
    await expect(mainRegion(page)).toContainText(/\d+ later events? (are |is )?withheld|withheld/i);
    const shown = Number(
      /Showing (\d+) of/.exec(
        (await page
          .getByRole('search', { name: 'Filter events' })
          .getByRole('status')
          .textContent()) ?? '',
      )?.[1] ?? '0',
    );
    expect(shown).toBeLessThan(EVENT_COUNT);

    // The slider is a real keyboard control: Home goes to the first event, End to the last.
    const slider = known.getByRole('slider', { name: 'Time cursor' });
    await slider.focus();
    await page.keyboard.press('Home');
    await settle(page);
    await expect(known.getByRole('status')).toContainText('9 Mar 2026, 09:12 UTC');
    await page.keyboard.press('End');
    await settle(page);
    await expect(known.getByRole('status')).toContainText(
      'Showing everything up to 12 Mar 2026, 10:20 UTC',
    );
  });

  test('an earlier moment is a link: asOf in the URL opens the same view for whoever receives it', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/timeline?asOf=2026-03-09T09%3A41%3A00Z`);
    const known = page.getByRole('group', { name: 'What was known' });
    await expect(known.getByRole('status')).toContainText('9 Mar 2026, 09:41 UTC');
    await expect(
      page.getByRole('search', { name: 'Filter events' }).getByRole('status'),
    ).toContainText('Showing 3 of');
  });

  test('hypothesis confidence over time is shown as an estimate with a text alternative', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/timeline`);
    const chart = page.getByRole('group', { name: 'Hypothesis confidence over time' });
    await expect(chart).toBeVisible();
    await expect(chart.getByText('Estimated').first()).toBeVisible();
    await expect(
      chart.getByText('Confidence values are model estimates, not statistical truth.'),
    ).toBeVisible();
    await expect(
      chart.getByRole('img', { name: /Hypothesis confidence over time/ }).first(),
    ).toBeVisible();
  });
});
