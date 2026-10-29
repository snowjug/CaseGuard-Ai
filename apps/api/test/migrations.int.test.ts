import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ValidationFailedError } from '../src/errors';
import { createDatabase } from '../src/db/client';
import { sha256Hex } from '../src/db/hash';
import { MigrationError, getMigrationStatus, loadMigrations, migrate } from '../src/db/migrate';
import { TEST_DATABASE_STARTUP_TIMEOUT_MS } from '../src/db/testing';
import type { Database } from '../src/db/repositories/types';

const SCRATCH_ROOT = fileURLToPath(new URL('../.data/', import.meta.url));
const created: string[] = [];

async function scratchDir(prefix: string): Promise<string> {
  await mkdir(SCRATCH_ROOT, { recursive: true });
  const dir = await mkdtemp(join(SCRATCH_ROOT, `${prefix}-`));
  created.push(dir);
  return dir;
}

// Starting a PGlite instance costs seconds, so the file shares one and wipes the schema between
// tests: every test still begins from a genuinely empty database.
let db: Database;
beforeAll(async () => {
  db = await createDatabase({ url: 'pglite://memory' });
}, TEST_DATABASE_STARTUP_TIMEOUT_MS);
beforeEach(async () => {
  await db.query('DROP SCHEMA public CASCADE');
  await db.query('CREATE SCHEMA public');
});
afterAll(async () => {
  await db.close();
  for (const dir of created) await rm(dir, { recursive: true, force: true });
});

// Applying the full schema takes a few seconds on a loaded machine.
const SLOW = { timeout: 120_000 };

