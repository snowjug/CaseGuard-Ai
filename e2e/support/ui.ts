import { expect, type Locator, type Page, type Request } from '@playwright/test';
import { PERSONAS, shortName, type PersonaInfo, type PersonaKey } from './personas';

/** In-flight requests to the API (`/api/...`) per page, filled by `trackApiRequests`. */
const inFlight = new WeakMap<Page, Map<Request, number>>();

/** A request that has not finished after this long is not what the page is waiting for (it was most likely abandoned). */
const STALE_REQUEST_MS = 60_000;

/** Starts counting the page's requests to the API, so `settle` can tell when the data of a page has arrived. */
export function trackApiRequests(page: Page): void {
  if (inFlight.has(page)) return;
  const pending = new Map<Request, number>();
  inFlight.set(page, pending);
  const isApi = (request: Request): boolean => new URL(request.url()).pathname.startsWith('/api/');
  page.on('request', (request) => {
    if (isApi(request)) pending.set(request, performance.now());
  });
  const done = (request: Request): void => {
    pending.delete(request);
  };
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  // A navigation to another document abandons whatever the old one was loading, without always saying so.
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) pending.clear();
  });
}

/**
 * Waits until the page has stopped loading: no request to the API is in flight, no skeleton or retry spinner
 * (`aria-busy`) is left in the main region, and that stayed true for `quietMs`. Next's link prefetching never goes
 * quiet, so the network-idle load state is useless here.
 */
export async function settle(page: Page, quietMs = 600): Promise<void> {
  const pending = inFlight.get(page);
  let idleSince: number | null = null;
  await expect
    .poll(
      async () => {
        const now = performance.now();
        const live = [...(pending?.values() ?? [])].filter(
          (startedAt) => now - startedAt < STALE_REQUEST_MS,
        );
        const busy = await page.locator('main [aria-busy="true"]').count();
        if (live.length > 0 || busy > 0) {
          idleSince = null;
          return false;
        }
        idleSince ??= now;
        return now - idleSince >= quietMs;
      },
      { message: 'the page never finished loading its data', timeout: 90_000, intervals: [200] },
    )
    .toBe(true);
}

/** Opens a page of the app and waits until its heading is there and its data has loaded. */
export async function openPage(page: Page, path: string): Promise<void> {
  await page.goto(path, { waitUntil: 'load' });
  await expect(page.getByRole('main')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await settle(page);
}

export const mainRegion = (page: Page): Locator => page.getByRole('main');

export const primaryNav = (page: Page): Locator =>
  page.getByRole('navigation', { name: 'Primary' });

/** The link of the side navigation whose accessible name starts with `label` (badges add text after it). */
export const navLink = (page: Page, label: string): Locator =>
  primaryNav(page).getByRole('link', { name: new RegExp(`^${escapeRegExp(label)}`) });

export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The header button that opens the account menu: its name is the persona's name and role. */
export const accountButton = (page: Page, persona: PersonaInfo): Locator =>
  page.getByRole('button', { name: `${persona.displayName} ${persona.roleLabel}` });

/** Switches identity through the persona picker, the way a presenter does. */
export async function switchPersonaInUi(page: Page, to: PersonaKey): Promise<void> {
  const target = PERSONAS[to];
  const choose = page.getByRole('button', { name: 'Choose persona' });
  if ((await choose.count()) > 0) {
    await choose.click();
  } else {
    await page
      .getByRole('button', { name: /\((synthetic)\) .+/ })
      .first()
      .click();
    await page.getByRole('menuitem', { name: /Switch persona/ }).click();
  }
  const dialog = page.getByRole('dialog', { name: 'Choose a development identity' });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole('button', { name: new RegExp(`^${escapeRegExp(shortName(target))}`) })
    .click();
  await expect(dialog).toBeHidden();
  await expect(accountButton(page, target)).toBeVisible();
  await settle(page);
}

/** Types into the command palette and runs the first command that matches. */
export async function runCommand(page: Page, query: string): Promise<void> {
  await page.keyboard.press('Control+K');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await palette.getByRole('combobox', { name: 'Search commands' }).fill(query);
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
}

/** The theme preference the document carries (`light`, `dark` or `system`), set by the server from the `cg-theme` cookie. */
export async function themePreference(page: Page): Promise<string> {
  return page.evaluate(() => document.documentElement.dataset.cgTheme ?? '');
}

/**
 * Relative luminance (0 dark, 1 light) of the colour the page is painted with. This is what a person sees, whatever the
 * preference says, so it is what the theme specs and the first-paint check assert on.
 */
export async function paintedLuminance(page: Page): Promise<number> {
  return page.evaluate(() => {
    const element = document.querySelector('.fui-FluentProvider') ?? document.body;
    const [red = 0, green = 0, blue = 0] = (
      getComputedStyle(element).backgroundColor.match(/[\d.]+/g) ?? []
    ).map(Number);
    const linear = (channel: number): number => {
      const value = channel / 255;
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
  });
}

/** Waits until web fonts and CSS animations have settled, for stable screenshots and measurements. */
export async function fontsAndMotionSettled(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}
