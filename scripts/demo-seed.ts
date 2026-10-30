import { runDemoCli } from '../apps/api/src/services/demo/demo-cli';
import { useApiEnvironment } from './api-environment';

/**
 * `pnpm demo:seed [--profile base|portfolio]` (default `portfolio`): seeds the synthetic demo data in
 * direct mode, against whatever DATABASE_URL names (the API's local PGlite file by default), as the
 * seeded administrator of the synthetic tenant. Idempotent. Exits non-zero on failure. A local PGlite
 * database belongs to one process at a time: stop the API first.
 */
useApiEnvironment();
process.exitCode = await runDemoCli('seed', process.argv.slice(2), process.env);
