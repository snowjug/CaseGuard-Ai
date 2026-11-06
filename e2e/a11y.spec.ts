import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { expect, test, type ThemeMode } from './support/fixtures';
import type { DemoIds } from './support/api';
import { PERSONAS, type PersonaKey } from './support/personas';
import { accountButton, mainRegion, navLink, openPage, runCommand, settle } from './support/ui';

/**
 * NFR-A11Y-01: automated accessibility checks of every page, in both themes, with the axe rule sets for WCAG 2.0/2.1 A and
 * AA and axe's best practices, at 1440x900 and (for the key pages) at 390x844; then the keyboard-only paths. Zero
 * violations is the bar. The only exclusion is Fluent UI's focus-trap sentinels (`[data-tabster-dummy]`): inert
 * `<i tabindex=0 aria-hidden>` elements that redirect focus and that no one can operate; axe reports them as
 * hidden-but-focusable. Nothing else is excluded (see docs/ACCESSIBILITY.md).
 */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'];

interface PageSpec {
  readonly name: string;
  readonly path: (ids: DemoIds) => string;
  readonly persona: PersonaKey;
  /** Part of the short list that is also scanned at 390x844. */
  readonly key?: boolean;
}

const PAGES: readonly PageSpec[] = [
  { name: 'Home', path: () => '/', persona: 'manager', key: true },
  { name: 'Cases', path: () => '/cases', persona: 'engineer', key: true },
  { name: 'Add a case', path: () => '/cases/new', persona: 'engineer', key: true },
  { name: 'Add a case, sample', path: () => '/cases/new?source=sample', persona: 'engineer' },
  { name: 'Case details', path: (ids) => `/cases/${ids.caseOneId}`, persona: 'engineer' },
  {
    name: 'Review',
    path: (ids) => `/cases/${ids.caseOneId}/review`,
    persona: 'reviewer',
    key: true,
  },
  {
    name: 'Timeline',
    path: (ids) => `/cases/${ids.caseOneId}/timeline`,
    persona: 'engineer',
    key: true,
  },
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
    key: true,
  },
  {
    name: 'Score',
    path: (ids) => `/cases/${ids.caseOneId}/quality`,
    persona: 'manager',
  },
  { name: 'Quality', path: () => '/quality', persona: 'manager' },
  { name: 'Skills', path: () => '/skills', persona: 'engineer' },
  { name: 'Skill detail', path: (ids) => `/skills/${ids.skillId}`, persona: 'curator' },
  { name: 'Advanced', path: () => '/advanced', persona: 'admin', key: true },
  { name: 'Usage and cost', path: () => '/efficiency', persona: 'manager', key: true },
  { name: 'Settings and audit', path: () => '/governance', persona: 'admin' },
  { name: 'System status', path: () => '/system', persona: 'admin' },
  { name: 'Guided demo', path: () => '/demo', persona: 'admin', key: true },
];

interface Finding {
  readonly rule: string;
  readonly impact: string | null | undefined;
  readonly help: string;
  readonly nodes: string[];
}

/**
 * Waits for every finite CSS animation and transition to end. A dialog fades in, and axe reads the colours it finds: half
 * way through the fade the text is blended with the page behind it and its contrast is lower than it ever is at rest.
 */
async function animationsSettled(page: Page): Promise<void> {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) =>
          animation.finished.then(
            () => undefined,
            () => undefined,
          ),
        ),
    ).then(() => undefined),
  );
}

async function scan(page: Page): Promise<Finding[]> {
  await animationsSettled(page);
  const results = await new AxeBuilder({ page })
    .withTags(TAGS)
    .exclude('[data-tabster-dummy]')
    .analyze();
  return results.violations.map((violation) => ({
    rule: violation.id,
    impact: violation.impact,
    help: violation.help,
    nodes: violation.nodes
      .slice(0, 4)
      .map(
        (node) =>
          `${node.target.join(' ')} :: ${(node.failureSummary ?? '').split('\n').slice(0, 2).join(' | ').slice(0, 200)}`,
      ),
  }));
}

