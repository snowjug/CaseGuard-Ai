import { runDemoCli } from '../apps/api/src/services/demo/demo-cli';
import { useApiEnvironment } from './api-environment';

/**
 * `pnpm demo:reset`: erases the synthetic tenant's case data (users, settings and the audit trail stay)
 * in direct mode, against whatever DATABASE_URL names (the API's local PGlite file by default). Refused
 * outside a synthetic demo tenant. Exits non-zero on failure. A local PGlite database belongs to one
 * process at a time: stop the API first.
 */
useApiEnvironment();
process.exitCode = await runDemoCli('reset', process.argv.slice(2), process.env);
