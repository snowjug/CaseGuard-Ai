import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where everything lives and which ports and switches the end-to-end run uses. Imported by `playwright.config.ts`, by
 * the server launchers (`serve-api.ts`, `serve-web.ts`) and by the specs, so that they cannot disagree.
 *
 * Environment switches (all optional):
 *   PW_API_PORT / PW_WEB_PORT   uncommon defaults 4310 / 3310 because other processes may hold 3000 and 4000
 *   PW_CHANNEL                  browser channel (default `msedge` locally, bundled Chromium when CI is set)
 *   PW_API_MODE                 `src` (tsx) or `dist` (node dist/main.js); default `dist` in CI, `src` locally
 *   PW_WEB_MODE                 `standalone` (the default: `node .next/standalone/apps/web/server.js`, exactly what the image
 *                               runs), `start` (`next start`) or `dev` (`next dev`, never for the final run)
 *   PW_WEB_REBUILD              `1` rebuilds the web app, `0` never does (uses whatever the private dist directory holds);
 *                               unset rebuilds only when the build is missing or older than its sources (local runs)
 *   CG_NEXT_DIST_DIR            private Next dist directory (default `.next-e2e` locally, Next's `.next` in CI)
 *   PW_REUSE_SERVER=1           reuse servers that already listen on the two ports
 *   PW_SERVER_LOGS=1            print the output of the servers the run starts
 *   PW_PERF=1                   also run the `@perf` specs
 */
const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, '..', '..');
export const API_DIR = path.join(ROOT, 'apps', 'api');
export const WEB_DIR = path.join(ROOT, 'apps', 'web');
export const SUPPORT_DIR = here;
export const DOCS_SCREENSHOTS_DIR = path.join(ROOT, 'docs', 'assets', 'screenshots');
/** Git-ignored (`.data/`): the object store of the API instances this run starts. */
export const DATA_DIR = path.join(ROOT, '.data', 'e2e');

export const CI = Boolean(process.env.CI);

const port = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65_536 ? parsed : fallback;
};

export const API_PORT = port(process.env.PW_API_PORT, 4310);
export const WEB_PORT = port(process.env.PW_WEB_PORT, 3310);
/** The address everything uses: 127.0.0.1, never `localhost`, which may resolve to ::1 first. */
export const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;
export const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;

/** `undefined` means Playwright's bundled Chromium. */
export const CHANNEL: string | undefined = process.env.PW_CHANNEL ?? (CI ? undefined : 'msedge');
export const WEB_MODE: 'standalone' | 'start' | 'dev' =
  process.env.PW_WEB_MODE === 'dev' || process.env.PW_WEB_MODE === 'start'
    ? process.env.PW_WEB_MODE
    : 'standalone';
export const PERF_ENABLED = process.env.PW_PERF === '1';

/** The distDir that `apps/web/next.config.ts` reads. */
export const NEXT_DIST_DIR: string =
  process.env.CG_NEXT_DIST_DIR?.trim() || (CI ? '.next' : '.next-e2e');

export function apiMode(): 'src' | 'dist' {
  const requested = process.env.PW_API_MODE;
  if (requested === 'src' || requested === 'dist') return requested;
  return CI && existsSync(path.join(API_DIR, 'dist', 'main.js')) ? 'dist' : 'src';
}

/** `node` arguments that run the API: the TypeScript sources through tsx, or the built bundle. */
export function apiNodeArguments(): string[] {
  return apiMode() === 'dist' ? ['dist/main.js'] : ['--import', 'tsx', 'src/main.ts'];
}

/** Variables of the API's own configuration. They are cleared before a run so a developer's shell cannot leak in. */
const CONFIG_VARIABLES =
  /^(APP_|API_|AZURE_|AI_|ENTRA_|DATABASE_|DB_|STORAGE_|SEARCH_|CACHE_|RATE_LIMIT_|BODY_LIMIT|UPLOAD_|MALWARE_|APPLICATIONINSIGHTS|OTEL_|DEMO_|TRUST_|CORS_|AUTH_|DEV_AUTH|SERVICE_NAME|GIT_COMMIT|LOG_LEVEL|NODE_ENV|NEXT_|PW_)/;

export function cleanEnvironment(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !CONFIG_VARIABLES.test(key)) kept[key] = value;
  }
  return kept;
}

export interface ApiEnvironmentOptions {
  readonly port: number;
  readonly storageDir: string;
  readonly overrides?: Record<string, string>;
}

/**
 * The local profile of the shared API: persona login, deterministic AI provider, in-memory PGlite, a private object
 * store, lexical search, and limits high enough that a long run from one machine address never meets the rate limiter
 * by accident (the specs that test limits use the per-user engine budget or start an instance of their own).
 */
export function apiEnvironment({
  port: listenPort,
  storageDir,
  overrides,
}: ApiEnvironmentOptions): Record<string, string> {
  return {
    ...cleanEnvironment(),
    APP_ENV: 'local',
    API_HOST: '127.0.0.1',
    API_PORT: String(listenPort),
    CORS_ALLOWED_ORIGINS: WEB_ORIGIN,
    LOG_LEVEL: process.env.PW_SERVER_LOGS === '1' ? 'info' : 'warn',
    AUTH_MODE: 'dev',
    DEV_AUTH_ENABLED: 'true',
    DATABASE_URL: 'pglite://memory',
    DB_AUTO_MIGRATE: 'true',
    STORAGE_PROVIDER: 'local',
    STORAGE_LOCAL_DIR: storageDir,
    SEARCH_PROVIDER: 'lexical',
    AI_PROVIDER: 'deterministic',
    RATE_LIMIT_MAX: '100000',
    RATE_LIMIT_AI_MAX: '100000',
    DEMO_MODE: 'true',
    DEMO_AUTO_SEED: 'true',
    ...overrides,
  };
}

function newestModification(entry: string): number {
  if (!existsSync(entry)) return 0;
  const stats = statSync(entry);
  if (!stats.isDirectory()) return stats.mtimeMs;
  let newest = stats.mtimeMs;
  for (const name of readdirSync(entry)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    newest = Math.max(newest, newestModification(path.join(entry, name)));
  }
  return newest;
}

/**
 * True when a build of the web app exists in the dist directory and nothing it was built from is newer. Locally a
 * stale build would test yesterday's code without saying so; CI builds right before the run, so it only checks that the
 * build exists.
 */
export function webBuildIsCurrent(): boolean {
  const buildId = path.join(WEB_DIR, NEXT_DIST_DIR, 'BUILD_ID');
  if (!existsSync(buildId)) return false;
  if (CI) return true;
  const builtAt = statSync(buildId).mtimeMs;
  const sources = [
    path.join(WEB_DIR, 'src'),
    path.join(ROOT, 'packages', 'ui', 'src'),
    path.join(ROOT, 'packages', 'schemas', 'src'),
    path.join(WEB_DIR, 'next.config.ts'),
  ];
  return !sources.some((source) => newestModification(source) > builtAt);
}
