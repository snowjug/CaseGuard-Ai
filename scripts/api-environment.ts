import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Makes a script see what `pnpm dev` sees: the repository's `.env` (a variable already in the
 * environment wins) and the API's working directory, so the relative defaults of the local database and
 * object store (`pglite://.data/caseguard`, `.data/objects`) name the same files the running API uses
 * instead of a second copy under the repository root. Call it before anything opens the infrastructure.
 */
export function useApiEnvironment(): void {
  const envFile = resolve(ROOT, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  process.chdir(resolve(ROOT, 'apps', 'api'));
}
