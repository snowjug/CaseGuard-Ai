import { runDemoCli } from '../apps/api/src/services/demo/demo-cli';

/**
 * `pnpm demo:reset`: erases the synthetic tenant's case data (users, settings and the audit trail stay)
 * in direct mode, against whatever DATABASE_URL names. Refused outside a synthetic demo tenant. Exits
 * non-zero on failure.
 */
process.exitCode = await runDemoCli('reset', process.argv.slice(2), process.env);