const THEMES = ['light', 'dark'] as const satisfies readonly ThemeMode[];

for (const theme of THEMES) {
  for (const spec of PAGES) {
    test.describe(`[NFR-A11Y-01] axe · ${theme} · 1440x900 · ${spec.name}`, () => {
      test.use({ theme, persona: spec.persona });
      test('has no violations of WCAG 2.1 A/AA or best practice', async ({ page, demo }) => {
        await openPage(page, spec.path(demo));
        expect(await scan(page), `${spec.name} (${theme})`).toEqual([]);
      });
    });
  }
}

for (const theme of THEMES) {
  for (const spec of PAGES.filter((candidate) => candidate.key)) {
    test.describe(`[NFR-A11Y-01] axe · ${theme} · 390x844 · ${spec.name}`, () => {
      test.use({
        theme,
        persona: spec.persona,
        viewport: { width: 390, height: 844 },
        hasTouch: true,
      });
      test('has no violations on a phone', async ({ page, demo }) => {
        await openPage(page, spec.path(demo));
        expect(await scan(page), `${spec.name} (${theme}, phone)`).toEqual([]);
      });
    });
  }
}

test.describe('[NFR-A11Y-01] open overlays are scanned too', () => {
  test('the command palette, the keyboard shortcuts dialog and the persona picker have no violations', async ({
    page,
  }) => {
    await openPage(page, '/');
    await page.keyboard.press('Control+K');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();
    expect(await scan(page), 'command palette').toEqual([]);
    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();

    await page.keyboard.press('?');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
    expect(await scan(page), 'keyboard shortcuts').toEqual([]);
    await page.keyboard.press('Escape');

    await accountButton(page, PERSONAS.engineer).click();
    await page.getByRole('menuitem', { name: /Switch persona/ }).click();
    await expect(
      page
        .getByRole('dialog', { name: 'Choose a development identity' })
        .getByRole('button', { name: /^Ava/ }),
    ).toBeVisible();
    expect(await scan(page), 'persona picker').toEqual([]);
  });
});

interface StateSpec {
  readonly name: string;
  readonly persona: PersonaKey | null;
  readonly path: (ids: DemoIds) => string;
  /** Brings the page into the state to scan (opening a claim, previewing a case). */
  readonly prepare?: (page: Page, ids: DemoIds) => Promise<void>;
  /** Browser messages this state provokes on purpose (the 404 of a case that is not there). */
  readonly tolerate?: readonly RegExp[];
}

const PHONE = { width: 390, height: 844 } as const;

/**
 * The states that sit behind a click or a URL: every tab of the pages that have them, an open side panel, an earlier
 * moment, the wizard's preview step, Presentation Mode, the not-found and the no-identity states. Scanning only each
 * page's first view would leave most of the interface unchecked.
 */
