import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ValidationFailedError } from '../src/errors';
import { createDatabase } from '../src/db/client';
import { sha256Hex } from '../src/db/hash';
import { MigrationError, getMigrationStatus, loadMigrations, migrate } from '../src/db/migrate';
import { createRepositories } from '../src/db/repositories';
import { seedFoundation } from '../src/db/seed';
import { CONTOSO_SCOPE, TEST_DATABASE_STARTUP_TIMEOUT_MS } from '../src/db/testing';
import type { Database } from '../src/db/repositories/types';
import { buildIngestInput, buildSnapshot } from './builders';

const SCRATCH_ROOT = fileURLToPath(new URL('../.data/', import.meta.url));
const created: string[] = [];

/** Every migration this build ships, in application order. Add the new file here. */
const MIGRATION_NAMES = [
  '0001_foundation',
  '0002_tenancy',
  '0003_cases',
  '0004_analysis',
  '0005_counterfactuals_and_skills',
  '0006_telemetry_audit_and_ops',
  '0007_search_and_identity_sync',
];
const LATEST_MIGRATION = MIGRATION_NAMES[MIGRATION_NAMES.length - 1];

/**
 * Checksums of the migrations that have been released. A released migration is never edited: the
 * runner refuses to continue against a database that applied the old text, so a schema change is
 * always a new file. If this fails you edited one of them: revert it and add a migration instead.
 */
