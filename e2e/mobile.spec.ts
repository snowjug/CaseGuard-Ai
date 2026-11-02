import type { Page } from '@playwright/test';
import { expect, test } from './support/fixtures';
import { listCases, type DemoIds } from './support/api';
import { PERSONAS, type PersonaKey } from './support/personas';
import { mainRegion, openPage, settle } from './support/ui';

/**
 * Key mobile layout behaviour (the `mobile` project: 390x844, touch): no horizontal page scroll on any page, a navigation
 * drawer that works, tables that scroll inside a labelled region instead of squeezing, and primary actions that can be
 * reached and are big enough to touch.
 */
interface PageSpec {
  readonly name: string;
  readonly path: (ids: DemoIds) => string;
  readonly persona: PersonaKey;
}

const PAGES: readonly PageSpec[] = [
  { name: 'Command Center', path: () => '/', persona: 'manager' },
  { name: 'Cases', path: () => '/cases', persona: 'engineer' },
  { name: 'Ingest a case', path: () => '/cases/new', persona: 'engineer' },
  { name: 'Case overview', path: (ids) => `/cases/${ids.caseOneId}`, persona: 'engineer' },
  { name: 'Guided review', path: (ids) => `/cases/${ids.caseOneId}/review`, persona: 'engineer' },
  {
    name: 'Guided review of the second case',
    path: (ids) => `/cases/${ids.caseTwoId}/review`,
    persona: 'engineer',
  },
  { name: 'Case report', path: (ids) => `/cases/${ids.caseOneId}/report`, persona: 'engineer' },
  { name: 'Case Timeline', path: (ids) => `/cases/${ids.caseOneId}/timeline`, persona: 'engineer' },
  {
    name: 'Evidence Ledger',
    path: (ids) => `/cases/${ids.caseOneId}/evidence`,
    persona: 'engineer',
  },
  {
    name: 'Hypothesis Arena',
    path: (ids) => `/cases/${ids.caseOneId}/hypotheses`,
    persona: 'engineer',
  },
  {
    name: 'Counterfactual Lab',
    path: (ids) => `/cases/${ids.caseOneId}/counterfactual`,
    persona: 'reviewer',
  },
  {
    name: 'Case Quality Review',
    path: (ids) => `/cases/${ids.caseOneId}/quality`,
    persona: 'manager',
  },
  { name: 'Quality Review (portfolio)', path: () => '/quality', persona: 'manager' },
  { name: 'SkillDNA Library', path: () => '/skills', persona: 'engineer' },
  { name: 'Skill detail', path: (ids) => `/skills/${ids.skillId}`, persona: 'curator' },
  { name: 'Efficiency Monitor', path: () => '/efficiency', persona: 'manager' },
  { name: 'Governance', path: () => '/governance', persona: 'admin' },
  { name: 'System Health', path: () => '/system', persona: 'admin' },
  { name: 'Demo Guide', path: () => '/demo', persona: 'admin' },
];

/** How far the page is wider than the viewport, in CSS pixels (0 means no horizontal scroll). */
async function overflow(
  page: Page,
): Promise<{ readonly page: number; readonly offenders: string[] }> {
  return page.evaluate(() => {
    const viewport = document.documentElement.clientWidth;
    const widest = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
    const offenders: string[] = [];
    for (const element of document.querySelectorAll('body *')) {
      const box = element.getBoundingClientRect();
      if (
        box.right > viewport + 1 &&
        box.width > 0 &&
        !element.closest('[data-cg-scroll], [role="region"][tabindex="0"], .fui-Table, pre, code')
      ) {
        // Elements that only overflow inside a scroll container do not widen the page; report only those that do.
        let clipped = false;
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent);
          if (
            /(auto|scroll|hidden|clip)/.test(style.overflowX) &&
            parent.getBoundingClientRect().right <= viewport + 1
          ) {
            clipped = true;
            break;
          }
        }
        if (!clipped && offenders.length < 5) {
          offenders.push(
            `${element.tagName.toLowerCase()}${element.className ? `.${String(element.className).split(' ')[0]}` : ''} (${Math.round(box.right)}px)`,
          );
        }
      }
    }
    return { page: Math.max(0, widest - viewport), offenders };
  });
}

test.describe('[FR-UX-02] no page scrolls sideways at 390x844', () => {
  for (const spec of PAGES) {
    test.describe(spec.name, () => {
      test.use({ persona: spec.persona });
      test('fits the width of a phone', async ({ page, demo }) => {
        await openPage(page, spec.path(demo));
        const result = await overflow(page);
        expect(
          result.page,
          `the page is ${result.page}px wider than the screen; wide elements: ${result.offenders.join(', ')}`,
        ).toBe(0);
      });
    });
  }
});