const STATES: readonly StateSpec[] = [
  { name: 'Home, first visit with no identity chosen', persona: null, path: () => '/' },
  { name: 'Home in Presentation Mode', persona: 'manager', path: () => '/?present=1' },
  {
    name: 'A case that does not exist',
    persona: 'engineer',
    path: () => '/cases/case_does_not_exist',
    tolerate: [/Failed to load resource: the server responded with a status of 404/],
  },
  {
    name: 'Score of a case that does not exist',
    persona: 'manager',
    path: () => '/cases/case_does_not_exist/quality',
    tolerate: [/Failed to load resource: the server responded with a status of 404/],
  },
  {
    name: 'Timeline of a case that does not exist',
    persona: 'engineer',
    path: () => '/cases/case_does_not_exist/timeline',
    tolerate: [/Failed to load resource: the server responded with a status of 404/],
  },
  {
    name: 'Evidence of a case that does not exist',
    persona: 'engineer',
    path: () => '/cases/case_does_not_exist/evidence',
    tolerate: [/Failed to load resource: the server responded with a status of 404/],
  },
  {
    name: 'Add a case, the check step',
    persona: 'engineer',
    path: () => '/cases/new?source=sample',
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Check case' }).click();
      await expect(page.getByRole('heading', { name: 'Check what will be created' })).toBeVisible();
      await expect(page.getByRole('group', { name: 'Result of the check' })).toBeVisible();
    },
  },
  {
    name: 'Add a case, the paste area with a problem',
    persona: 'engineer',
    path: () => '/cases/new',
    prepare: async (page) => {
      await page.getByRole('textbox', { name: /^Case text/ }).fill('x'.repeat(200_001));
      await expect(page.getByText(/This is over the limit of/)).toBeVisible();
    },
  },
  {
    name: 'Timeline at an earlier moment with an event open',
    persona: 'engineer',
    path: (ids) => `/cases/${ids.caseOneId}/timeline?sel=e06&asOf=2026-03-09T12%3A10%3A00Z`,
  },
  {
    name: 'Evidence with a claim open',
    persona: 'reviewer',
    path: (ids) => `/cases/${ids.caseOneId}/evidence?category=ai_inference`,
    prepare: async (page) => {
      await page
        .getByRole('article')
        .first()
        .getByRole('button', { name: /^Details of this claim/ })
        .click();
      await expect(page.getByRole('heading', { level: 2, name: 'Claim details' })).toBeVisible();
    },
  },
  {
    name: 'Possible causes with another cause open',
    persona: 'engineer',
    path: (ids) => `/cases/${ids.caseOneId}/hypotheses`,
    prepare: async (page) => {
      // The third cause by confidence: the leading one is the hero, so the list starts at the second.
      await page
        .getByRole('list', { name: 'Possible causes ranked by confidence' })
        .getByRole('button')
        .nth(1)
        .click();
      await settle(page);
      await expect(
        page.getByRole('dialog', { name: 'Conditional Access or MFA policy enforcement' }),
      ).toBeVisible();
    },
  },
  {
    name: 'Timeline with "What was known then" open',
    persona: 'engineer',
    path: (ids) => `/cases/${ids.caseOneId}/timeline`,
    prepare: async (page) => {
      const bar = page.getByRole('button', { name: /^What was known then/ });
      await bar.click();
      await expect(bar).toHaveAttribute('aria-expanded', 'true');
      await expect(page.getByRole('slider', { name: 'Time cursor' })).toBeVisible();
    },
  },
  {
    name: 'Timeline with the filters open',
    persona: 'engineer',
    path: (ids) => `/cases/${ids.caseOneId}/timeline`,
    prepare: async (page) => {
      await page.getByRole('button', { name: /^Filters/ }).click();
      await expect(page.getByLabel('Zoom from')).toBeVisible();
    },
  },
  {
    name: 'Evidence with "What was known then" and its sections open',
    persona: 'engineer',
    path: (ids) => `/cases/${ids.caseOneId}/evidence`,
    prepare: async (page) => {
      for (const name of [
        /^What was known then/,
        /^What is still missing/,
        /^What the record itself shows/,
        /^Patterns across events/,
      ]) {
        const toggle = page.getByRole('button', { name });
        await toggle.click();
        await expect(toggle, String(name)).toHaveAttribute('aria-expanded', 'true');
      }
    },
  },
  {
    name: 'Evidence with the filters open',
    persona: 'engineer',
    path: (ids) => `/cases/${ids.caseOneId}/evidence`,
    prepare: async (page) => {
      await page.getByRole('button', { name: /^Filters/ }).click();
      await expect(page.getByLabel('Review state')).toBeVisible();
    },
  },
  {
    name: 'Possible causes with "What was known then" and what to test next open',
    persona: 'engineer',
    path: (ids) => `/cases/${ids.caseOneId}/hypotheses`,
    prepare: async (page) => {
      for (const name of [
        /^What was known then/,
        /^What to test next/,
        /^The formula/,
        /^Blocked by the safety policy/,
      ]) {
        const toggle = page.getByRole('button', { name });
        if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
        await expect(toggle, String(name)).toHaveAttribute('aria-expanded', 'true');
      }
      await expect(page.getByRole('group', { name: 'What to test next' })).toBeVisible();
    },
  },
  ...(['evidence', 'decision', 'graph', 'review'] as const).map((tab): StateSpec => ({
    name: `What if, ${tab} tab`,
    persona: 'reviewer',
    path: (ids) => `/cases/${ids.caseOneId}/counterfactual?tab=${tab}`,
  })),
  ...(['effort', 'warnings', 'skills', 'coaching', 'compare'] as const).map((tab): StateSpec => ({
    name: `Score, ${tab} tab`,
    persona: 'manager',
    path: (ids) => `/cases/${ids.caseTwoId}/quality?tab=${tab}`,
  })),
  ...(['governance', 'versions', 'validation', 'cases'] as const).map((tab): StateSpec => ({
    name: `Skill detail, ${tab} tab`,
    persona: 'curator',
    path: (ids) => `/skills/${ids.skillId}?tab=${tab}`,
  })),
  ...(
    [
      'model',
      'prompts',
      'scoring',
      'retention',
      'redaction',
      'flags',
      'export',
      'roles',
      'audit',
      'reviews',
      'operations',
    ] as const
  ).map((tab): StateSpec => ({
    name: `Settings and audit, ${tab} section`,
    persona: 'admin',
    path: () => `/governance?tab=${tab}`,
  })),
  {
    name: 'Settings and audit as an engineer (permission needed)',
    persona: 'engineer',
    path: () => '/governance',
  },
  {
    name: 'System status as a curator (permission needed)',
    persona: 'curator',
    path: () => '/system',
  },
];

