import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { GOVERNANCE_SECTIONS } from '@caseguard/schemas';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseOptions } from '../src/db/client';
import { loadMigrations } from '../src/db/migrate';
import { runMigrateCli, type CliOutput, type MigrateCliDeps } from '../src/db/migrate-command';
import type { Database } from '../src/db/repositories/types';
import {
  TEST_DATABASE_STARTUP_TIMEOUT_MS,
  createTestDatabase,
  withFaultInjection,
} from '../src/db/testing';

/*
 * `pnpm db:migrate [--status] [--tenant <id>]...`, the command the deployed migration job runs.
 * The command is driven through `runMigrateCli` with an injected database and output; the last two
 * groups open real PGlite databases and the real entry point. Nothing here ran against PostgreSQL.
 */

const USAGE = 'Usage: pnpm db:migrate [--status] [--tenant <id>]...';
const ENTRA_A = '11111111-2222-3333-4444-555555555555';
const ENTRA_B = '99999999-8888-7777-6666-555555555555';
const NOW = new Date('2026-03-01T08:00:00.000Z');
const API_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRATCH_ROOT = fileURLToPath(new URL('../.data/', import.meta.url));

const mapOf = (entries: Record<string, string>): { ENTRA_TENANT_MAP: string } => ({
  ENTRA_TENANT_MAP: JSON.stringify(entries),
});

function capture(): { output: CliOutput; log: string[]; error: string[]; all: () => string } {
  const log: string[] = [];
  const error: string[] = [];
  return {
    output: {
      log: (message) => void log.push(message),
      error: (message) => void error.push(message),
    },
    log,
    error,
    all: () => [...log, ...error].join('\n'),
  };
}

/** A handle on a shared database whose `close` does nothing, so several runs can use one instance. */
function lend(db: Database): Database {
  return {
    kind: db.kind,
    query: (text, params) => db.query(text, params),
    transaction: (fn) => db.transaction(fn),
    withTenant: (scope, fn) => db.withTenant(scope, fn),
    ping: () => db.ping(),
    close: async () => undefined,
  };
}

/** Runs the command against `db` (null: the database must not be opened at all). */
async function run(
  argv: string[],
  env: NodeJS.ProcessEnv,
  db: Database | null,
  deps: Partial<MigrateCliDeps> = {},
) {
  const out = capture();
  const opened: DatabaseOptions[] = [];
  const code = await runMigrateCli(
    argv,
    { DATABASE_URL: 'pglite://memory', ...env },
    {
      output: out.output,
      now: () => NOW,
      open: (options) => {
        opened.push(options);
        return db === null
          ? Promise.reject(new Error('the database must not be opened'))
          : Promise.resolve(lend(db));
      },
      ...deps,
    },
  );
  return { code, ...out, opened };
}

const tenantLines = (log: string[]): string[] => log.filter((line) => line.startsWith('Tenants:'));

async function tenantIds(db: Database): Promise<string[]> {
  const result = await db.query<{ id: string }>('SELECT id FROM tenants ORDER BY id');
  return result.rows.map((row) => row.id);
}

async function rowCounts(db: Database): Promise<Record<string, number>> {
  const result = await db.query<{ tenants: number; settings: number; migrations: number }>(
    `SELECT (SELECT count(*)::int FROM tenants) AS tenants,
            (SELECT count(*)::int FROM governance_settings) AS settings,
            (SELECT count(*)::int FROM schema_migrations) AS migrations`,
  );
  return { ...result.rows[0] };
}

