import { expect, test as base, type BrowserContext, type Page } from '@playwright/test';
import { API_ORIGIN, WEB_ORIGIN } from './env';
import { PERSONAS, type PersonaKey } from './personas';
import { asPersona, demoIds, ensurePortfolioDemo, type Api, type DemoIds } from './api';
import { trackApiRequests } from './ui';

export type ThemeMode = 'light' | 'dark' | 'system';

export interface IdentityOptions {
  /** The synthetic persona signed in before the page loads; `null` leaves the browser without an identity. */
  persona: PersonaKey | null;
  /** The `cg-theme` cookie the server reads for the first paint. */
  theme: ThemeMode;
}

/** Browser problems a spec did not expect: collected by the `diagnostics` fixture and asserted when the test ends. */
export interface Diagnostics {
  /** Console errors, uncaught page errors and CSP violations seen so far. */
  readonly problems: readonly string[];
  /** Tolerates browser messages that match (for example the 4xx a spec provokes on purpose). */
  allow(...patterns: RegExp[]): void;
}

interface Fixtures {
  diagnostics: Diagnostics;
  /** An API client for a persona, calling the API directly (for setup and for checking what the UI did). */
  api: (persona: PersonaKey) => Api;
  /** The seeded demo (13 of 13 steps) and its ids; every spec that reads the story starts here. */
  demo: DemoIds;
}

export function storageStateFor(
  persona: PersonaKey | null,
  theme: ThemeMode,
  origin: string = WEB_ORIGIN,
) {
  const host = new URL(origin).hostname;
  const cookie = (name: string, value: string) => ({
    name,
    value,
    domain: host,
    path: '/',
    expires: -1,
    httpOnly: false,
    secure: false,
    sameSite: 'Lax' as const,
  });
  return {
    cookies: [cookie('cg-theme', theme)],
    origins:
      persona === null
        ? []
        : [
            {
              origin,
              localStorage: [{ name: 'cg-persona', value: PERSONAS[persona].id }],
            },
          ],
  };
}

/** The browser noise that is not a product problem: a deprecation the browser prints for a Fluent UI slider. */
const IGNORED_BROWSER_MESSAGES = [/slider-vertical/];

function instrument(context: BrowserContext, problems: string[], allowed: RegExp[]): void {
  const record = (text: string): void => {
    if (IGNORED_BROWSER_MESSAGES.some((pattern) => pattern.test(text))) return;
    if (allowed.some((pattern) => pattern.test(text))) return;
    problems.push(text);
  };
  const attach = (page: Page): void => {
    trackApiRequests(page);
    page.on('console', (message) => {
      if (message.type() === 'error') record(`console.error: ${message.text().slice(0, 400)}`);
    });
    page.on('pageerror', (error) => record(`pageerror: ${error.message.slice(0, 400)}`));
  };
  context.on('page', attach);
  for (const page of context.pages()) attach(page);
  // Content-Security-Policy violations are reported to the page, not always to the console.
  void context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      console.error(
        `CSP violation: ${event.violatedDirective} blocked ${event.blockedURI} (${event.sourceFile}:${event.lineNumber})`,
      );
    });
  });
}

export const test = base.extend<IdentityOptions & Fixtures>({
  persona: ['engineer', { option: true }],
  theme: ['light', { option: true }],

  storageState: async ({ persona, theme }, use) => {
    await use(storageStateFor(persona, theme));
  },

  diagnostics: [
    async ({ context }, use) => {
      const problems: string[] = [];
      const allowed: RegExp[] = [];
      instrument(context, problems, allowed);
      await use({
        get problems() {
          return problems;
        },
        allow: (...patterns) => {
          allowed.push(...patterns);
        },
      });
      expect(problems, 'the browser reported errors the test did not expect').toEqual([]);
    },
    { auto: true },
  ],

  // Playwright reads the fixtures a function needs from its first parameter, so the empty pattern is required.
  // eslint-disable-next-line no-empty-pattern
  api: async ({}, use) => {
    await use((persona) => asPersona(persona, API_ORIGIN));
  },

  // Resolved for every test, not once per worker: the story spec resets the workspace and plays it again, which gives
  // the two cases and the skill new ids, so ids kept from before would point at nothing. When the story is already
  // complete this costs one cheap read; a first run seeds it, which takes minutes on a loaded machine, hence the timeout.
  demo: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      await ensurePortfolioDemo();
      await use(await demoIds());
    },
    { timeout: 900_000 },
  ],
});

export { expect };
