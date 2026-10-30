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
  '0008_dashboard_read_models',
  '0009_job_heartbeat',
  '0010_case_reference_unique',
  '0011_idempotency_case_link',
  '0012_review_target_type_idx',
];
const LATEST_MIGRATION = MIGRATION_NAMES[MIGRATION_NAMES.length - 1];
/** What a database that predates search (migration 0007) has applied. */
const BEFORE_SEARCH = MIGRATION_NAMES.slice(0, 6);
/** What a database that predates unique case references (migration 0010) has applied. */
const BEFORE_REFERENCE_UNIQUE = MIGRATION_NAMES.slice(0, 9);

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
  '0007_search_and_identity_sync':
    '96b1488647ff5dbe14eb0d16b0482286ce20aa51a65d26495fd38aefa74fc973',
  '0008_dashboard_read_models': '636b604258169cbac0ada5bd7cda550929f46b27085166938587f9223d3051e0',
  '0009_job_heartbeat': 'bbab84d91f639e0abdf764af8c538f35ba000dbb4c5cae52cc8b610cd1dd1795',
  '0010_case_reference_unique': '18a0c123a01a538d8de53b98f47db3c96f5c4b052ef567db9a2654cc6820d954',
  '0011_idempotency_case_link': 'e22b88ff5f35e780102f38ffe79ede1648c477ead6c6bf8b3fc60f154fc70dcb',
  '0012_review_target_type_idx': '8511073601bf6546fb48b68544ba5e79f51de6d1e3f0a4fa8c4674180bcaf4ce',
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
    'upgrade a database that already holds data (from 0006): old rows become searchable, sign-in inserts work',
    SLOW,
    async () => {
      const files = await loadMigrations();
      const dir = await scratchDir('upgrade');
      for (const file of files.filter((f) => BEFORE_SEARCH.includes(f.name))) {
        await writeFile(join(dir, `${file.name}.sql`), file.sql);
      }
      expect((await migrate(db, { dir })).appliedNow).toEqual(BEFORE_SEARCH);
      await seedFoundation(db);

      const repos = createRepositories(db).forTenant(CONTOSO_SCOPE);
      const input = buildIngestInput({
        caseId: 'case_legacy',
        title: 'Legacy quokka case',
        receivedSeed: 'legacy',
      });
      await repos.cases.ingest(input);
      await repos.analysis.saveSnapshot(buildSnapshot(input));
      // A response stored before 0011: completed, about the case, and with no link to it.
      await db.query(
        `INSERT INTO idempotency_keys (tenant_id, scope_name, key, request_hash, state, response_status,
                                       response, created_at, completed_at, expires_at)
         VALUES ($1, 'cases.create:legacy', 'legacy-key-00000001', 'hash', 'completed', 201, $2::jsonb,
                 now(), now(), now() + interval '1 day')`,
        [CONTOSO_SCOPE.tenantId, JSON.stringify({ case: { id: 'case_legacy' }, created: true })],
      );

      const insertGranted = () =>
        db.query<{ granted: boolean }>(
          "SELECT has_table_privilege('caseguard_app', 'users', 'INSERT') AS granted",
        );
      const emailIndexes = () =>
        db.query<{ indexname: string; indexdef: string }>(
          "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'users' AND indexname LIKE 'users_tenant_email%'",
        );
      const openIndexes = () =>
        db.query<{ indexname: string; indexdef: string }>(
          "SELECT indexname, indexdef FROM pg_indexes WHERE indexname LIKE '%\\_open\\_idx' ORDER BY indexname",
        );
      expect((await insertGranted()).rows[0]?.granted).toBe(false);
      expect((await emailIndexes()).rows.map((row) => row.indexname)).toEqual([
        'users_tenant_email_uq',
      ]);
      expect((await openIndexes()).rows).toEqual([]);
      await expect(db.query('SELECT search_tsv FROM cases')).rejects.toBeDefined();

      const upgraded = await migrate(db);
      expect(upgraded.appliedNow).toEqual(MIGRATION_NAMES.slice(BEFORE_SEARCH.length));
      expect(upgraded.status.pending).toEqual([]);
      expect(upgraded.status.latest).toBe(LATEST_MIGRATION);

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

      // The dashboard indexes (0008) are partial, so they only cover what is still open, and the
      // read models work on the upgraded data with no re-analysis.
      const open = (await openIndexes()).rows;
      expect(open.map((row) => row.indexname)).toEqual([
        'case_warnings_open_idx',
        'missing_evidence_open_idx',
      ]);
      expect(open[0]?.indexdef).toMatch(/WHERE \(state = 'open'/);
      expect(open[1]?.indexdef).toMatch(/WHERE \(resolved_at IS NULL\)/);
      expect(await repos.analysis.summarize(['case_legacy'])).toEqual([
        {
          caseId: 'case_legacy',
          qualityIndex: 72,
          avoidableEffortPct: 31,
          leadingHypothesis: { name: 'Proxy rule blocks the sign-in endpoint', confidence: 0.6 },
          openWarningCount: 2,
        },
      ]);
      expect((await repos.analysis.listOpenWarnings({ limit: 10 })).map((w) => w.id)).toEqual([
        'warn_case_legacy_scope',
        'warn_case_legacy_logs',
      ]);
      expect((await repos.cases.counts()).byAnalysisState.analyzed).toBe(1);

      // 0010: a reference is unique within a tenant and found through the constraint's own index
      // (the plain index of 0003 is gone).
      const referenceIndexes = await db.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
          WHERE tablename = 'cases' AND indexname IN ('cases_reference_idx', 'cases_tenant_reference_uq')`,
      );
      expect(referenceIndexes.rows.map((row) => row.indexname)).toEqual([
        'cases_tenant_reference_uq',
      ]);
      expect((await repos.cases.findByReference(input.case.reference))?.id).toBe('case_legacy');
      await expect(
        repos.cases.ingest(
          buildIngestInput({
            caseId: 'case_second',
            receivedSeed: 'second',
            reference: input.case.reference,
          }),
        ),
      ).rejects.toMatchObject({ code: 'conflict', details: { reason: 'duplicate' } });

      // 0011: the key written before it has no link, and is still removed with its case.
      const link = await db.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_name = 'idempotency_keys' AND column_name = 'case_id'`,
      );
      expect(link.rows).toHaveLength(1);
      const legacyKey = await db.query<{ case_id: string | null }>(
        "SELECT case_id FROM idempotency_keys WHERE key = 'legacy-key-00000001'",
      );
      expect(legacyKey.rows).toEqual([{ case_id: null }]);
      expect(await repos.idempotency.purgeForCase('case_legacy')).toBe(1);
      expect(
        (await db.query('SELECT 1 FROM idempotency_keys WHERE key = $1', ['legacy-key-00000001']))
          .rows,
      ).toHaveLength(0);

      // 0012: decisions can be listed by target type through their own indexes.
      const reviewIndexes = await db.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
          WHERE tablename = 'review_decisions' AND indexname LIKE '%\\_type\\_idx' ORDER BY indexname`,
      );
      expect(reviewIndexes.rows.map((row) => row.indexname)).toEqual([
        'review_decisions_case_type_idx',
        'review_decisions_type_idx',
      ]);
      expect((await repos.reviews.list({ limit: 5, targetType: 'action_value' })).items).toEqual(
        [],
      );

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
    'refuse the unique case reference (0010) while two cases of a tenant share one, say which migration and constraint, and apply once they no longer do',
    SLOW,
    async () => {
      const files = await loadMigrations();
      const dir = await scratchDir('duplicates');
      for (const file of files.filter((f) => BEFORE_REFERENCE_UNIQUE.includes(f.name))) {
        await writeFile(join(dir, `${file.name}.sql`), file.sql);
      }
      expect((await migrate(db, { dir })).appliedNow).toEqual(BEFORE_REFERENCE_UNIQUE);
      await seedFoundation(db);

      // Possible until 0010: nothing but the service checked the reference.
      const repos = createRepositories(db).forTenant(CONTOSO_SCOPE);
      for (const [caseId, seed] of [
        ['case_one', '1'],
        ['case_two', '2'],
      ] as const) {
        await repos.cases.ingest(
          buildIngestInput({ caseId, receivedSeed: seed, reference: 'CG-SHARED' }),
        );
      }

      const failure = await migrate(db).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(MigrationError);
      const message = (failure as MigrationError).message;
      expect(message).toMatch(/0010_case_reference_unique/);
      expect(message).toMatch(/23505/);
      expect(message).toMatch(/cases_tenant_reference_uq/);
      expect(message).not.toMatch(/CG-SHARED|CREATE|ALTER/); // no data and no SQL in the message

      // All or nothing: the migration left no trace, and 0011 was not attempted.
      const status = await getMigrationStatus(db);
      expect(status.applied.map((entry) => entry.name)).toEqual(BEFORE_REFERENCE_UNIQUE);
      expect(status.pending).toEqual(MIGRATION_NAMES.slice(BEFORE_REFERENCE_UNIQUE.length));
      const referenceObjects = () =>
        db.query<{ name: string }>(
          `SELECT indexname AS name FROM pg_indexes
            WHERE tablename = 'cases' AND indexname IN ('cases_reference_idx', 'cases_tenant_reference_uq')`,
        );
      expect((await referenceObjects()).rows.map((row) => row.name)).toEqual([
        'cases_reference_idx',
      ]);

      // The operator resolves the pair with SQL, as the migration comment says (here by renaming one
      // case, in both the column and the stored entity), and runs the migration again.
      await db.query(
        `UPDATE cases SET reference = 'CG-SHARED-2', data = jsonb_set(data, '{reference}', '"CG-SHARED-2"')
          WHERE tenant_id = $1 AND id = 'case_two'`,
        [CONTOSO_SCOPE.tenantId],
      );
      const resumed = await migrate(db);
      expect(resumed.appliedNow).toEqual(MIGRATION_NAMES.slice(BEFORE_REFERENCE_UNIQUE.length));
      expect((await referenceObjects()).rows.map((row) => row.name)).toEqual([
        'cases_tenant_reference_uq',
      ]);
      expect((await repos.cases.findByReference('CG-SHARED'))?.id).toBe('case_one');
      expect((await repos.cases.findByReference('CG-SHARED-2'))?.id).toBe('case_two');
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
    await expect(migrate(db, { dir })).rejects.toBeInstanceOf(MigrationError);
    await expect(migrate(db, { dir })).rejects.toThrow(
      /Migration 0002_broken failed and was rolled back \(database error 42P01\)/,
    );
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