describe('[NFR-DX-01] migrate command: arguments and inputs are checked before the database is opened', () => {
  it.each([
    [['--bogus']],
    [['--tenant']],
    [['--tenant', '--status']],
    [['--tenant', '-x']],
    [['extra']],
    [['--status=1']],
    [['--status', '--other']],
    [['--tenants', 'a']],
  ])(
    '%j is a usage error: exit 2, the usage on stderr, nothing opened or printed',
    async (argv) => {
      const result = await run(argv, {}, null);
      expect(result.code).toBe(2);
      expect(result.error).toEqual([USAGE]);
      expect(result.log).toEqual([]);
      expect(result.opened).toEqual([]);
    },
  );

  it.each([
    ['an id with a space', ['--tenant', 'bad id marker-1']],
    ['an empty value after =', ['--tenant=']],
    ['an empty value after a space', ['--tenant', '']],
    ['an id that starts with punctuation', ['--tenant=_marker-2']],
    ['an id over 120 characters', ['--tenant', 'a'.repeat(121)]],
    ['an invalid second flag', ['--tenant', 'tenant_ok', '--tenant', 'bad/marker-3']],
  ])(
    'rejects %s with exit 1, naming the flag but not its value, before any database work',
    async (_name, argv) => {
      const result = await run(argv, {}, null);
      expect(result.code).toBe(1);
      expect(result.error).toHaveLength(1);
      expect(result.error[0]).toMatch(
        /^Invalid --tenant value \(#[12]\): a tenant id is 1-120 characters: letters, digits and _ \. : - only/,
      );
      expect(result.all()).not.toMatch(/marker-\d/);
      expect(result.log).toEqual([]);
      expect(result.opened).toEqual([]);
    },
  );

  it.each([
    ['text that is not JSON', '{not json marker-4'],
    ['an empty object', '{}'],
    ['an array', '["marker-5"]'],
    ['a key that is not a GUID', '{"contoso-marker-6":"tenant_a"}'],
    ['a tenant id with a space', `{"${ENTRA_A}":"tenant marker-7"}`],
    ['a value that is not a string', `{"${ENTRA_A}":["marker-8"]}`],
  ])(
    'rejects an ENTRA_TENANT_MAP that is %s with exit 1, without echoing it',
    async (_name, text) => {
      for (const argv of [[], ['--status']]) {
        const result = await run(argv, { ENTRA_TENANT_MAP: text }, null);
        expect(result.code).toBe(1);
        expect(result.error).toEqual([
          'ENTRA_TENANT_MAP is not valid: it must be a non-empty JSON object mapping Entra tenant ids (GUIDs) to CaseGuard tenant ids',
        ]);
        expect(result.all()).not.toMatch(/marker-\d/);
        expect(result.log).toEqual([]);
        expect(result.opened).toEqual([]);
      }
    },
  );
});

describe('[NFR-DX-01] migrate command: provisioning the mapped tenants (migrated database, PGlite)', () => {
  let db: Database;
  let migrationCount = 0;

  beforeAll(async () => {
    db = await createTestDatabase({ seed: false });
    migrationCount = (await loadMigrations()).length;
  }, TEST_DATABASE_STARTUP_TIMEOUT_MS);
  afterAll(async () => {
    await db.close();
  });
  afterEach(async () => {
    await db.query('TRUNCATE tenants CASCADE');
  });

  it('provisions the mapped tenants in the order written, then the flagged ones, and prints one line each', async () => {
    const env = mapOf({ [ENTRA_B]: 'tenant_two', [ENTRA_A]: 'tenant_one' });
    const first = await run(['--tenant', 'tenant_three', '--tenant=tenant_one'], env, db);
    expect(first.code).toBe(0);
    expect(tenantLines(first.log)).toEqual([
      'Tenants: tenant_two created',
      'Tenants: tenant_one created',
      'Tenants: tenant_three created',
    ]);
    expect(first.log).toContain('No pending migrations.');
    expect(first.log).toContain(`Applied: ${migrationCount}, pending: 0`);
    expect(first.error).toEqual([]);
    expect(await tenantIds(db)).toEqual(['tenant_one', 'tenant_three', 'tenant_two']);
    expect((await rowCounts(db)).settings).toBe(3 * GOVERNANCE_SECTIONS.length);

    // Running the job again (every deployment does) is safe and says so.
    const second = await run(['--', '--tenant', 'tenant_four'], env, db);
    expect(second.code).toBe(0);
    expect(tenantLines(second.log)).toEqual([
      'Tenants: tenant_two already provisioned',
      'Tenants: tenant_one already provisioned',
      'Tenants: tenant_four created',
    ]);
    expect(await tenantIds(db)).toHaveLength(4);
  });

  it('prints no connection string, host, secret, token or Entra tenant id', async () => {
    // secretscan:allow-next-line synthetic marker used to prove the value is never printed
    const password = 'p4ssw0rd-marker-91';
    const url = `postgres://caseguard:${password}@db-host-marker.invalid:5432/app?sslmode=require`;
    const result = await run([], { DATABASE_URL: url, ...mapOf({ [ENTRA_A]: 'tenant_one' }) }, db);
    expect(result.code).toBe(0);
    expect(result.opened).toEqual([
      { url, auth: 'password', poolMax: undefined, applicationName: 'caseguard-migrate' },
    ]);
    expect(result.log[0]).toBe('Database: PostgreSQL');
    expect(result.all()).not.toContain(password);
    expect(result.all()).not.toContain('db-host-marker');
    expect(result.all()).not.toContain(ENTRA_A);
  });

  it('passes the authentication mode and pool size on, and says which authentication is used', async () => {
    const entra = await run([], { DATABASE_AUTH: 'entra', DB_POOL_MAX: '7' }, db);
    expect(entra.opened[0]).toMatchObject({ auth: 'entra', poolMax: 7 });
    expect(entra.log[0]).toBe('Database: PGlite (memory) with Microsoft Entra authentication');
    const bad = await run([], { DB_POOL_MAX: 'many' }, db);
    expect(bad.opened[0]).toMatchObject({ auth: 'password', poolMax: undefined });
    expect(bad.log[0]).toBe('Database: PGlite (memory)');
  });

  it('says so when no tenant was requested, and creates nothing', async () => {
    for (const env of [{}, { ENTRA_TENANT_MAP: '   ' }, { ENTRA_TENANT_MAP: '' }]) {
      const result = await run([], env, db);
      expect(result.code).toBe(0);
      expect(tenantLines(result.log)).toEqual([
        'Tenants: none requested (set ENTRA_TENANT_MAP or pass --tenant <id>)',
      ]);
    }
    expect(await tenantIds(db)).toEqual([]);
  });

  it('--status reports missing tenants (exit 1) without writing anything, and passes once they exist', async () => {
    const env = mapOf({ [ENTRA_A]: 'tenant_one' });
    const before = await rowCounts(db);

    const missing = await run(['--status', '--tenant', 'tenant_two'], env, db);
    expect(missing.code).toBe(1);
    expect(tenantLines(missing.log)).toEqual([
      'Tenants: tenant_one missing',
      'Tenants: tenant_two missing',
    ]);
    expect(missing.error).toEqual([
      '2 of 2 tenant(s) are not provisioned: run pnpm db:migrate without --status to provision them.',
    ]);
    expect(missing.log).toContain(`Applied: ${migrationCount}, pending: 0`);
    expect(await rowCounts(db)).toEqual(before);

    await run([], env, db);
    const partly = await run(['--status', '--tenant', 'tenant_two'], env, db);
    expect(partly.code).toBe(1);
    expect(tenantLines(partly.log)).toEqual([
      'Tenants: tenant_one provisioned',
      'Tenants: tenant_two missing',
    ]);
    expect(partly.error).toEqual([
      '1 of 2 tenant(s) are not provisioned: run pnpm db:migrate without --status to provision them.',
    ]);

    await run(['--tenant', 'tenant_two'], env, db);
    const complete = await run(['--status', '--tenant', 'tenant_two'], env, db);
    expect(complete.code).toBe(0);
    expect(tenantLines(complete.log)).toEqual([
      'Tenants: tenant_one provisioned',
      'Tenants: tenant_two provisioned',
    ]);
    expect(complete.error).toEqual([]);
  });

  it('--status without any requested tenant is the plain migration status, as before', async () => {
    const result = await run(['--', '--status'], {}, db);
    expect(result.code).toBe(0);
    expect(tenantLines(result.log)).toEqual([]);
    expect(result.log).toContain(`Applied: ${migrationCount}, pending: 0`);
    expect(result.log.filter((line) => line.startsWith('  [x] '))).toHaveLength(migrationCount);
  });

  it('a provisioning failure exits 1 after the migrations, with a message that holds no detail of the error', async () => {
    const faulty = withFaultInjection(db);
    faulty.arm({ match: /INSERT INTO tenants/, error: new Error('boom: secret-marker-55') });
    const result = await run(['--tenant', 'tenant_one'], {}, faulty);
    faulty.disarm();
    expect(result.code).toBe(1);
    expect(result.error).toEqual([
      'Tenant provisioning failed (the migrations above were applied; re-running is safe): unexpected Error',
    ]);
    expect(result.all()).not.toContain('secret-marker-55');
    expect(result.log).toContain(`Applied: ${migrationCount}, pending: 0`);
    expect(await tenantIds(db)).toEqual([]);

    // A retry without the fault provisions the tenant.
    expect(tenantLines((await run(['--tenant', 'tenant_one'], {}, db)).log)).toEqual([
      'Tenants: tenant_one created',
    ]);
  });

  it('a refusal by the database says which role to use, with the SQLSTATE and nothing else', async () => {
    // Migrations run as the owner; the role is dropped right after the tenant context is set, as the
    // runtime role would have been, so only the tenant insert is refused.
    const demoted: Database = {
      ...lend(db),
      transaction: (fn) =>
        db.transaction(async (tx) => {
          let demotedYet = false;
          return fn({
            query: async (text, params) => {
              if (!demotedYet && text.includes("set_config('app.tenant_id'")) {
                demotedYet = true;
                await tx.query('SET LOCAL ROLE caseguard_app');
              }
              return tx.query(text, params);
            },
          });
        }),
    };
    const result = await run(['--tenant', 'tenant_one'], {}, demoted);
    expect(result.code).toBe(1);
    expect(result.error).toHaveLength(1);
    expect(result.error[0]).toMatch(
      /^Tenant provisioning failed \(the migrations above were applied; re-running is safe\): .*run it as the role that owns the schema.*: database error 42501/,
    );
    expect(await tenantIds(db)).toEqual([]);
  });

  it('a modified applied migration stops the run before any tenant is provisioned', async () => {
    const files = await loadMigrations();
    const first = files[0];
    if (first === undefined) throw new Error('no migrations found');
    await db.query('UPDATE schema_migrations SET checksum = $1 WHERE name = $2', [
      'tampered',
      first.name,
    ]);
    try {
      const apply = await run(['--tenant', 'tenant_one'], {}, db);
      expect(apply.code).toBe(1);
      expect(apply.error).toEqual([
        `Migration failed: Applied migrations were modified after they ran: ${first.name}. Add a new migration instead of editing an applied one.`,
      ]);
      expect(tenantLines(apply.log)).toEqual([]);

      const status = await run(['--status', '--tenant', 'tenant_one'], {}, db);
      expect(status.code).toBe(1);
      expect(status.error).toContain(`Checksum mismatch: ${first.name}`);
      expect(await tenantIds(db)).toEqual([]);
    } finally {
      await db.query('UPDATE schema_migrations SET checksum = $1 WHERE name = $2', [
        first.checksum,
        first.name,
      ]);
    }
  });

  it('a database that cannot be opened is reported by error code only', async () => {
    const refused = Object.assign(
      new Error('connect ECONNREFUSED 10.1.2.3:5432 user=secret-marker'),
      {
        code: 'ECONNREFUSED',
      },
    );
    const result = await run([], {}, null, { open: () => Promise.reject(refused) });
    expect(result.code).toBe(1);
    expect(result.error).toEqual(['Migration failed: connection failure (ECONNREFUSED)']);
    expect(result.all()).not.toContain('secret-marker');
    expect(result.all()).not.toContain('10.1.2.3');
  });
});

describe('[NFR-DX-01] migrate command: a database that was never migrated (PGlite)', () => {
  let db: Database;
  beforeAll(async () => {
    db = await createTestDatabase({ migrate: false, seed: false });
  }, TEST_DATABASE_STARTUP_TIMEOUT_MS);
  afterAll(async () => {
    await db.close();
  });

  it('--status lists every migration as pending and every requested tenant as missing, and writes nothing', async () => {
    const migrationCount = (await loadMigrations()).length;
    const result = await run(
      ['--status', '--tenant', 'tenant_two'],
      mapOf({ [ENTRA_A]: 'tenant_one' }),
      db,
    );
    expect(result.code).toBe(1);
    expect(result.log).toContain(`Applied: 0, pending: ${migrationCount}`);
    expect(tenantLines(result.log)).toEqual([
      'Tenants: tenant_one missing',
      'Tenants: tenant_two missing',
    ]);
    const tables = await db.query<{ tenants: string | null; migrations: string | null }>(
      "SELECT to_regclass('tenants') AS tenants, to_regclass('schema_migrations') AS migrations",
    );
    expect(tables.rows[0]).toEqual({ tenants: null, migrations: null });
  });

  it(
    'without --status it applies every migration and then provisions the tenants',
    { timeout: 300_000 },
    async () => {
      const migrationCount = (await loadMigrations()).length;
      const result = await run(['--tenant', 'tenant_two'], mapOf({ [ENTRA_A]: 'tenant_one' }), db);
      expect(result.code).toBe(0);
      expect(result.log.filter((line) => line.startsWith('Applied 0'))).toHaveLength(
        migrationCount,
      );
      expect(tenantLines(result.log)).toEqual([
        'Tenants: tenant_one created',
        'Tenants: tenant_two created',
      ]);
      expect(await tenantIds(db)).toEqual(['tenant_one', 'tenant_two']);
    },
  );
});

describe('[NFR-REL-01] migrate command: real runs against a file-backed PGlite database', () => {
  const created: string[] = [];
  afterAll(async () => {
    for (const dir of created) await rm(dir, { recursive: true, force: true });
  });

  it(
    'provisions on the first run, is idempotent on the next, and reports status across restarts',
    { timeout: 420_000 },
    async () => {
      await mkdir(SCRATCH_ROOT, { recursive: true });
      const dir = await mkdtemp(join(SCRATCH_ROOT, 'migrate-cli-'));
      created.push(dir);
      const env = { DATABASE_URL: `pglite://${dir}`, ...mapOf({ [ENTRA_A]: 'tenant_e2e' }) };
      const migrationCount = (await loadMigrations()).length;
      const call = async (argv: string[]) => {
        const out = capture();
        const code = await runMigrateCli(argv, env, { output: out.output });
        return { code, ...out };
      };

      const first = await call(['--tenant', 'tenant_extra']);
      expect(first.code).toBe(0);
      expect(first.log.filter((line) => line.startsWith('Applied 0'))).toHaveLength(migrationCount);
      expect(tenantLines(first.log)).toEqual([
        'Tenants: tenant_e2e created',
        'Tenants: tenant_extra created',
      ]);

      const second = await call(['--tenant', 'tenant_extra', '--tenant', 'tenant_late']);
      expect(second.code).toBe(0);
      expect(second.log).toContain('No pending migrations.');
      expect(tenantLines(second.log)).toEqual([
        'Tenants: tenant_e2e already provisioned',
        'Tenants: tenant_extra already provisioned',
        'Tenants: tenant_late created',
      ]);

      const status = await call(['--status', '--tenant', 'tenant_nope']);
      expect(status.code).toBe(1);
      expect(tenantLines(status.log)).toEqual([
        'Tenants: tenant_e2e provisioned',
        'Tenants: tenant_nope missing',
      ]);

      // What the runs left behind, read through a fresh open of the same files.
      const reopened = await createDatabase({ url: `pglite://${dir}` });
      try {
        const rows = await reopened.query<{ id: string; settings: number; synthetic: boolean }>(
          `SELECT t.id, t.synthetic,
                  (SELECT count(*)::int FROM governance_settings g WHERE g.tenant_id = t.id) AS settings
             FROM tenants t ORDER BY t.id`,
        );
        expect(rows.rows).toEqual([
          { id: 'tenant_e2e', synthetic: false, settings: GOVERNANCE_SECTIONS.length },
          { id: 'tenant_extra', synthetic: false, settings: GOVERNANCE_SECTIONS.length },
          { id: 'tenant_late', synthetic: false, settings: GOVERNANCE_SECTIONS.length },
        ]);
      } finally {
        await reopened.close();
      }
    },
  );
});

describe('[NFR-DX-01] migrate command: the entry point', () => {
  const execute = async (argv: string[], env: Record<string, string>) => {
    try {
      const done = await promisify(execFile)(
        process.execPath,
        ['--import', 'tsx', 'src/db/migrate-cli.ts', ...argv],
        { cwd: API_ROOT, env: { ...process.env, ...env }, timeout: 60_000 },
      );
      return { code: 0, stdout: done.stdout, stderr: done.stderr };
    } catch (error) {
      const failed = error as { code?: number; stdout?: string; stderr?: string };
      return { code: failed.code ?? -1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
    }
  };

  it(
    'sets the exit code from the command: 2 for a usage error, 1 for an invalid map, nothing opened',
    { timeout: 120_000 },
    async () => {
      const usage = await execute(['--bogus'], {});
      expect(usage.code).toBe(2);
      expect(usage.stderr.trim()).toBe(USAGE);
      expect(usage.stdout).toBe('');

      const invalid = await execute([], { ENTRA_TENANT_MAP: '{not json marker-9' });
      expect(invalid.code).toBe(1);
      expect(invalid.stderr).toContain('ENTRA_TENANT_MAP is not valid');
      expect(invalid.stderr + invalid.stdout).not.toContain('marker-9');
      expect(invalid.stdout).toBe('');
    },
  );
});
