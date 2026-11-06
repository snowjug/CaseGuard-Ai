import path from 'node:path';
import { mkdirSync } from 'node:fs';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import { DOCS_SCREENSHOTS_DIR } from '../support/env';
import { fontsAndMotionSettled, openPage, settle } from '../support/ui';
import type { DemoIds } from '../support/api';
import type { PersonaKey } from '../support/personas';

/**
 * Real screenshots of the running product (production build, seeded synthetic demo, deterministic provider) for the
 * documentation, written to docs/assets/screenshots/ with stable names. Nothing is hidden or masked: what is in the file
 * is what the page showed. Motion is reduced so animations do not catch a frame half way, and the page is waited for
 * until its data, its fonts and its layout have settled.
 *
 *   pnpm screenshots
 */
test.describe.configure({ mode: 'serial' });
test.setTimeout(240_000);

test.beforeAll(() => {
  mkdirSync(DOCS_SCREENSHOTS_DIR, { recursive: true });
});

async function capture(page: Page, name: string): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await settle(page);
  await fontsAndMotionSettled(page);
  // One more frame so layout that depends on measured sizes (virtual lists, charts) has run.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await page.screenshot({
    path: path.join(DOCS_SCREENSHOTS_DIR, `${name}.png`),
    animations: 'disabled',
    caret: 'hide',
    scale: 'css',
  });
}

/** Scrolls so that the element starts at the top of the page area, with a little air above it. */
async function atTop(target: Locator): Promise<void> {
  await target.evaluate((element) => element.scrollIntoView({ block: 'start' }));
  await target.page().evaluate(() => window.scrollBy(0, -16));
}

interface Shot {
  readonly name: string;
  readonly persona: PersonaKey;
  readonly path: (ids: DemoIds) => string;
  /** Runs after the page loaded, to bring the part worth showing into view. */
  readonly prepare?: (page: Page) => Promise<void>;
}

const SHOTS: readonly Shot[] = [
  { name: 'command-center', persona: 'manager', path: () => '/' },
  { name: 'case-timeline', persona: 'engineer', path: (ids) => `/cases/${ids.caseOneId}/timeline` },
  {
    name: 'evidence-ledger',
    persona: 'engineer',
    path: (ids) => `/cases/${ids.caseOneId}/evidence`,
  },
  {
    name: 'hypothesis-arena',
    persona: 'engineer',
    path: (ids) => `/cases/${ids.caseOneId}/hypotheses`,
    prepare: async (page) => {
      // The ranking of the nine explanations and the detail of the leading one, not the time cursor above them.
      await atTop(page.getByRole('list', { name: 'Possible causes ranked by confidence' }));
    },
  },
  {
    name: 'counterfactual-lab',
    persona: 'reviewer',
    path: (ids) => `/cases/${ids.caseOneId}/counterfactual`,
    prepare: async (page) => {
      // The actual and the simulated path, diverging from the decision moment: the signature view.
      await atTop(page.getByRole('radiogroup', { name: 'Simulated path strategies' }));
    },
  },
  { name: 'quality-review', persona: 'manager', path: (ids) => `/cases/${ids.caseOneId}/quality` },
  { name: 'skilldna-library', persona: 'curator', path: () => '/skills' },
  { name: 'efficiency', persona: 'manager', path: () => '/efficiency' },
  { name: 'governance', persona: 'admin', path: () => '/governance' },
  { name: 'system-health', persona: 'admin', path: () => '/system' },
  { name: 'demo-guide', persona: 'admin', path: () => '/demo' },
  { name: 'presentation-mode', persona: 'manager', path: () => '/?present=1' },
];

test.describe('light theme, 1440x900', () => {
  for (const shot of SHOTS) {
    test.describe(shot.name, () => {
      test.use({ persona: shot.persona, theme: 'light' });
      test(`captures ${shot.name}.png`, async ({ page, demo }) => {
        await openPage(page, shot.path(demo));
        await shot.prepare?.(page);
        await capture(page, shot.name);
        await expect(page.getByRole('main')).toBeVisible();
      });
    });
  }
});

test.describe('dark theme, 1440x900', () => {
  for (const shot of [SHOTS[0]!, SHOTS[1]!, SHOTS[4]!]) {
    test.describe(shot.name, () => {
      test.use({ persona: shot.persona, theme: 'dark' });
      test(`captures ${shot.name}-dark.png`, async ({ page, demo }) => {
        await openPage(page, shot.path(demo));
        await shot.prepare?.(page);
        await capture(page, `${shot.name}-dark`);
      });
    });
  }
});

test.describe('390x844 on a phone', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  for (const shot of [SHOTS[0]!, SHOTS[1]!, SHOTS[4]!]) {
    test.describe(shot.name, () => {
      test.use({ persona: shot.persona, theme: 'light' });
      test(`captures mobile-${shot.name}.png`, async ({ page, demo }) => {
        await openPage(page, shot.path(demo));
        await shot.prepare?.(page);
        await capture(page, `mobile-${shot.name}`);
      });
    });
  }
});
