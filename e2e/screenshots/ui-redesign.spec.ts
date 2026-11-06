import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import type { DemoIds } from '../support/api';
import { ROOT } from '../support/env';
import { expect, test } from '../support/fixtures';
import type { PersonaKey } from '../support/personas';
import { fontsAndMotionSettled, openPage, settle } from '../support/ui';

/**
 * Screenshots of every screen (and the main overlays) for the UI redesign review. The same file produces the BEFORE and
 * the AFTER sets: only the environment differs. Nothing runs unless `UI_SHOTS=1`, so `pnpm screenshots` is unaffected.
 *
 *   UI_SHOTS=1 UI_SHOTS_DIR=docs/ui-redesign/before UI_SHOTS_THEMES=light \
 *     pnpm exec playwright test --project=screenshots e2e/screenshots/ui-redesign.spec.ts
 *
 * Environment (all optional):
 *   UI_SHOTS_DIR        output directory, relative to the repository root (default docs/ui-redesign/after)
 *   UI_SHOTS_VIEWPORTS  desktop (1440x900) and/or mobile (375x812), comma separated (default both)
 *   UI_SHOTS_THEMES     light and/or dark, comma separated (default both)
 *   UI_SHOTS_ONLY       regular expression: only the screens whose name matches
 *   UI_SHOTS_FULL       regular expression: also write a full-page `<name>-full.png` for the screens that match
 *   UI_SHOTS_SCALE      device scale factor (default 1: small files)
 */
test.skip(process.env.UI_SHOTS !== '1', 'set UI_SHOTS=1 to take the redesign screenshots');
test.describe.configure({ mode: 'serial' });
test.setTimeout(240_000);

const OUT_DIR = path.resolve(ROOT, process.env.UI_SHOTS_DIR ?? 'docs/ui-redesign/after');
const only = process.env.UI_SHOTS_ONLY ? new RegExp(process.env.UI_SHOTS_ONLY) : null;
const full = process.env.UI_SHOTS_FULL ? new RegExp(process.env.UI_SHOTS_FULL) : null;
const scale = Number.parseFloat(process.env.UI_SHOTS_SCALE ?? '1') || 1;
const listOf = (value: string | undefined, fallback: string[]): string[] =>
  value ? value.split(',').map((part) => part.trim()) : fallback;

const VIEWPORTS = {
  desktop: { viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false },
  mobile: { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true },
} as const;
type ViewportName = keyof typeof VIEWPORTS;
type ThemeName = 'light' | 'dark';

const viewportNames = listOf(process.env.UI_SHOTS_VIEWPORTS, ['desktop', 'mobile']).filter(
  (name): name is ViewportName => name in VIEWPORTS,
);
const themeNames = listOf(process.env.UI_SHOTS_THEMES, ['light', 'dark']).filter(
  (name): name is ThemeName => name === 'light' || name === 'dark',
);

test.beforeAll(() => {
  mkdirSync(OUT_DIR, { recursive: true });
});

async function settleForShot(page: Page): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await settle(page);
  await fontsAndMotionSettled(page);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

async function capture(page: Page, file: string, fullPage = false): Promise<void> {
  const target = path.join(OUT_DIR, `${file}.png`);
  await page.screenshot({
    path: target,
    animations: 'disabled',
    caret: 'hide',
    scale: 'css',
    fullPage,
  });
  // The committed sets stay small: a shot over 1 MB is a sign the page is far too long for a viewport shot.
  expect(statSync(target).size, `${file}.png is over 1 MB`).toBeLessThan(1_000_000);
}

interface Screen {
  readonly name: string;
  readonly persona: PersonaKey | null;
  readonly path: (ids: DemoIds) => string;
  /** Runs after the page loaded, to open the overlay or scroll the part worth showing. */
  readonly prepare?: (page: Page) => Promise<void>;
}

const caseOne = (section = ''): ((ids: DemoIds) => string) => {
  return (ids) => `/cases/${ids.caseOneId}${section}`;
};

