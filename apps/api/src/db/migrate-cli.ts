import { runMigrateCli } from './migrate-command';

/**
 * Entry point of `pnpm db:migrate` and of the deployed migration job (`dist/db/migrate-cli.js`).
 * All behaviour (arguments, migrations, tenant provisioning, output) lives in `migrate-command.ts`
 * so it can be tested without starting a process.
 */
runMigrateCli(process.argv.slice(2), process.env)
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'unknown failure';
    console.error(`Migration failed: ${message}`);
    process.exitCode = 1;
  });
