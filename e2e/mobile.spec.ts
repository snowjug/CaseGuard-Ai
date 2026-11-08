import type { Page } from '@playwright/test';
import { expect, test } from './support/fixtures';
import { listCases, type DemoIds } from './support/api';
import { PERSONAS, type PersonaKey } from './support/personas';
import { mainRegion, openPage, settle } from './support/ui';

/**
 * Key mobile layout behaviour (the `mobile` project: 390x844, touch): no horizontal page scroll on any page (also at the
 * 320 px of WCAG 1.4.10), a bottom bar with the five places, tables that scroll inside a labelled region instead of
 * squeezing, and primary actions that can be reached and are big enough to touch.
 */
interface PageSpec {
  readonly name: string;
  readonly path: (ids: DemoIds) => string;
  readonly persona: PersonaKey | null;
}

const PAGES: readonly PageSpec[] = [
  { name: 'First visit', path: () => '/', persona: null },
  { name: 'Home', path: () => '/', persona: 'manager' },
  { name: 'Cases', path: () => '/cases', persona: 'engineer' },
  { name: 'Add a case', path: () => '/cases/new', persona: 'engineer' },
  { name: 'Add a case, sample', path: () => '/cases/new?source=sample', persona: 'engineer' },
  { name: 'Case details', path: (ids) => `/cases/${ids.caseOneId}`, persona: 'engineer' },
  { name: 'Review', path: (ids) => `/cases/${ids.caseOneId}/review`, persona: 'engineer' },
  {
    name: 'Review of the second case',
    path: (ids) => `/cases/${ids.caseTwoId}/review`,
    persona: 'engineer',
  },
  { name: 'Report', path: (ids) => `/cases/${ids.caseOneId}/report`, persona: 'engineer' },
  { name: 'Timeline', path: (ids) => `/cases/${ids.caseOneId}/timeline`, persona: 'engineer' },
  {
    name: 'Evidence',
    path: (ids) => `/cases/${ids.caseOneId}/evidence`,
    persona: 'engineer',
  },
  {
    name: 'Possible causes',
    path: (ids) => `/cases/${ids.caseOneId}/hypotheses`,
    persona: 'engineer',
  },
  {
    name: 'What if',
    path: (ids) => `/cases/${ids.caseOneId}/counterfactual`,
    persona: 'reviewer',
  },
  {
    name: 'Score',
    path: (ids) => `/cases/${ids.caseOneId}/quality`,
    persona: 'manager',
  },
  { name: 'Quality', path: () => '/quality', persona: 'manager' },
  { name: 'Skills', path: () => '/skills', persona: 'engineer' },
  { name: 'Skill detail', path: (ids) => `/skills/${ids.skillId}`, persona: 'curator' },
  { name: 'Advanced', path: () => '/advanced', persona: 'admin' },
  { name: 'Usage and cost', path: () => '/efficiency', persona: 'manager' },
  { name: 'Settings and audit', path: () => '/governance', persona: 'admin' },
  { name: 'System status', path: () => '/system', persona: 'admin' },
  { name: 'Guided demo', path: () => '/demo', persona: 'admin' },
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

test.describe('[NFR-A11Y-01] reflow at 320 CSS px: no page scrolls sideways (WCAG 1.4.10)', () => {
  for (const spec of PAGES) {
    test.describe(spec.name, () => {
      test.use({ persona: spec.persona });
      test('fits the width of the narrowest phone, with touch-sized controls', async ({
        page,
        demo,
      }) => {
        await page.setViewportSize({ width: 320, height: 640 });
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

test.describe('[FR-UX-02] the bottom bar', () => {
  test('replaces the side navigation on a phone and holds the five places; choosing one navigates and lights it', async ({
    page,
  }) => {
    await openPage(page, '/cases');
    await expect(
      page.getByRole('navigation', { name: 'Primary', exact: true }),
      'the side navigation is replaced by a bottom bar on a phone',
    ).toBeHidden();
    const bar = page.getByRole('navigation', { name: 'Primary, mobile' });
    await expect(bar).toBeVisible();
    for (const label of ['Home', 'Cases', 'Quality', 'Skills', 'Advanced']) {
      await expect(bar.getByRole('link', { name: new RegExp(`^${label}`) }), label).toBeVisible();
    }
    await expect(bar.getByRole('link', { name: /^Cases/ })).toHaveAttribute('aria-current', 'page');
    await bar.getByRole('link', { name: /^Skills/ }).tap();
    await expect(page).toHaveURL(/\/skills$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Skills' })).toBeVisible();
    await expect(bar.getByRole('link', { name: /^Skills/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('stays on screen while the page scrolls', async ({ page }) => {
    await openPage(page, '/cases');
    const bar = page.getByRole('navigation', { name: 'Primary, mobile' });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(bar).toBeInViewport();
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

  test.describe('the comparison of two cases', () => {
    test.use({ persona: 'manager' });
    test('a table that stays a table scrolls inside a focusable, named region, and the page stays put', async ({
      page,
      demo,
    }) => {
      await openPage(page, `/cases/${demo.caseTwoId}/quality?tab=compare`);
      const region = page.getByRole('region', {
        name: 'Comparison of the two cases, scrollable',
      });
      await expect(region).toHaveAttribute('tabindex', '0');
      const table = region.getByRole('table');
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

  test.describe('System status', () => {
    test.use({ persona: 'admin' });
    test('the dependencies become a list of cards on a phone, one per dependency, and nothing scrolls sideways', async ({
      page,
      api,
    }) => {
      const health = await api('admin').getOk<{ dependencies: unknown[] }>('/system/health');
      await openPage(page, '/system');
      const dependencies = page.getByRole('list', { name: 'Dependencies and their health' });
      await expect(dependencies).toBeVisible();
      await expect(dependencies.getByRole('listitem')).toHaveCount(health.dependencies.length);
      await expect(page.getByRole('table', { name: 'Dependencies and their health' })).toHaveCount(
        0,
      );
      expect((await overflow(page)).page).toBe(0);
    });
  });
});

test.describe('[FR-UX-02] primary actions are reachable and touchable', () => {
  test('"Add a case" is on screen on the cases page, and the controls of the header are at least 24px', async ({
    page,
  }) => {
    await openPage(page, '/cases');
    const ingest = mainRegion(page).getByRole('link', { name: 'Add a case' }).first();
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
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
    await page.keyboard.press('Escape');
    await settle(page);
  });

  test('the time cursor works by touch-sized controls: previous and next event buttons are present on a phone', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/timeline`);
    // The time cursor lives in the "What was known then" bar, which is closed until it is opened.
    const bar = page.getByRole('button', { name: /^What was known then/ });
    await bar.tap();
    await expect(bar).toHaveAttribute('aria-expanded', 'true');
    const known = page.getByRole('region', { name: /^What was known then/ });
    await known.getByRole('button', { name: 'Previous event' }).tap();
    await settle(page);
    await expect(page).toHaveURL(/asOf=/);
  });
});