const SCREENS: readonly Screen[] = [
  { name: 'home', persona: 'manager', path: () => '/' },
  { name: 'cases', persona: 'engineer', path: () => '/cases' },
  { name: 'new-case', persona: 'engineer', path: () => '/cases/new' },
  { name: 'case-overview', persona: 'engineer', path: caseOne() },
  { name: 'case-review', persona: 'reviewer', path: caseOne('/review') },
  { name: 'case-timeline', persona: 'engineer', path: caseOne('/timeline') },
  { name: 'case-evidence', persona: 'engineer', path: caseOne('/evidence') },
  { name: 'case-hypotheses', persona: 'engineer', path: caseOne('/hypotheses') },
  { name: 'case-counterfactual', persona: 'reviewer', path: caseOne('/counterfactual') },
  { name: 'case-quality', persona: 'manager', path: caseOne('/quality') },
  { name: 'case-report', persona: 'reviewer', path: caseOne('/report') },
  { name: 'quality-portfolio', persona: 'manager', path: () => '/quality' },
  { name: 'skills', persona: 'curator', path: () => '/skills' },
  { name: 'skill-detail', persona: 'curator', path: (ids) => `/skills/${ids.skillId}` },
  { name: 'efficiency', persona: 'manager', path: () => '/efficiency' },
  { name: 'governance', persona: 'admin', path: () => '/governance' },
  { name: 'system', persona: 'admin', path: () => '/system' },
  { name: 'demo', persona: 'admin', path: () => '/demo' },
  {
    name: 'not-found',
    persona: 'engineer',
    path: () => '/this-page-does-not-exist',
  },
];

/** Overlays are opened from a normal page; a prepare that cannot find its control skips the shot instead of failing the run. */
const OVERLAYS: readonly Screen[] = [
  {
    name: 'overlay-command-palette',
    persona: 'engineer',
    path: () => '/',
    prepare: async (page) => {
      await page.keyboard.press('Control+K');
      await expect(page.getByRole('dialog')).toBeVisible();
    },
  },
  {
    name: 'overlay-shortcuts',
    persona: 'engineer',
    path: () => '/cases',
    prepare: async (page) => {
      await page.keyboard.press('?');
      await expect(page.getByRole('dialog')).toBeVisible();
    },
  },
  { name: 'first-visit', persona: null, path: () => '/' },
];

const selected = (screens: readonly Screen[]): readonly Screen[] =>
  screens.filter((screen) => (only ? only.test(screen.name) : true));

for (const viewportName of viewportNames) {
  for (const themeName of themeNames) {
    test.describe(`${viewportName} ${themeName}`, () => {
      test.use({ ...VIEWPORTS[viewportName], deviceScaleFactor: scale });
      for (const screen of [...selected(SCREENS), ...selected(OVERLAYS)]) {
        test.describe(screen.name, () => {
          test.use({ persona: screen.persona, theme: themeName });
          test(`${screen.name}-${viewportName}-${themeName}`, async ({
            page,
            demo,
            diagnostics,
          }) => {
            // The browser reports the 401 of a visit without identity and the 404 of an unknown page as console errors.
            if (screen.persona === null || screen.name === 'not-found') {
              diagnostics.allow(/Failed to load resource/);
            }
            await openPage(page, screen.path(demo)).catch(async (error: unknown) => {
              // A first visit has no persona, so no heading may be there yet: the page itself is the screen to shoot.
              if (screen.persona !== null) throw error;
              await page.goto(screen.path(demo));
            });
            if (screen.prepare) {
              try {
                await screen.prepare(page);
              } catch {
                test.skip(true, `${screen.name}: the overlay is not reachable in this build`);
              }
            }
            await settleForShot(page);
            await capture(page, `${screen.name}-${viewportName}-${themeName}`);
            if (full?.test(screen.name)) {
              await capture(page, `${screen.name}-${viewportName}-${themeName}-full`, true);
            }
          });
        });
      }
    });
  }
}
