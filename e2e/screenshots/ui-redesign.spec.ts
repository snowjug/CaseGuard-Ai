import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { asPersona, type Api, type DemoIds } from '../support/api';
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
  /** Runs before the page opens (route mocks, data that the state needs); may return a clean-up for after the shot. */
  readonly before?: (page: Page, api: (persona: PersonaKey) => Api) => Promise<void | Cleanup>;
  /** Runs after the page loaded, to open the overlay or scroll the part worth showing. */
  readonly prepare?: (page: Page) => Promise<void>;
  /** A loading state: the shot is taken while the skeleton shows, so the page is not waited for. */
  readonly loading?: boolean;
  /** Browser messages this state provokes on purpose (the 5xx of a failed call). */
  readonly tolerate?: readonly RegExp[];
}

type Cleanup = () => Promise<void>;

const caseOne = (section = ''): ((ids: DemoIds) => string) => {
  return (ids) => `/cases/${ids.caseOneId}${section}`;
};

const SCREENS: readonly Screen[] = [
  { name: 'home', persona: 'manager', path: () => '/' },
  { name: 'cases', persona: 'engineer', path: () => '/cases' },
  { name: 'new-case', persona: 'engineer', path: () => '/cases/new' },
  { name: 'new-case-sample', persona: 'engineer', path: () => '/cases/new?source=sample' },
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
  { name: 'advanced', persona: 'admin', path: () => '/advanced' },
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

/** Waits for the API for a long time, so the page stays on its loading skeleton while it is photographed. */
const slowApi = async (page: Page): Promise<void> => {
  await page.route('**/api/v1/**', async (route) => {
    if (new URL(route.request().url()).pathname.includes('/dev/')) return route.continue();
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    return route.continue().catch(() => undefined);
  });
};

/** Answers every call except the identity ones with a server error, the way an API in trouble would. */
const failingApi = async (page: Page): Promise<void> => {
  await page.route('**/api/v1/**', async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname.includes('/dev/') || pathname.includes('/session/')) return route.continue();
    return route.fulfill({
      status: 500,
      contentType: 'application/problem+json',
      body: JSON.stringify({
        type: 'about:blank',
        title: 'Server error',
        status: 500,
        code: 'internal_error',
        detail: 'The server could not answer.',
        correlationId: 'corr-ui-shots',
      }),
    });
  });
};

/** A case that was added but never analysed, removed again after the shot so the other screens keep their data. */
const notAnalysedCase =
  (target: { id: string | null }): Screen['before'] =>
  async (_page, api) => {
    const reference = `CG-E2E-${Date.now().toString(36).toUpperCase()}`;
    const created = await api('engineer').postOk<{ case: { id: string } }>('/cases', {
      source: {
        type: 'paste',
        text: [
          'Notice: SYNTHETIC DEMONSTRATION TRANSCRIPT. Every organisation, person and incident below is fictional.',
          'Title: Printer queue stops after the evening update',
          `Reference: ${reference}`,
          'Product: Microsoft Teams',
          'Workload: teams-authentication',
          'Severity: C',
          '',
          '[2026-05-04 08:00 UTC] Customer: A few users cannot sign in to Teams since 07:50 UTC.',
          '[2026-05-04 08:30 UTC] Support Engineer: Looked at the sign-in logs for the affected users.',
        ].join('\n'),
      },
      options: { analyze: false },
    });
    target.id = created.case.id;
    return async () => {
      await asPersona('admin').delete(`/cases/${created.case.id}`);
    };
  };

const draftCase: { id: string | null } = { id: null };

/** The states of the main screens: loading, empty, error, not analysed, no access. */
const STATES: readonly Screen[] = [
  {
    name: 'state-home-loading',
    persona: 'manager',
    path: () => '/',
    before: slowApi,
    loading: true,
  },
  {
    name: 'state-cases-loading',
    persona: 'engineer',
    path: () => '/cases',
    before: slowApi,
    loading: true,
  },
  {
    name: 'state-review-loading',
    persona: 'engineer',
    path: caseOne('/review'),
    before: slowApi,
    loading: true,
  },
  {
    name: 'state-home-error',
    persona: 'manager',
    path: () => '/',
    before: failingApi,
    tolerate: [/Failed to load resource/],
  },
  {
    name: 'state-review-error',
    persona: 'engineer',
    path: caseOne('/review'),
    before: failingApi,
    tolerate: [/Failed to load resource/],
  },
  { name: 'state-home-empty', persona: 'otherTenant', path: () => '/' },
  { name: 'state-cases-empty', persona: 'otherTenant', path: () => '/cases' },
  { name: 'state-quality-empty', persona: 'otherTenant', path: () => '/quality' },
  { name: 'state-skills-empty', persona: 'otherTenant', path: () => '/skills' },
  {
    name: 'state-review-not-analysed',
    persona: 'engineer',
    path: () => `/cases/${draftCase.id}/review`,
    before: notAnalysedCase(draftCase),
    tolerate: [/Failed to load resource/],
  },
  {
    name: 'state-system-no-access',
    persona: 'curator',
    path: () => '/system',
    tolerate: [/Failed to load resource/],
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
      for (const screen of [...selected(SCREENS), ...selected(STATES), ...selected(OVERLAYS)]) {
        test.describe(screen.name, () => {
          test.use({ persona: screen.persona, theme: themeName });
          test(`${screen.name}-${viewportName}-${themeName}`, async ({
            page,
            demo,
            api,
            diagnostics,
          }) => {
            // The browser reports the 401 of a visit without identity and the 404 of an unknown page as console errors.
            if (screen.persona === null || screen.name === 'not-found') {
              diagnostics.allow(/Failed to load resource/);
            }
            diagnostics.allow(...(screen.tolerate ?? []));
            const cleanup = await screen.before?.(page, api);
            try {
              if (screen.loading) {
                await page.goto(screen.path(demo), { waitUntil: 'domcontentloaded' });
                await expect(page.locator('main [aria-busy="true"]').first()).toBeVisible();
              } else {
                await openPage(page, screen.path(demo)).catch(async (error: unknown) => {
                  // A first visit has no persona, so no heading may be there yet: the page itself is the screen to shoot.
                  if (screen.persona !== null) throw error;
                  await page.goto(screen.path(demo));
                });
              }
              if (screen.prepare) {
                try {
                  await screen.prepare(page);
                } catch {
                  test.skip(true, `${screen.name}: the overlay is not reachable in this build`);
                }
              }
              if (screen.loading) {
                await page.emulateMedia({ reducedMotion: 'reduce' });
                await fontsAndMotionSettled(page);
              } else {
                await settleForShot(page);
              }
              await capture(page, `${screen.name}-${viewportName}-${themeName}`);
              if (full?.test(screen.name)) {
                await capture(page, `${screen.name}-${viewportName}-${themeName}-full`, true);
              }
            } finally {
              await cleanup?.();
            }
          });
        });
      }
    });
  }
}
