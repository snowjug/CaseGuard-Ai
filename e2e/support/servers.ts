import path from 'node:path';
import {
  API_DIR,
  DATA_DIR,
  ROOT,
  SUPPORT_DIR,
  WEB_MODE,
  NEXT_DIST_DIR,
  apiEnvironment,
  apiNodeArguments,
  cleanEnvironment,
} from './env';
import { freePort } from './echo-server';
import { startProcess, waitForHttp, type ExitInfo, type RunningProcess } from './process';

export interface RunningWeb {
  readonly origin: string;
  readonly process: RunningProcess;
  stop(): Promise<void>;
}

/**
 * A second instance of the production web server (the very command `playwright.config.ts` runs), forwarding `/api/*`
 * to `apiOrigin`. It never rebuilds: it serves the build the first instance serves.
 */
export async function startWebInstance(apiOrigin: string): Promise<RunningWeb> {
  const port = await freePort();
  const instance = startProcess({
    label: `web instance on ${port}`,
    command: process.execPath,
    args: ['--import', 'tsx', path.join(SUPPORT_DIR, 'serve-web.ts')],
    cwd: ROOT,
    env: {
      ...cleanEnvironment(),
      WEB_LISTEN_PORT: String(port),
      API_INTERNAL_URL: apiOrigin,
      PW_WEB_REBUILD: '0',
      PW_WEB_MODE: WEB_MODE,
      CG_NEXT_DIST_DIR: NEXT_DIST_DIR,
    },
  });
  const origin = `http://127.0.0.1:${port}`;
  try {
    await waitForHttp(`${origin}/icon.svg`, { timeoutMs: 240_000, process: instance });
  } catch (error) {
    await instance.stop();
    throw error;
  }
  return { origin, process: instance, stop: () => instance.stop() };
}

export interface RunningApi {
  readonly origin: string;
  readonly process: RunningProcess;
  stop(): Promise<void>;
}

/** A second API with its own in-memory database and object store. `overrides` replace the local profile's variables. */
export async function startApiInstance(
  overrides: Record<string, string> = {},
): Promise<RunningApi> {
  const port = await freePort();
  const storageDir = path.join(DATA_DIR, `objects-${port}`);
  const instance = startProcess({
    label: `api instance on ${port}`,
    command: process.execPath,
    args: apiNodeArguments(),
    cwd: API_DIR,
    env: apiEnvironment({
      port,
      storageDir,
      overrides: { DEMO_AUTO_SEED: 'false', DEMO_MODE: 'false', ...overrides },
    }),
  });
  const origin = `http://127.0.0.1:${port}`;
  try {
    await waitForHttp(`${origin}/livez`, { timeoutMs: 300_000, process: instance });
  } catch (error) {
    await instance.stop();
    throw error;
  }
  return { origin, process: instance, stop: () => instance.stop() };
}

export interface ApiRefusal extends ExitInfo {
  readonly stderr: string;
  readonly stdout: string;
}

/** Starts the API with an environment it must refuse, and returns how it ended (it never listens). */
export async function startApiExpectingRefusal(
  environment: Record<string, string>,
  timeoutMs = 240_000,
): Promise<ApiRefusal> {
  const port = await freePort();
  const instance = startProcess({
    label: 'api expected to refuse',
    command: process.execPath,
    args: apiNodeArguments(),
    cwd: API_DIR,
    env: {
      ...apiEnvironment({ port, storageDir: path.join(DATA_DIR, `objects-${port}`) }),
      ...environment,
    },
  });
  const timeout = new Promise<'timeout'>((resolve) =>
    setTimeout(() => resolve('timeout'), timeoutMs),
  );
  const outcome = await Promise.race([instance.exited, timeout]);
  const output = instance.output();
  if (outcome === 'timeout') {
    await instance.stop();
    throw new Error(
      `The API did not refuse to start within ${timeoutMs} ms.\n${output.stderr.slice(-2000)}`,
    );
  }
  return { ...outcome, stderr: output.stderr, stdout: output.stdout };
}