describe('[NFR-REL-01] migrations', () => {
  it(
    'apply from an empty database in order, record checksums and are re-runnable',
    SLOW,
    async () => {
      const files = await loadMigrations();
      expect(files.map((f) => f.name)).toEqual([
        '0001_foundation',
        '0002_tenancy',
        '0003_cases',
        '0004_analysis',
        '0005_counterfactuals_and_skills',
        '0006_telemetry_audit_and_ops',
      ]);

      const before = await getMigrationStatus(db);
      expect(before).toEqual({
        applied: [],
        pending: files.map((f) => f.name),
        latest: null,
        checksumMismatch: [],
      });

      const first = await migrate(db);
      expect(first.appliedNow).toEqual(files.map((f) => f.name));
      expect(first.status.pending).toEqual([]);
      expect(first.status.latest).toBe('0006_telemetry_audit_and_ops');
      expect(first.status.applied.map((a) => a.checksum)).toEqual(files.map((f) => f.checksum));
      for (const entry of first.status.applied)
        expect(entry.appliedAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);

      const second = await migrate(db);
      expect(second.appliedNow).toEqual([]);
      expect(second.status.checksumMismatch).toEqual([]);
      expect((await getMigrationStatus(db)).applied).toHaveLength(6);
    },
  );

  it(
    'two migrators racing on an empty database apply every migration exactly once',
    SLOW,
    async () => {
      const [a, b] = await Promise.all([migrate(db), migrate(db)]);
      expect([...a.appliedNow, ...b.appliedNow].sort()).toEqual(
        (await loadMigrations()).map((f) => f.name).sort(),
      );
      const rows = await db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM schema_migrations',
      );
      expect(rows.rows[0]?.n).toBe(6);
    },
  );

  it('detect an applied migration whose file changed and refuse to continue', async () => {
    const dir = await scratchDir('drift');
    await writeFile(join(dir, '0001_alpha.sql'), 'CREATE TABLE alpha (id int);\n');
    await writeFile(join(dir, '0002_beta.sql'), 'CREATE TABLE beta (id int);\n');
    await migrate(db, { dir });

    await writeFile(join(dir, '0001_alpha.sql'), 'CREATE TABLE alpha (id int, extra text);\n');
    await writeFile(join(dir, '0003_gamma.sql'), 'CREATE TABLE gamma (id int);\n');
    const status = await getMigrationStatus(db, { dir });
    expect(status.checksumMismatch).toEqual(['0001_alpha']);
    expect(status.pending).toEqual(['0003_gamma']);
    await expect(migrate(db, { dir })).rejects.toThrow(/0001_alpha/);
    await expect(migrate(db, { dir })).rejects.toBeInstanceOf(MigrationError);
    // The refusal happened before anything was applied.
    const gamma = await db.query<{ present: boolean }>(
      "SELECT to_regclass('gamma') IS NOT NULL AS present",
    );
    expect(gamma.rows[0]?.present).toBe(false);
  });

  it('ignore migrations the database knows but this build does not ship (older replica, newer schema)', async () => {
    const dir = await scratchDir('newer');
    await writeFile(join(dir, '0001_alpha.sql'), 'CREATE TABLE alpha (id int);\n');
    await writeFile(join(dir, '0002_beta.sql'), 'CREATE TABLE beta (id int);\n');
    await migrate(db, { dir });
    await rm(join(dir, '0002_beta.sql'));
    const status = await getMigrationStatus(db, { dir });
    expect(status).toMatchObject({ pending: [], checksumMismatch: [], latest: '0002_beta' });
    expect(status.applied).toHaveLength(2);
    expect((await migrate(db, { dir })).appliedNow).toEqual([]);
  });

  it('roll a failing migration back completely and record nothing for it', async () => {
    const dir = await scratchDir('failing');
    await writeFile(join(dir, '0001_ok.sql'), 'CREATE TABLE ok_table (id int);\n');
    await writeFile(
      join(dir, '0002_broken.sql'),
      'CREATE TABLE half_done (id int);\nINSERT INTO half_done VALUES (1);\nSELECT * FROM table_that_does_not_exist;\n',
    );
    await expect(migrate(db, { dir })).rejects.toBeDefined();
    const status = await getMigrationStatus(db, { dir });
    expect(status.applied.map((a) => a.name)).toEqual(['0001_ok']);
    expect(status.pending).toEqual(['0002_broken']);
    const halfDone = await db.query<{ present: boolean }>(
      "SELECT to_regclass('half_done') IS NOT NULL AS present",
    );
    expect(halfDone.rows[0]?.present).toBe(false);
  });

  it('checksums ignore line-ending differences between checkouts', async () => {
    const lf = await scratchDir('lf');
    const crlf = await scratchDir('crlf');
    await writeFile(join(lf, '0001_x.sql'), 'CREATE TABLE x (\n  id int\n);\n');
    await writeFile(join(crlf, '0001_x.sql'), 'CREATE TABLE x (\r\n  id int\r\n);\r\n');
    const [a, b] = [await loadMigrations(lf), await loadMigrations(crlf)];
    expect(a[0]?.checksum).toBe(b[0]?.checksum);
    expect(a[0]?.checksum).toBe(sha256Hex('CREATE TABLE x (\n  id int\n);\n'));
  });

  it('reject malformed migration directories', async () => {
    const badName = await scratchDir('badname');
    await writeFile(join(badName, 'create-users.sql'), 'SELECT 1;');
    await expect(loadMigrations(badName)).rejects.toBeInstanceOf(MigrationError);

    const duplicate = await scratchDir('dupnum');
    await writeFile(join(duplicate, '0001_a.sql'), 'SELECT 1;');
    await writeFile(join(duplicate, '0001_b.sql'), 'SELECT 2;');
    await expect(loadMigrations(duplicate)).rejects.toThrow(/0001/);
  });
});

describe('database client', () => {
  it('opens in-memory PGlite, answers ping and refuses unsupported URLs without echoing them', async () => {
    expect(db.kind).toBe('pglite');
    expect(await db.ping()).toMatchObject({ ok: true });
    await expect(
      createDatabase({ url: 'mysql://user:secret-password@host/db' }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(
      createDatabase({ url: 'mysql://user:secret-password@host/db' }),
    ).rejects.not.toThrow(/secret-password/);
  });

  it('turns a would-be PGlite deadlock into an immediate, descriptive error', async () => {
    await expect(
      db.transaction(async () => {
        await db.query('SELECT 1');
      }),
    ).rejects.toThrow(/transaction-bound executor/);
    // The connection is healthy afterwards.
    expect(await db.ping()).toMatchObject({ ok: true });
  });
});
