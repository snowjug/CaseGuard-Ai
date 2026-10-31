import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { API_DIR, API_PORT, DATA_DIR, apiEnvironment, apiNodeArguments } from './env';

/**
 * Starts the API of the end-to-end run (`playwright.config.ts` webServer). It owns an empty object store and an
 * in-memory database, so every run starts from nothing; the API seeds the synthetic demo before it listens.
 */
const port = Number.parseInt(process.env.PW_API_LISTEN_PORT ?? '', 10) || API_PORT;
const storageDir = path.join(DATA_DIR, `objects-${port}`);
rmSync(storageDir, { recursive: true, force: true });
mkdirSync(storageDir, { recursive: true });

const child = spawn(process.execPath, apiNodeArguments(), {
  cwd: API_DIR,
  env: apiEnvironment({ port, storageDir }),
  stdio: 'inherit',
  windowsHide: true,
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
