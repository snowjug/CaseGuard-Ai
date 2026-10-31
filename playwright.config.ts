import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';
import {
  API_ORIGIN,
  CHANNEL,
  CI,
  PERF_ENABLED,
  ROOT,
  SUPPORT_DIR,
  WEB_ORIGIN,
} from './e2e/support/env';

/**
 * End-to-end, accessibility, security, screenshot and (on demand) performance tests of the running product.
 *
 *   pnpm test:e2e              desktop + mobile projects (every spec except screenshots and @perf)
 *   pnpm screenshots           the `screenshots` project: real PNGs into docs/assets/screenshots/
 *   PW_PERF=1 pnpm exec playwright test --project=perf      the @perf specs (they measure, they assert nothing about speed)
 *
 * One API (in-memory PGlite, deterministic AI provider, seeded synthetic demo) and one production build of the web
 * app are started by `webServer` on uncommon ports (see `e2e/support/env.ts`). The machine may be loaded, so there is a
 * single worker and every timeout is generous. Locally the browser is Microsoft Edge (`PW_CHANNEL` overrides it); in CI
 * it is the bundled Chromium.
 */
const reuseExistingServer = process.env.PW_REUSE_SERVER === '1';
const serverLogs = process.env.PW_SERVER_LOGS === '1';
const launcher = (name: string): string => `node --import tsx "${SUPPORT_DIR}/${name}"`;

const browser = { ...devices['Desktop Chrome'], ...(CHANNEL ? { channel: CHANNEL } : {}) };
const desktop = { width: 1440, height: 900 };

const projects: NonNullable<PlaywrightTestConfig['projects']> = [
  {
    name: 'desktop',
    use: { ...browser, viewport: desktop },
    testIgnore: ['**/mobile.spec.ts', '**/screenshots/**', '**/perf/**'],
  },
  {
    name: 'mobile',
    use: {
      ...browser,
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    },
    testMatch: ['**/mobile.spec.ts'],
  },
  {
    name: 'screenshots',
    use: { ...browser, viewport: desktop, deviceScaleFactor: 1 },
    testMatch: ['**/screenshots/**/*.spec.ts'],
  },
];
if (PERF_ENABLED) {
  projects.push({
    name: 'perf',
    use: { ...browser, viewport: desktop },
    testMatch: ['**/perf/**/*.spec.ts'],
  });
}

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  outputDir: 'test-results',
  fullyParallel: false,
  workers: 1,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  // `@perf` specs only run when asked for (PW_PERF=1): they measure, they do not assert behaviour.
  ...(PERF_ENABLED ? {} : { grepInvert: /@perf/ }),
  reporter: [
    [CI ? 'github' : 'list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  globalSetup: './e2e/support/global-setup.ts',
  use: {
    baseURL: WEB_ORIGIN,
    actionTimeout: 30_000,
    navigationTimeout: 90_000,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
    colorScheme: 'light',
    locale: 'en-US',
    timezoneId: 'UTC',
  },
  webServer: [
    {
      name: 'api',
      command: launcher('serve-api.ts'),
      cwd: ROOT,
      // The API listens only after the demo seed (about 100 s on a loaded laptop), so this wait is long.
      url: `${API_ORIGIN}/readyz`,
      timeout: 600_000,
      reuseExistingServer,
      stdout: serverLogs ? 'pipe' : 'ignore',
      stderr: 'pipe',
      gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
    },
    {
      name: 'web',
      command: launcher('serve-web.ts'),
      cwd: ROOT,
      // Rendered by Next itself; the specs prove the forwarding of /api/* and the probes to the API separately.
      url: `${WEB_ORIGIN}/`,
      timeout: 900_000,
      reuseExistingServer,
      stdout: serverLogs ? 'pipe' : 'ignore',
      stderr: 'pipe',
      gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
    },
  ],
  projects,
});