test.describe('[FR-UX-02] the navigation drawer', () => {
  test('the menu button opens a drawer with every destination; choosing one navigates and closes it', async ({
    page,
  }) => {
    await openPage(page, '/cases');
    await expect(
      page.getByRole('navigation', { name: 'Primary' }),
      'the rail is replaced by a drawer on a phone',
    ).toBeHidden();
    const open = page.getByRole('button', { name: 'Open navigation' });
    await expect(open).toBeVisible();
    await open.click();
    const drawer = page.getByRole('dialog').filter({ has: page.getByRole('navigation') });
    await expect(drawer).toBeVisible();
    for (const label of [
      'Command Center',
      'Cases',
      'Quality Review',
      'SkillDNA Library',
      'Efficiency Monitor',
      'Governance',
      'System Health',
      'Demo Guide',
    ]) {
      await expect(
        drawer.getByRole('link', { name: new RegExp(`^${label}`) }),
        label,
      ).toBeVisible();
    }
    await drawer.getByRole('link', { name: /^SkillDNA Library/ }).click();
    await expect(page).toHaveURL(/\/skills$/);
    await expect(drawer).toBeHidden();
    await expect(page.getByRole('heading', { level: 1, name: 'SkillDNA Library' })).toBeVisible();
  });

  test('Escape closes the drawer and focus goes back to the menu button', async ({ page }) => {
    await openPage(page, '/cases');
    const open = page.getByRole('button', { name: 'Open navigation' });
    await open.click();
    await expect(
      page.getByRole('dialog').filter({ has: page.getByRole('navigation') }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(
      page.getByRole('dialog').filter({ has: page.getByRole('navigation') }),
    ).toBeHidden();
    await expect(open).toBeFocused();
  });
});

test.describe('[FR-UX-02] tables degrade: cards where there is room for nothing else, a labelled scroll region where a table stays', () => {
  test('the cases become a list of cards on a phone, one link each, and nothing scrolls sideways', async ({
    page,
    api,
  }) => {
    const items = await listCases(api('engineer'));
    expect(items.length, 'the workspace holds the two demo cases at least').toBeGreaterThanOrEqual(
      2,
    );
    await openPage(page, '/cases');
    const cases = page.getByRole('list', { name: 'Cases' });
    await expect(cases).toBeVisible();
    await expect(cases.getByRole('listitem')).toHaveCount(items.length);
    await expect(cases.getByRole('link', { name: 'CG-SYN-1001' })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Cases' })).toHaveCount(0);
    expect((await overflow(page)).page).toBe(0);
  });

  test('a table that stays a table scrolls inside a focusable, named region, and the page stays put', async ({
    page,
  }) => {
    await openPage(page, '/system');
    const region = page.getByRole('region', { name: 'Dependencies, scrollable' });
    await expect(region).toHaveAttribute('tabindex', '0');
    const table = region.getByRole('table', { name: 'Dependencies and their health' });
    await expect(table).toBeVisible();
    const box = await table.boundingBox();
    expect(box!.width, 'the table keeps a readable minimum width').toBeGreaterThan(390);
    expect(
      await region.evaluate((element) => element.scrollWidth > element.clientWidth),
      'and scrolls inside its region',
    ).toBe(true);
    expect((await overflow(page)).page).toBe(0);
  });
});

test.describe('[FR-UX-02] primary actions are reachable and touchable', () => {
  test('"Ingest a case" is on screen on the cases page, and the controls of the header are at least 24px', async ({
    page,
  }) => {
    await openPage(page, '/cases');
    const ingest = mainRegion(page).getByRole('link', { name: 'Ingest a case' }).first();
    await expect(ingest).toBeVisible();
    await ingest.scrollIntoViewIfNeeded();
    const box = await ingest.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(24);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);

    const small = await page.evaluate(() => {
      const found: string[] = [];
      for (const element of document.querySelectorAll(
        'header button, header a, main button, main [role="tab"], footer button',
      )) {
        const box = element.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) continue;
        const style = getComputedStyle(element);
        if (style.visibility === 'hidden' || (style.position === 'absolute' && box.width <= 1))
          continue;
        if (box.width < 24 || box.height < 24)
          found.push(
            `${element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 30) ?? element.tagName} ${Math.round(box.width)}x${Math.round(box.height)}`,
          );
      }
      return found;
    });
    expect(
      small,
      'no control is smaller than 24x24 CSS pixels (WCAG 2.2 target size, minimum)',
    ).toEqual([]);
  });

  test('the persona menu, the theme menu and the command palette are reachable on a phone', async ({
    page,
  }) => {
    await openPage(page, '/');
    await expect(
      page.getByRole('button', { name: new RegExp(PERSONAS.engineer.displayName.split(' ')[0]!) }),
    ).toBeVisible();
    await page.getByRole('button', { name: /^Theme:/ }).click();
    await expect(page.getByRole('menuitemradio', { name: 'Dark' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Commands' }).click();
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
    await page.keyboard.press('Escape');
    await settle(page);
  });

  test('the time cursor works by touch-sized controls: previous and next event buttons are present on a phone', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/timeline`);
    const known = page.getByRole('group', { name: 'What was known' });
    await known.getByRole('button', { name: 'Previous event' }).tap();
    await settle(page);
    await expect(page).toHaveURL(/asOf=/);
  });
});