for (const theme of THEMES) {
  for (const state of STATES) {
    test.describe(`[NFR-A11Y-01] axe · ${theme} · state · ${state.name}`, () => {
      test.use({ theme, persona: state.persona });
      test('has no violations', async ({ page, demo, diagnostics }) => {
        diagnostics.allow(...(state.tolerate ?? []));
        await openPage(page, state.path(demo));
        await state.prepare?.(page, demo);
        await settle(page);
        expect(await scan(page), `${state.name} (${theme})`).toEqual([]);
      });
    });
  }
}

test.describe('[NFR-A11Y-01] the phone navigation and the stacked layouts', () => {
  test.use({ viewport: PHONE, hasTouch: true });

  test('the bottom bar has the five places, no violations, and a target of at least 44 px for each', async ({
    page,
  }) => {
    await openPage(page, '/cases');
    const bar = page.getByRole('navigation', { name: 'Primary, mobile' });
    await expect(bar.getByRole('link')).toHaveText([
      /^Home/,
      /^Cases/,
      /^Quality/,
      /^Skills/,
      /^Advanced/,
    ]);
    expect(await scan(page), 'bottom bar').toEqual([]);
    for (const link of await bar.getByRole('link').all()) {
      const box = await link.boundingBox();
      expect(box?.height ?? 0, 'target height').toBeGreaterThanOrEqual(44);
      expect(box?.width ?? 0, 'target width').toBeGreaterThanOrEqual(44);
    }
  });
});

/**
 * True when focusing the element visibly changes the page around it. An outline or a box shadow on the element is the
 * usual indicator; Fluent also draws some on a wrapper or a pseudo-element (the underline of an input), so otherwise
 * the pixels around the control are compared while it holds focus and after it has lost it (the caret is hidden: it
 * blinks and is not an indicator).
 */
