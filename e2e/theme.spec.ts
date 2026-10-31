import type { Page } from '@playwright/test';
import { expect, test } from './support/fixtures';
import { PERSONAS } from './support/personas';
import {
  accountButton,
  navLink,
  openPage,
  paintedLuminance,
  runCommand,
  settle,
  themePreference,
} from './support/ui';
import { WEB_ORIGIN } from './support/env';
import { storageStateFor } from './support/fixtures';

const THEME_BUTTON = /^Theme: /;

const themeCookie = async (page: Page): Promise<string | undefined> =>
  (await page.context().cookies(WEB_ORIGIN)).find((cookie) => cookie.name === 'cg-theme')?.value;

test.describe('[FR-UX-05] theme: light, dark and system, remembered, without a flash', () => {
  test('light and dark paint differently: the dark canvas is dark, the light one is light', async ({
    page,
  }) => {
    await openPage(page, '/');
    expect(await paintedLuminance(page)).toBeGreaterThan(0.6);
    await page.getByRole('button', { name: THEME_BUTTON }).click();
    await page.getByRole('menuitemradio', { name: 'Dark' }).click();
    await expect.poll(() => paintedLuminance(page)).toBeLessThan(0.1);
  });

  test('choosing a theme sets the cg-theme cookie and the document preference; a reload keeps it', async ({
    page,
  }) => {
    await openPage(page, '/');
    await expect(page.getByRole('button', { name: 'Theme: Light' })).toBeVisible();
    await page.getByRole('button', { name: THEME_BUTTON }).click();
    await page.getByRole('menuitemradio', { name: 'Dark' }).click();
    await expect(page.getByRole('button', { name: 'Theme: Dark' })).toBeVisible();
    expect(await themeCookie(page)).toBe('dark');
    expect(await themePreference(page)).toBe('dark');

    await page.reload();
    await settle(page);
    expect(await themePreference(page)).toBe('dark');
    await expect(page.getByRole('button', { name: 'Theme: Dark' })).toBeVisible();
    expect(await paintedLuminance(page)).toBeLessThan(0.1);
  });

  test('the cookie is read on the server: with JavaScript off, the first paint is already dark', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      javaScriptEnabled: false,
      storageState: storageStateFor('engineer', 'dark'),
    });
    const page = await context.newPage();
    try {
      const response = await page.goto(`${WEB_ORIGIN}/cases`, { waitUntil: 'domcontentloaded' });
      expect(response!.status()).toBe(200);
      const html = await response!.text();
      expect(html).toMatch(/<html[^>]*data-cg-theme="dark"/);
      expect(
        await paintedLuminance(page),
        'the server-rendered page is dark before any script runs',
      ).toBeLessThan(0.1);
    } finally {
      await context.close();
    }
  });

  test('the same holds for light, and an unknown cookie value falls back to the system preference, never to a crash', async ({
    browser,
  }) => {
    const light = await browser.newContext({
      javaScriptEnabled: false,
      storageState: storageStateFor('engineer', 'light'),
    });
    const lightPage = await light.newPage();
    await lightPage.goto(`${WEB_ORIGIN}/cases`, { waitUntil: 'domcontentloaded' });
    expect(await paintedLuminance(lightPage)).toBeGreaterThan(0.6);
    await light.close();

    const odd = await browser.newContext({
      javaScriptEnabled: false,
      storageState: {
        ...storageStateFor('engineer', 'light'),
        cookies: [
          {
            name: 'cg-theme',
            value: 'purple<script>',
            domain: '127.0.0.1',
            path: '/',
            expires: -1,
            httpOnly: false,
            secure: false,
            sameSite: 'Lax',
          },
        ],
      },
    });
    const oddPage = await odd.newPage();
    const response = await oddPage.goto(`${WEB_ORIGIN}/cases`, { waitUntil: 'domcontentloaded' });
    expect(response!.status()).toBe(200);
    expect(await response!.text()).toMatch(/<html[^>]*data-cg-theme="system"/);
    await odd.close();
  });

  test('"Match system" follows prefers-color-scheme, before and after hydration', async ({
    browser,
  }) => {
    for (const scheme of ['dark', 'light'] as const) {
      const noScript = await browser.newContext({
        javaScriptEnabled: false,
        colorScheme: scheme,
        storageState: storageStateFor('engineer', 'system'),
      });
      const bare = await noScript.newPage();
      await bare.goto(`${WEB_ORIGIN}/cases`, { waitUntil: 'domcontentloaded' });
      const luminance = await paintedLuminance(bare);
      if (scheme === 'dark')
        expect(luminance, 'no flash: the system override is in the server HTML').toBeLessThan(0.1);
      else expect(luminance).toBeGreaterThan(0.6);
      await noScript.close();

      const live = await browser.newContext({
        colorScheme: scheme,
        storageState: storageStateFor('engineer', 'system'),
      });
      const page = await live.newPage();
      await page.goto(`${WEB_ORIGIN}/cases`, { waitUntil: 'load' });
      await expect(page.getByRole('heading', { level: 1, name: 'Cases' })).toBeVisible();
      await expect
        .poll(async () => {
          const value = await paintedLuminance(page);
          return scheme === 'dark' ? value < 0.1 : value > 0.6;
        })
        .toBe(true);
      await live.close();
    }
  });

  test('the command palette and the theme menu agree: "Switch to dark theme" does what the menu does', async ({
    page,
  }) => {
    await openPage(page, '/');
    await runCommand(page, 'Switch to dark theme');
    await expect(page.getByRole('button', { name: 'Theme: Dark' })).toBeVisible();
    expect(await themeCookie(page)).toBe('dark');
  });

  test('the choice survives navigation inside the app and the persona switch', async ({ page }) => {
    await openPage(page, '/');
    await page.getByRole('button', { name: THEME_BUTTON }).click();
    await page.getByRole('menuitemradio', { name: 'Dark' }).click();
    await navLink(page, 'SkillDNA Library').click();
    await expect(page.getByRole('heading', { level: 1, name: 'SkillDNA Library' })).toBeVisible();
    expect(await paintedLuminance(page)).toBeLessThan(0.1);
    await expect(accountButton(page, PERSONAS.engineer)).toBeVisible();
  });
});
