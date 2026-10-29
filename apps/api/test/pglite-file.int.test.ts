import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../src/db/client';
import { getMigrationStatus, migrate } from '../src/db/migrate';
import { seedFoundation } from '../src/db/seed';
import type { Database } from '../src/db/repositories/types';

const SCRATCH_ROOT = fileURLToPath(new URL('../.data/', import.meta.url));
const created: string[] = [];

afterAll(async () => {
  for (const dir of created) await rm(dir, { recursive: true, force: true });
});

// A file-backed PGlite runs initdb against the real disk, which dominates its runtime on slow or
// synced file systems (about 12 s on a OneDrive folder). The test therefore lives in its own file,
// so it runs beside the others rather than in front of them, with a generous timeout.
describe('[NFR-REL-01] file-backed PGlite', () => {
  it(
    'keeps its schema and data across restarts and does not re-apply migrations',
    {
      timeout: 240_000,
    },
    async () => {
      await mkdir(SCRATCH_ROOT, { recursive: true });
      const dir = await mkdtemp(join(SCRATCH_ROOT, 'pglite-'));
      created.push(dir);

      const first = await createDatabase({ url: `pglite://${dir}` });
      try {
        expect((await migrate(first)).appliedNow).toHaveLength(6);
        await seedFoundation(first);
      } finally {
        await first.close();
      }

      const reopened: Database = await createDatabase({ url: `pglite://${dir}` });
      try {
        expect((await getMigrationStatus(reopened)).pending).toEqual([]);
        const users = await reopened.query<{ n: number }>('SELECT count(*)::int AS n FROM users');
        expect(users.rows[0]?.n).toBe(6);
        expect((await migrate(reopened)).appliedNow).toEqual([]);
      } finally {
        await reopened.close();
      }
    },
  );
});