const RELEASED_CHECKSUMS: Record<string, string> = {
  '0001_foundation': 'f2468ef75b6fc8fbabebe3e06120f906a9a671f2b16d5d7ea0f02a4811d0d2f5',
  '0002_tenancy': '0f896296a65a2488def4009bbb6af07b6c88df2ae1042362ec02104f6d3ef5c1',
  '0003_cases': '27f7e17a1058b51527ecf101b5b1d9c872350723c0a2f8a4e34b5e60a2de05e2',
  '0004_analysis': '6fe270ff09ca7806a4dfda6f1a2cfbb1130469ed13aa446b2a805391eace78c0',
  '0005_counterfactuals_and_skills':
    '938144928db38f2a8ba227d4ff8d95ab36bd8a9e8c45fc9e6ae27cf680f2a2c3',
  '0006_telemetry_audit_and_ops':
    '38563e58807a5ec22b4a05119922ca5e8b0d2a4bad981a6243bd387c2f6b5bb3',
};

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
      expect(files.map((f) => f.name)).toEqual(MIGRATION_NAMES);

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
      expect(first.status.latest).toBe(LATEST_MIGRATION);
      expect(first.status.applied.map((a) => a.checksum)).toEqual(files.map((f) => f.checksum));
      for (const entry of first.status.applied)
        expect(entry.appliedAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);

      const second = await migrate(db);
      expect(second.appliedNow).toEqual([]);
      expect(second.status.checksumMismatch).toEqual([]);
      expect((await getMigrationStatus(db)).applied).toHaveLength(MIGRATION_NAMES.length);
    },
  );

  it('released migrations are immutable: their checksums are pinned', async () => {
    const files = await loadMigrations();
    const actual = Object.fromEntries(
      files
        .filter((file) => file.name in RELEASED_CHECKSUMS)
        .map((file) => [file.name, file.checksum]),
    );
    expect(actual).toEqual(RELEASED_CHECKSUMS);
    // Everything else is new work, and new work comes after what was released.
    const unreleased = files.filter((file) => !(file.name in RELEASED_CHECKSUMS));
    expect(unreleased.map((file) => file.name)).toEqual(
      MIGRATION_NAMES.slice(Object.keys(RELEASED_CHECKSUMS).length),
    );
  });

  it(
    'protect the real schema: a CRLF checkout is not drift, an edited migration is refused',
    SLOW,
    async () => {
      const dir = await scratchDir('real-copy');
      const files = await loadMigrations();
      for (const file of files) await writeFile(join(dir, `${file.name}.sql`), file.sql);
      expect((await migrate(db, { dir })).appliedNow).toEqual(MIGRATION_NAMES);

      // The same text with Windows line endings (a git checkout with autocrlf) is not a change.
      await writeFile(join(dir, '0003_cases.sql'), files[2]?.sql.replace(/\n/g, '\r\n') ?? '');
      expect((await getMigrationStatus(db, { dir })).checksumMismatch).toEqual([]);
      expect((await migrate(db, { dir })).appliedNow).toEqual([]);

      // Any real edit of an applied migration, even a comment, is detected and nothing runs.
      await writeFile(join(dir, '0002_tenancy.sql'), `${files[1]?.sql ?? ''}\n-- edited\n`);
      expect((await getMigrationStatus(db, { dir })).checksumMismatch).toEqual(['0002_tenancy']);
      await expect(migrate(db, { dir })).rejects.toThrow(/0002_tenancy/);
    },
  );

  it(
    'upgrade a database that already holds data: old rows become searchable and sign-in inserts work',
    SLOW,
    async () => {
      const files = await loadMigrations();
      const dir = await scratchDir('upgrade');
      for (const file of files.filter((f) => f.name !== LATEST_MIGRATION)) {
        await writeFile(join(dir, `${file.name}.sql`), file.sql);
      }
      expect((await migrate(db, { dir })).appliedNow).toEqual(MIGRATION_NAMES.slice(0, -1));
      await seedFoundation(db);

      const repos = createRepositories(db).forTenant(CONTOSO_SCOPE);
      const input = buildIngestInput({
        caseId: 'case_legacy',
        title: 'Legacy quokka case',
        receivedSeed: 'legacy',
      });
      await repos.cases.ingest(input);
      await repos.analysis.saveSnapshot(buildSnapshot(input));

      const insertGranted = () =>
        db.query<{ granted: boolean }>(
          "SELECT has_table_privilege('caseguard_app', 'users', 'INSERT') AS granted",
        );
      const emailIndexes = () =>
        db.query<{ indexname: string; indexdef: string }>(
          "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'users' AND indexname LIKE 'users_tenant_email%'",
        );
      expect((await insertGranted()).rows[0]?.granted).toBe(false);
      expect((await emailIndexes()).rows.map((row) => row.indexname)).toEqual([
        'users_tenant_email_uq',
      ]);
      await expect(db.query('SELECT search_tsv FROM cases')).rejects.toBeDefined();

      const upgraded = await migrate(db);
      expect(upgraded.appliedNow).toEqual([LATEST_MIGRATION]);
      expect(upgraded.status.pending).toEqual([]);

      // Rows written before the migration are indexed by it, with no re-ingest or re-analysis.
      const legacy = await repos.search.query({ text: 'legacy', limit: 10 });
      expect(legacy.map((hit) => `${hit.type}:${hit.id}`)).toEqual(['case:case_legacy']);
      const types = new Set(
        (await repos.search.query({ text: 'synthetic', limit: 100 })).map((hit) => hit.type),
      );
      expect([...types].sort()).toEqual(['case', 'claim', 'event', 'hypothesis']);

      expect((await insertGranted()).rows[0]?.granted).toBe(true);
      const [index] = (await emailIndexes()).rows;
      expect(index?.indexname).toBe('users_tenant_email_idx');
      expect(index?.indexdef).not.toMatch(/UNIQUE/);

      // The first sign-in of users without an e-mail, or with a shared one, no longer collides.
      for (const [userId, email] of [
        ['entra-1', null],
        ['entra-2', null],
        ['entra-3', 'shared@contoso.example'],
        ['entra-4', 'shared@contoso.example'],
      ] as const) {
        await repos.governance.upsertIdentityUser({
          userId,
          displayName: `User ${userId}`,
          email,
          roles: ['engineer'],
          synthetic: true,
        });
      }
      expect((await repos.governance.listUsers()).map((user) => user.id)).toEqual(
        expect.arrayContaining(['entra-1', 'entra-2', 'entra-3', 'entra-4']),
      );
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
      expect(rows.rows[0]?.n).toBe(MIGRATION_NAMES.length);
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
