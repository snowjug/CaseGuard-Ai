import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  API_ORIGIN,
  NEXT_DIST_DIR,
  WEB_DIR,
  WEB_MODE,
  WEB_PORT,
  cleanEnvironment,
  webBuildIsCurrent,
} from './env';

/**
 * Starts the web app of the end-to-end run (`playwright.config.ts` webServer): the PRODUCTION build, because the nonce
 * CSP, the header set and `next/link` prefetching only behave like the shipped image there. By default it runs the
 * standalone server (`.next/standalone/apps/web/server.js`), the very entry point of the container image. It builds
 * first when the private dist directory is missing or older than its sources (see `PW_WEB_REBUILD` in `env.ts`).
 *
 * `WEB_LISTEN_PORT` and `API_INTERNAL_URL` let a spec start a second instance (for example in front of an echo stub).
 */
const port = Number.parseInt(process.env.WEB_LISTEN_PORT ?? '', 10) || WEB_PORT;
const apiOrigin = process.env.API_INTERNAL_URL || API_ORIGIN;
const nextBin = createRequire(path.join(WEB_DIR, 'package.json')).resolve('next/dist/bin/next');
const distDir = path.join(WEB_DIR, NEXT_DIST_DIR);
const standaloneApp = path.join(distDir, 'standalone', 'apps', 'web');

const environment: Record<string, string> = {
  ...cleanEnvironment(),
  CG_NEXT_DIST_DIR: NEXT_DIST_DIR,
  NEXT_TELEMETRY_DISABLED: '1',
  API_INTERNAL_URL: apiOrigin,
  NEXT_PUBLIC_AUTH_MODE: 'dev',
  NEXT_PUBLIC_APP_ENV: 'local',
};

function nextCommand(args: string[]): number {
  const result = spawnSync(process.execPath, [nextBin, ...args], {
    cwd: WEB_DIR,
    env: environment,
    stdio: 'inherit',
    windowsHide: true,
  });
  return result.status ?? 1;
}

if (WEB_MODE !== 'dev' && process.env.PW_WEB_REBUILD !== '0') {
  if (process.env.PW_WEB_REBUILD === '1' || !webBuildIsCurrent()) {
    console.warn(`[serve-web] building the web app into ${NEXT_DIST_DIR} (this takes minutes)`);
    // A populated dist directory fails on Windows (EPERM on the standalone symlink): always build into a clean one.
    rmSync(distDir, { recursive: true, force: true });
    const status = nextCommand(['build']);
    if (status !== 0) process.exit(status);
  }
}

let command: string[];
let cwd = WEB_DIR;
const serverEnvironment = { ...environment };
if (WEB_MODE === 'standalone') {
  // The image copies the static assets and `public/` next to the standalone server; do the same here.
  const server = path.join(standaloneApp, 'server.js');
  if (!existsSync(server)) {
    console.error(
      `[serve-web] ${server} is missing: build the web app first (output: 'standalone').`,
    );
    process.exit(1);
  }
  cpSync(path.join(distDir, 'static'), path.join(standaloneApp, NEXT_DIST_DIR, 'static'), {
    recursive: true,
  });
  if (existsSync(path.join(WEB_DIR, 'public'))) {
    cpSync(path.join(WEB_DIR, 'public'), path.join(standaloneApp, 'public'), { recursive: true });
  }
  command = [server];
  cwd = standaloneApp;
  serverEnvironment.PORT = String(port);
  serverEnvironment.HOSTNAME = '127.0.0.1';
  serverEnvironment.NODE_ENV = 'production';
} else {
  command = [
    nextBin,
    WEB_MODE === 'dev' ? 'dev' : 'start',
    '--port',
    String(port),
    '--hostname',
    '127.0.0.1',
  ];
}

const child = spawn(process.execPath, command, {
  cwd,
  env: serverEnvironment,
  stdio: 'inherit',
  windowsHide: true,
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
