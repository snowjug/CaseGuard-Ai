import { createDatabase } from './client';
import { getMigrationStatus, migrate } from './migrate';

/**
 * `pnpm db:migrate` — applies pending migrations to DATABASE_URL and prints the result.
 * `--status` only reports (exit code 1 when migrations are pending or an applied file changed).
 * Never prints the connection string: it can contain credentials.
 */
async function main(): Promise<number> {
  const url = process.env.DATABASE_URL ?? 'pglite://.data/caseguard';
  const auth = process.env.DATABASE_AUTH === 'entra' ? 'entra' : 'password';
  const poolMax = Number.parseInt(process.env.DB_POOL_MAX ?? '', 10);
  const statusOnly = process.argv.includes('--status');
  const target = url.startsWith('pglite://')
    ? `PGlite (${url.slice('pglite://'.length)})`
    : 'PostgreSQL';

  console.log(
    `Database: ${target}${auth === 'entra' ? ' with Microsoft Entra authentication' : ''}`,
  );
  const db = await createDatabase({
    url,
    auth,
    poolMax: Number.isFinite(poolMax) && poolMax > 0 ? poolMax : undefined,
    applicationName: 'caseguard-migrate',
  });
  try {
    if (!statusOnly) {
      const result = await migrate(db);
      if (result.appliedNow.length === 0) {
        console.log('No pending migrations.');
      } else {
        for (const name of result.appliedNow) console.log(`Applied ${name}`);
      }
    }
    const status = await getMigrationStatus(db);
    console.log(`Applied: ${status.applied.length}, pending: ${status.pending.length}`);
    for (const entry of status.applied) console.log(`  [x] ${entry.name} (${entry.appliedAt})`);
    for (const name of status.pending) console.log(`  [ ] ${name}`);
    if (status.checksumMismatch.length > 0) {
      console.error(`Checksum mismatch: ${status.checksumMismatch.join(', ')}`);
      return 1;
    }
    return statusOnly && status.pending.length > 0 ? 1 : 0;
  } finally {
    await db.close();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'unknown failure';
    console.error(`Migration failed: ${message}`);
    process.exitCode = 1;
  });
