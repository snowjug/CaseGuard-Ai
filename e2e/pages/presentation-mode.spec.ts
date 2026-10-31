import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import type { DemoState } from '../support/api';
import { PERSONAS } from '../support/personas';
import { accountButton, openPage, settle } from '../support/ui';
import { confirmDialog } from '../support/flows';

const strip = (page: Page) => page.getByRole('region', { name: 'Presenter strip' });

test.describe('[FR-UX-06] Presentation Mode: the story, with the development controls out of the way', () => {
  test('?present=1 shows the presenter strip with the progress derived from stored data, and hides the development controls', async ({
    page,
  }) => {
    await openPage(page, '/?present=1');
    const presenter = strip(page);
    await expect(presenter).toBeVisible();
    await expect(presenter.getByText('Demo guide · 13 of 13 done')).toBeVisible();
    await expect(
      presenter.getByRole('progressbar', { name: 'Demo progress: 13 of 13 steps complete' }),
    ).toBeVisible();
    await expect(presenter).toContainText('Last step: Outcomes compared');
    await expect(presenter).toContainText('present as Support Manager');

    const banner = page.getByRole('banner');
    await expect(
      banner.getByText('Synthetic demo data').first(),
      'the honesty label stays',
    ).toBeVisible();
    await expect(
      banner.getByText('Development identity'),
      'the development badge is hidden',
    ).toHaveCount(0);
    await accountButton(page, PERSONAS.engineer).click();
    await expect(page.getByRole('menuitem', { name: /Switch persona/ })).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: 'Keyboard shortcuts' })).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('the Present button toggles it, and Exit presentation brings the development controls back', async ({
    page,
  }) => {
    await openPage(page, '/');
    await expect(strip(page)).toHaveCount(0);
    await page.getByRole('button', { name: 'Present', exact: true }).click();
    await expect(strip(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Present', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await strip(page).getByRole('button', { name: 'Exit presentation' }).click();
    await expect(strip(page)).toHaveCount(0);
    await expect(page.getByRole('banner').getByText('Development identity').first()).toBeVisible();
  });

  test('the next action is a link outlined for the audience, and the page keeps clear of the strip', async ({
    page,
    api,
  }) => {
    const state = await api('engineer').getOk<DemoState>('/demo/state');
    const last = state.steps.find((step) => step.isNextAction);
    expect(last, 'the story is complete: its last step is the one shown as next').toBeDefined();
    await openPage(page, '/?present=1');
    // The destination follows the data (the comparison of the two cases once both exist): take it from the API.
    const next = strip(page).getByRole('link', { name: last!.actionLabel, exact: true });
    await expect(next).toHaveAttribute('href', last!.route);
    await expect(next).toHaveClass(/cg-presenter-target/);
    const outline = await next.evaluate((element) => getComputedStyle(element).outlineStyle);
    expect(outline).toBe('solid');
    // The shell pads the page by the height of the strip, so nothing is hidden behind it.
    const [stripBox, footerBox] = await Promise.all([
      strip(page).boundingBox(),
      page.getByRole('contentinfo').boundingBox(),
    ]);
    expect(stripBox).not.toBeNull();
    expect(footerBox).not.toBeNull();
    await page.getByRole('contentinfo').scrollIntoViewIfNeeded();
    const after = await page.getByRole('contentinfo').boundingBox();
    expect(after!.y + after!.height).toBeLessThanOrEqual(stripBox!.y + 1);
  });

  test('with reduced motion the outline stops pulsing but stays', async ({ page, api }) => {
    const state = await api('engineer').getOk<DemoState>('/demo/state');
    const last = state.steps.find((step) => step.isNextAction);
    await openPage(page, '/?present=1');
    const next = strip(page).getByRole('link', { name: last!.actionLabel, exact: true });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    expect(
      await next.evaluate((element) => getComputedStyle(element).animationIterationCount),
    ).toBe('infinite');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect
      .poll(() => next.evaluate((element) => getComputedStyle(element).animationIterationCount))
      .toBe('1');
    expect(await next.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe('solid');
  });

  test('presenter notes are concise and one click away, and a persona of the right role is one click away too', async ({
    page,
  }) => {
    await openPage(page, '/?present=1');
    await strip(page).getByRole('button', { name: 'Presenter notes' }).click();
    const notes = page
      .getByRole('dialog', { name: 'Presenter notes: Outcomes compared' })
      .or(page.getByLabel('Presenter notes: Outcomes compared'));
    await expect(notes.first()).toBeVisible();
    await expect(notes.first()).toContainText(/estimate/i);
    await page.keyboard.press('Escape');

    await strip(page).getByRole('button', { name: 'Switch to Morgan Manager (synthetic)' }).click();
    await settle(page);
    await expect(accountButton(page, PERSONAS.manager)).toBeVisible();
    await expect(strip(page).getByRole('button', { name: /^Switch to/ })).toHaveCount(0);
  });

  test('reset is gated by permission: an engineer sees it disabled', async ({ page }) => {
    await openPage(page, '/?present=1');
    await expect(strip(page).getByRole('button', { name: 'Reset demo' })).toBeDisabled();
  });
});

test.describe('[FR-UX-06] Presentation Mode: the administrator can reset, behind a confirmation', () => {
  test.use({ persona: 'admin' });

  test('"Reset demo" opens a confirmation that says what is erased and what is kept; cancelling changes nothing', async ({
    page,
    api,
  }) => {
    await openPage(page, '/?present=1');
    await strip(page).getByRole('button', { name: 'Reset demo' }).click();
    const dialog = confirmDialog(page);
    await expect(dialog.getByRole('heading', { name: 'Reset the demo data?' })).toBeVisible();
    await expect(dialog).toContainText(
      'erases the cases, analysis results and skills of the synthetic demo tenant',
    );
    await expect(dialog).toContainText('Users, settings and the audit trail are kept');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    const state = await api('admin').getOk<{ steps: { completed: boolean }[] }>('/demo/state');
    expect(state.steps.filter((step) => step.completed)).toHaveLength(13);
  });
});
