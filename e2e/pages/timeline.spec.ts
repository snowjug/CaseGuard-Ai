import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import { mainRegion, openPage, settle } from '../support/ui';

const EVENT_COUNT = 31;

/** "What was known then" is one bar, closed until it is opened: the time cursor and the counts are inside it. */
async function openKnownBar(page: Page): Promise<Locator> {
  const toggle = page.getByRole('button', { name: /^What was known then/ });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  return page.getByRole('region', { name: /^What was known then/ });
}

test.describe('[FR-TL-01] Timeline: every event in order, with what was known when', () => {
  test('reconstructs the 31 events of Case One in time order, with the gap since the previous event and the flags that matter', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/timeline`);
    await expect(page.getByRole('heading', { level: 1, name: 'Timeline' })).toBeVisible();
    await expect(page.getByText(`Showing ${EVENT_COUNT} of ${EVENT_COUNT} events.`)).toBeVisible();
    const events = page.getByRole('list', { name: new RegExp(`^Events, ${EVENT_COUNT} shown`) });
    await expect(events).toBeVisible();

    // The first event is the customer's email; the gap to the next one is shown (delays are a quality signal).
    const items = events.locator(':scope > li');
    await expect(items).toHaveCount(EVENT_COUNT);
    await expect(items.first()).toContainText('Customer email');
    await expect(items.first()).toContainText('Event e01');
    await expect(items.nth(1)).toContainText('18 min after the previous event');
    // e03 is the first key decision; e09 revokes sign-in sessions, a destructive action.
    const e03 = items.filter({
      has: page.getByRole('button', { name: /^Details of Teams sign-in - information needed/ }),
    });
    await expect(e03).toContainText('Key decision');
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

  test('"Show only" toggles narrow the list to delays, repeated diagnostics or key decisions, and Clear filters restores it', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/timeline`);
    const filters = page.getByRole('search', { name: 'Filter events' });
    const status = filters.getByRole('status');
    await filters.getByRole('button', { name: 'Key decisions' }).click();
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

  test('an event opens in a drawer with its claims and evidence; the selection is in the URL and survives a reload', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/timeline`);
    await page
      .getByRole('button', { name: /^Details of Sign-in log query result, 9 Mar 2026, 11:41 UTC/ })
      .click();
    await settle(page);
    await expect(page).toHaveURL(/sel=e06/);
    // The drawer is a modal dialog: the page behind it is hidden from assistive technology while it is open.
    const drawer = page.getByRole('dialog', { name: 'Event details' });
    await expect(drawer.getByText(/claim/i).first()).toBeVisible();
    await page.reload();
    await expect(page).toHaveURL(/sel=e06/);
    await settle(page);
    await expect(
      page
        .getByRole('dialog', { name: 'Event details' })
        .getByText(/Sign-in log query result/)
        .first(),
    ).toBeVisible();
  });

  test('the time cursor shows only what was known: moving it back withholds later events and says how many', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/timeline`);
    const known = await openKnownBar(page);
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
    const known = await openKnownBar(page);
    await expect(known.getByRole('status')).toContainText('9 Mar 2026, 09:41 UTC');
    await expect(
      page.getByRole('search', { name: 'Filter events' }).getByRole('status'),
    ).toContainText('Showing 3 of');
  });

  test('confidence over time is shown as an estimate with a text alternative', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/timeline`);
    const chart = page.getByRole('group', { name: 'Confidence over time' });
    await expect(chart).toBeVisible();
    await expect(chart.getByText('Estimated').first()).toBeVisible();
    // The caveat is behind the help button of the chart, not in a banner above it.
    await chart.getByRole('button', { name: 'About Confidence over time' }).click();
    await expect(
      page.getByText(
        /These are model estimates from an authored knowledge pack, not statistical truth/,
      ),
    ).toBeVisible();
    await expect(
      chart.getByRole('img', { name: /Confidence in each possible cause over time/ }).first(),
    ).toBeVisible();
  });
});