async function showsFocus(page: Page, target: Locator): Promise<boolean> {
  const handle = await target.elementHandle();
  if (!handle) return false;
  const own = await handle.evaluate((element) => {
    const style = getComputedStyle(element);
    return (
      (style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0) ||
      style.boxShadow !== 'none'
    );
  });
  if (own) return true;
  const clip = await handle.evaluate((element) => {
    const root =
      element.closest('.fui-Input, .fui-Textarea, .fui-Select, .fui-Combobox') ?? element;
    const rect = root.getBoundingClientRect();
    // Wide enough for a ring that a wrapper draws around the control (the header search box does).
    const margin = 16;
    return {
      x: Math.max(0, rect.x - margin),
      y: Math.max(0, rect.y - margin),
      width: rect.width + 2 * margin,
      height: rect.height + 2 * margin,
    };
  });
  const style = await page.addStyleTag({ content: '* { caret-color: transparent !important; }' });
  const focused = await page.screenshot({ clip });
  await handle.evaluate((element) => (element as HTMLElement).blur());
  const blurred = await page.screenshot({ clip });
  await handle.focus();
  await style.evaluate((node) => {
    (node as Element).remove();
  });
  return !focused.equals(blurred);
}

test.describe('[NFR-A11Y-01] keyboard only', () => {
  test('the first Tab reaches "Skip to main content", and Enter moves focus to the main region', async ({
    page,
  }) => {
    await openPage(page, '/cases');
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to main content' });
    await expect(skip).toBeFocused();
    expect(await showsFocus(page, skip), 'the skip link shows where focus is').toBe(true);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#main-content$/);
    await expect(page.locator('#main-content')).toBeFocused();
  });

  test('Tab walks the header and the navigation in a sensible order, and every stop shows a visible focus indicator', async ({
    page,
  }) => {
    await openPage(page, '/cases');
    const stops: string[] = [];
    for (let index = 0; index < 14; index += 1) {
      await page.keyboard.press('Tab');
      const focused = page.locator(':focus');
      const name = (
        (await focused.getAttribute('aria-label')) ?? (await focused.innerText().catch(() => ''))
      )
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 40);
      stops.push(name);
      expect(await showsFocus(page, focused), `stop ${index + 1} (${name}) shows focus`).toBe(true);
    }
    expect(stops[0]).toBe('Skip to main content');
    expect(
      stops.some((stop) => /CaseGuard AI/.test(stop)),
      'the brand link is in the tab order',
    ).toBe(true);
    expect(
      stops.some((stop) => /Home|Cases/.test(stop)),
      'the navigation is reached by keyboard',
    ).toBe(true);
  });

  test('the navigation is operable by keyboard: focus a destination, Enter opens it, focus lands in the page', async ({
    page,
  }) => {
    await openPage(page, '/cases');
    await navLink(page, 'Skills').focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/skills$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Skills' })).toBeVisible();
    await expect(page.locator('#main-content')).toBeFocused();
  });

  test('the command palette opens with Ctrl+K, takes focus, closes with Escape and returns focus; a command navigates', async ({
    page,
  }) => {
    await openPage(page, '/');
    const trigger = page.getByRole('button', { name: 'Search or jump to' });
    await trigger.focus();
    await page.keyboard.press('Control+K');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();
    await expect(palette.getByRole('combobox', { name: 'Search commands' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();
    await expect(trigger, 'focus returns to where it was').toBeFocused();

    await runCommand(page, 'Go to Usage and cost');
    await expect(page).toHaveURL(/\/efficiency$/);
  });

  test('"g" then a letter navigates, "?" shows the shortcuts, and shortcuts stay quiet while typing in a field', async ({
    page,
  }) => {
    await openPage(page, '/');
    await page.keyboard.press('g');
    await page.keyboard.press('s');
    await expect(page).toHaveURL(/\/skills$/);
    await page.keyboard.press('?');
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    await openPage(page, '/cases');
    const search = page.getByRole('searchbox', { name: 'Search' });
    await search.focus();
    // No pause between the keys: the field keeps its text locally and writes it to the address afterwards, so nothing is
    // lost however fast it is typed, and "g" then "d" typed into a field does not go to the Guided demo.
    await page.keyboard.type('gd', { delay: 0 });
    await expect(search).toHaveValue('gd');
    await expect(page).toHaveURL(/\/cases\?(.*&)?q=gd(&.*)?$/);
  });

  test('a dialog traps focus while it is open and gives focus back when it closes', async ({
    page,
  }) => {
    await openPage(page, '/');
    await accountButton(page, PERSONAS.engineer).click();
    await page.getByRole('menuitem', { name: /Switch persona/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Choose a development identity' });
    await expect(dialog).toBeVisible();
    for (let index = 0; index < 12; index += 1) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(() =>
        Boolean(document.activeElement?.closest('[role="dialog"]')),
      );
      expect(inside, `focus stays inside the dialog after ${index + 1} Tab presses`).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.locator(':focus')).toBeVisible();
  });

  test('the what-if tabs are keyboard controls: an arrow key moves between them and Enter selects', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/counterfactual`);
    const tabs = page.getByRole('tablist', { name: 'What if sections' });
    await tabs.getByRole('tab', { name: 'Compare' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(tabs.getByRole('tab', { name: 'Evidence per step' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(tabs.getByRole('tab', { name: 'Evidence per step' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  test('the investigation graph is reachable and readable without a pointer', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/counterfactual?tab=graph`);
    await settle(page);
    const panel = page.getByRole('tabpanel', { name: 'Graph' });
    await expect(panel).toBeVisible();
    const canvas = panel.getByRole('group', {
      name: /^Investigation graph with \d+ nodes and \d+ connections\. Tab to enter the graph/,
    });
    await expect(canvas, 'the canvas says how to operate it').toBeVisible();

    // One Tab stop enters the graph, arrow keys move between nodes, Enter selects, Escape clears.
    const entry = canvas.locator('[role="button"][tabindex="0"]');
    await expect(entry).toHaveCount(1);
    await entry.focus();
    await expect(entry).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(canvas.locator('[role="button"]:focus')).toHaveCount(1);
    await page.keyboard.press('Enter');
    await expect(canvas.getByRole('button', { pressed: true })).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(canvas.getByRole('button', { pressed: true })).toHaveCount(0);

    // Every node is named, and the same graph is a table without the canvas.
    for (const node of await canvas.getByRole('button').all()) {
      expect(
        ((await node.getAttribute('aria-label')) ?? '').length,
        'a node has an accessible name',
      ).toBeGreaterThan(3);
    }
    await panel
      .getByText('Text alternative: the graph as a summary, a node table and a connection table')
      .click();
    await expect(panel.getByRole('table', { name: /^Nodes in reading order/ })).toBeVisible();
  });
});

test.describe('[NFR-A11Y-01] prefers-reduced-motion is respected', () => {
  test('with the system preference on, an infinite animation is cut to one short run; with it off, it is left alone', async ({
    page,
  }) => {
    await openPage(page, '/');
    const iterations = () =>
      page.evaluate(() => {
        const probe = document.createElement('div');
        probe.style.cssText = 'animation: cg-shimmer 1s infinite;';
        document.body.append(probe);
        const value = getComputedStyle(probe).animationIterationCount;
        probe.remove();
        return value;
      });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    expect(await iterations()).toBe('infinite');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect.poll(iterations).toBe('1');
  });

  test('the "Reduce motion" setting in the account menu does the same, and is remembered after a reload', async ({
    page,
  }) => {
    await openPage(page, '/');
    await accountButton(page, PERSONAS.engineer).click();
    await page.getByRole('menuitemcheckbox', { name: 'Reduce motion' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-cg-reduced-motion', 'true');
    await page.reload();
    await settle(page);
    await expect(page.locator('html')).toHaveAttribute('data-cg-reduced-motion', 'true');
    await expect(mainRegion(page)).toBeVisible();
  });
});
