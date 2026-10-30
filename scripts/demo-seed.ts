import { runDemoCli } from '../apps/api/src/services/demo/demo-cli';

/**
 * `pnpm demo:seed [-- --profile base|portfolio]` (default `portfolio`): seeds the synthetic demo data in
 * direct mode, against whatever DATABASE_URL names (the local PGlite file by default), as the seeded
 * administrator of the synthetic tenant. Idempotent. Exits non-zero on failure.
 */
process.exitCode = await runDemoCli('seed', process.argv.slice(2), process.env);
