import {
  DEFAULT_GOVERNANCE_VALUES,
  GOVERNANCE_SECTIONS,
  TenantSchema,
  type GovernanceSection,
} from '@caseguard/schemas';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../src/db/client';
import { getDatabaseErrorCode } from '../src/db/errors';
import { migrate } from '../src/db/migrate';
import {
  MAX_PROVISIONED_TENANTS,
  PROVISIONING_ACTOR,
  findMissingTenants,
  isValidTenantId,
  provisionTenants,
} from '../src/db/provision';
import { createRepositories } from '../src/db/repositories';
import type { Database, SqlExecutor } from '../src/db/repositories/types';
import { CONTOSO_TENANT_ID, FABRIKAM_TENANT_ID, seedFoundation } from '../src/db/seed';
import {
  TEST_DATABASE_STARTUP_TIMEOUT_MS,
  TestClock,
  createSequentialIdGenerator,
  createTestDatabase,
  resetTestDatabase,
  withFaultInjection,
} from '../src/db/testing';
import { ConflictError, ForbiddenError, NotFoundError, ValidationFailedError } from '../src/errors';

/*
 * Tenant provisioning (OP-7): the tenant rows a deployed environment needs before the first sign-in.
 * Everything here runs on PGlite; nothing was run against a PostgreSQL server or Azure.
 */

const NOW = new Date('2026-03-01T08:00:00.000Z');
const LATER = new Date('2026-03-02T08:00:00.000Z');
const SEEDED_TENANTS = [CONTOSO_TENANT_ID, FABRIKAM_TENANT_ID];

type Row = Record<string, unknown>;

interface SettingRow {
  tenant_id: string;
  section: GovernanceSection;
  value: unknown;
  version: number;
  updated_at: string;
  updated_by: string;
  change_note: string;
}

/** Every row provisioning could touch, read on the owner connection (superuser: no RLS in the way). */
async function snapshot(db: Database): Promise<{ tenants: Row[]; settings: Row[]; users: Row[] }> {
  const tenants = await db.query(
    'SELECT id, name, slug, synthetic, created_at, data FROM tenants ORDER BY id',
  );
  const settings = await db.query(
    `SELECT tenant_id, section, value, version, updated_at, updated_by, change_note
       FROM governance_settings ORDER BY tenant_id, section`,
  );
  const users = await db.query(
    `SELECT tenant_id, id, display_name, email, roles, status, version, created_at, updated_at, data
       FROM users ORDER BY tenant_id, id`,
  );
  return { tenants: tenants.rows, settings: settings.rows, users: users.rows };
}

async function tenantIds(db: Database): Promise<string[]> {
  const result = await db.query<{ id: string }>('SELECT id FROM tenants ORDER BY id');
  return result.rows.map((row) => row.id);
}

async function settingsOf(db: Database, tenantId: string): Promise<Map<string, SettingRow>> {
  const result = await db.query<SettingRow>(
    `SELECT tenant_id, section, value, version, updated_at, updated_by, change_note
       FROM governance_settings WHERE tenant_id = $1`,
    [tenantId],
  );
  return new Map(result.rows.map((row) => [row.section, row]));
}

async function slugsOf(db: Database): Promise<Record<string, string>> {
  const result = await db.query<{ id: string; slug: string }>('SELECT id, slug FROM tenants');
  return Object.fromEntries(result.rows.map((row) => [row.id, row.slug]));
}

/** Records the SQL text of every statement; the database is otherwise untouched. */
function recording(database: Database): { db: Database; statements: string[] } {
  const statements: string[] = [];
  const wrap = (executor: SqlExecutor): SqlExecutor => ({
    query: (text, params) => {
      statements.push(text);
      return executor.query(text, params);
    },
  });
  const db: Database = {
    kind: database.kind,
    query: (text, params) => wrap(database).query(text, params),
    transaction: (fn) => database.transaction((tx) => fn(wrap(tx))),
    withTenant: (scope, fn) => database.withTenant(scope, (tx) => fn(wrap(tx))),
    ping: () => database.ping(),
    close: () => database.close(),
  };
  return { db, statements };
}

/** Runs every statement as `role`, as a deployment whose migration user is not a superuser would. */
function asRole(db: Database, role: string): Database {
  return {
    kind: db.kind,
    query: (text, params) =>
      db.transaction(async (tx) => {
        await tx.query(`SET LOCAL ROLE ${role}`);
        return tx.query(text, params);
      }),
    transaction: (fn) =>
      db.transaction(async (tx) => {
        await tx.query(`SET LOCAL ROLE ${role}`);
        return fn(tx);
      }),
    withTenant: (scope, fn) => db.withTenant(scope, fn),
    ping: () => db.ping(),
    close: () => db.close(),
  };
}

const failure = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => {
      throw new Error('expected the operation to fail');
    },
    (error: unknown) => error,
  );

describe('[NFR-REL-01] provisionTenants: idempotent creation of tenants and their defaults', () => {
  let database: Database;
  beforeAll(async () => {
    database = await createTestDatabase();
  }, TEST_DATABASE_STARTUP_TIMEOUT_MS);
  afterAll(async () => {
    await database.close();
  });
  afterEach(async () => {
    await resetTestDatabase(database);
  });

  it('creates the tenant and every default governance section at version 1, then does nothing on a re-run', async () => {
    const first = await provisionTenants(database, [{ id: 'tenant_acme' }], { now: () => NOW });
    expect(first).toEqual({ created: ['tenant_acme'], existing: [] });

    const stored = await database.query(
      'SELECT id, name, slug, synthetic, created_at, data FROM tenants WHERE id = $1',
      ['tenant_acme'],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]).toMatchObject({
      id: 'tenant_acme',
      name: 'tenant_acme',
      slug: 'tenant-acme',
      synthetic: false,
      created_at: NOW.toISOString(),
    });
    expect(TenantSchema.parse(stored.rows[0]?.data)).toEqual({
      id: 'tenant_acme',
      name: 'tenant_acme',
      slug: 'tenant-acme',
      synthetic: false,
      createdAt: NOW.toISOString(),
    });

    const settings = await settingsOf(database, 'tenant_acme');
    expect([...settings.keys()].sort()).toEqual([...GOVERNANCE_SECTIONS].sort());
    for (const row of settings.values()) {
      expect(row).toMatchObject({
        version: 1,
        updated_by: PROVISIONING_ACTOR,
        change_note: 'Default configuration',
        updated_at: NOW.toISOString(),
      });
      expect(row.value).toEqual(DEFAULT_GOVERNANCE_VALUES[row.section]);
    }
    expect(PROVISIONING_ACTOR).toBe('system:provision');

    const before = await snapshot(database);
    const second = await provisionTenants(database, [{ id: 'tenant_acme' }], { now: () => LATER });
    expect(second).toEqual({ created: [], existing: ['tenant_acme'] });
    expect(await snapshot(database)).toEqual(before);
  });

  it('honours a name, a slug and the synthetic flag, and validates the stored tenant', async () => {
    await provisionTenants(
      database,
      [
        { id: 'tenant_named', name: 'Named Tenant', slug: 'named-tenant' },
        { id: 'tenant_flagged', synthetic: true },
      ],
      { now: () => NOW },
    );
    const rows = await database.query<Row>(
      "SELECT id, name, slug, synthetic, data FROM tenants WHERE id IN ('tenant_named', 'tenant_flagged') ORDER BY id",
    );
    expect(rows.rows.map((r) => [r.id, r.name, r.slug, r.synthetic])).toEqual([
      ['tenant_flagged', 'tenant_flagged', 'tenant-flagged', true],
      ['tenant_named', 'Named Tenant', 'named-tenant', false],
    ]);
    for (const row of rows.rows) TenantSchema.parse(row.data);
  });

  it('leaves an existing tenant (the seeded Contoso) untouched, whatever values are requested', async () => {
    const before = await snapshot(database);
    expect(before.users.length).toBeGreaterThan(0);

    const result = await provisionTenants(
      database,
      [
        { id: CONTOSO_TENANT_ID, name: 'Renamed', slug: 'renamed', synthetic: false },
        { id: FABRIKAM_TENANT_ID },
      ],
      { now: () => LATER },
    );
    expect(result).toEqual({ created: [], existing: [CONTOSO_TENANT_ID, FABRIKAM_TENANT_ID] });
    expect(await snapshot(database)).toEqual(before);
  });

  it('adds only the governance sections an existing tenant lacks and never rewrites an edited one', async () => {
    await provisionTenants(database, [{ id: 'tenant_acme' }], { now: () => NOW });
    await database.query(
      `UPDATE governance_settings
          SET version = 3, updated_by = 'user_admin', change_note = 'Tuned thresholds'
        WHERE tenant_id = 'tenant_acme' AND section = 'quality'`,
    );
    await database.query(
      "DELETE FROM governance_settings WHERE tenant_id = 'tenant_acme' AND section = 'retention'",
    );
    const before = await settingsOf(database, 'tenant_acme');
    expect(before.has('retention')).toBe(false);

    const result = await provisionTenants(database, [{ id: 'tenant_acme' }], { now: () => LATER });
    expect(result).toEqual({ created: [], existing: ['tenant_acme'] });

    const after = await settingsOf(database, 'tenant_acme');
    expect(after.get('quality')).toEqual(before.get('quality'));
    expect(after.get('quality')).toMatchObject({ version: 3, updated_by: 'user_admin' });
    expect(after.get('retention')).toMatchObject({
      version: 1,
      updated_by: PROVISIONING_ACTOR,
      updated_at: LATER.toISOString(),
    });
    for (const [section, row] of before) {
      if (section !== 'retention') expect(after.get(section)).toEqual(row);
    }
  });

  it('reports created and existing tenants in the order requested and ignores identical duplicates', async () => {
    const result = await provisionTenants(database, [
      { id: 'tenant_b' },
      { id: CONTOSO_TENANT_ID },
      { id: 'tenant_a' },
      { id: 'tenant_b' },
    ]);
    expect(result).toEqual({
      created: ['tenant_b', 'tenant_a'],
      existing: [CONTOSO_TENANT_ID],
    });
    expect(await tenantIds(database)).toEqual([...SEEDED_TENANTS, 'tenant_a', 'tenant_b'].sort());
    expect((await settingsOf(database, 'tenant_b')).size).toBe(GOVERNANCE_SECTIONS.length);
  });

  it('an empty list is a no-op that does not touch the database', async () => {
    const { db, statements } = recording(database);
    expect(await provisionTenants(db, [])).toEqual({ created: [], existing: [] });
    expect(statements).toEqual([]);
  });

  it('accepts the boundary ids and derives a safe slug for each', async () => {
    const longId = 'a'.repeat(120);
    const result = await provisionTenants(database, [
      { id: longId },
      { id: 'Tenant.One:Prod-1_a' },
      { id: '1tenant' },
    ]);
    expect(result.created).toEqual([longId, 'Tenant.One:Prod-1_a', '1tenant']);
    const slugs = await slugsOf(database);
    expect(slugs[longId]).toBe('a'.repeat(60));
    expect(slugs['Tenant.One:Prod-1_a']).toBe('tenant-one-prod-1-a');
    expect(slugs['1tenant']).toBe('1tenant');
    for (const slug of Object.values(slugs)) expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });
});

describe('[NFR-REL-01] provisionTenants: slugs are unique across tenants', () => {
  let database: Database;
  beforeAll(async () => {
    database = await createTestDatabase();
  }, TEST_DATABASE_STARTUP_TIMEOUT_MS);
  afterAll(async () => {
    await database.close();
  });
  afterEach(async () => {
    await resetTestDatabase(database);
  });

  it('suffixes a derived slug that another tenant already uses, deterministically and permanently', async () => {
    const requested = [{ id: 'tenant-a' }, { id: 'Tenant_A' }, { id: 'contoso-support' }];
    const first = await provisionTenants(database, requested);
    expect(first.created).toEqual(['tenant-a', 'Tenant_A', 'contoso-support']);
    // Ids are processed in code-unit order (Tenant_A, contoso-support, tenant-a), so the result
    // does not depend on the order the caller listed them in.
    const slugs = await slugsOf(database);
    expect(slugs).toMatchObject({
      Tenant_A: 'tenant-a',
      'tenant-a': 'tenant-a-2',
      'contoso-support': 'contoso-support-2',
      [CONTOSO_TENANT_ID]: 'contoso-support',
    });

    const again = await provisionTenants(database, requested);
    expect(again).toEqual({ created: [], existing: ['tenant-a', 'Tenant_A', 'contoso-support'] });
    expect(await slugsOf(database)).toEqual(slugs);
  });

  it('keeps a suffixed slug within 60 characters when long ids derive the same slug', async () => {
    const shared = 'a'.repeat(119);
    await provisionTenants(database, [{ id: `${shared}1` }, { id: `${shared}2` }]);
    const slugs = Object.values(await slugsOf(database)).filter((slug) => slug.startsWith('aaa'));
    expect(slugs.sort()).toEqual(['a'.repeat(58) + '-2', 'a'.repeat(60)].sort());
    for (const slug of slugs) expect(slug.length).toBeLessThanOrEqual(60);
  });

  it('refuses an explicit slug that another tenant uses, and rolls the whole call back', async () => {
    const error = await failure(
      provisionTenants(database, [
        { id: 'tenant_one', slug: 'free-slug' },
        { id: 'tenant_two', slug: 'contoso-support' },
      ]),
    );
    expect(error).toBeInstanceOf(ConflictError);
    expect(error).toMatchObject({ status: 409, details: { reason: 'duplicate' } });
    expect((error as Error).message).toContain('#2');
    expect((error as Error).message).not.toContain('contoso-support');
    expect(await tenantIds(database)).toEqual([...SEEDED_TENANTS].sort());
  });

  it('gives up with a clear conflict after 50 derived candidates; an explicit slug is the way out', async () => {
    await database.query(
      `INSERT INTO tenants (id, name, slug, synthetic, created_at, data)
       SELECT 'tenant_fill_' || n, 'Filler', CASE WHEN n = 1 THEN 'zzz' ELSE 'zzz-' || n END,
              false, now(), '{}'::jsonb
         FROM generate_series(1, 50) AS n`,
    );
    const error = await failure(provisionTenants(database, [{ id: 'ZZZ' }]));
    expect(error).toBeInstanceOf(ConflictError);
    expect(error).toMatchObject({ details: { reason: 'duplicate' } });
    expect((error as Error).message).toMatch(/No free slug could be derived for tenant #1/);
    expect(await tenantIds(database)).not.toContain('ZZZ');

    const result = await provisionTenants(database, [{ id: 'ZZZ', slug: 'zzz-free' }]);
    expect(result.created).toEqual(['ZZZ']);
  });
});

describe('[NFR-SEC-01] provisionTenants: input is validated and rejected, never cleaned', () => {
  let database: Database;
  beforeAll(async () => {
    database = await createTestDatabase();
  }, TEST_DATABASE_STARTUP_TIMEOUT_MS);
  afterAll(async () => {
    await database.close();
  });
  afterEach(async () => {
    await resetTestDatabase(database);
  });

  const MARKER = 'leaky-marker-31f9';
  const invalid: [string, unknown][] = [
    ['an empty id', { id: '' }],
    ['an id that starts with punctuation', { id: `_${MARKER}` }],
    ['an id with a space', { id: `a ${MARKER}` }],
    ['an id with a slash', { id: `a/${MARKER}` }],
    ['an id with SQL metacharacters', { id: `x'; DROP TABLE tenants; --${MARKER}` }],
    ['an id longer than 120 characters', { id: `a${MARKER}`.padEnd(121, 'a') }],
    ['an id with a non-ASCII letter', { id: `tenant_é${MARKER}` }],
    ['a non-string id', { id: 42 }],
    ['a missing id', {}],
    ['a name with a control character', { id: 'tenant_ok', name: `bad\nname ${MARKER}` }],
    ['a name with a leading space', { id: 'tenant_ok', name: ` ${MARKER}` }],
    ['a name with a trailing space', { id: 'tenant_ok', name: `${MARKER} ` }],
    ['an empty name', { id: 'tenant_ok', name: '' }],
    ['a name longer than 120 characters', { id: 'tenant_ok', name: MARKER.padEnd(121, 'n') }],
    ['an upper-case slug', { id: 'tenant_ok', slug: `Acme-${MARKER}` }],
    ['a slug with a space', { id: 'tenant_ok', slug: `acme ${MARKER}` }],
    ['a slug with a double hyphen', { id: 'tenant_ok', slug: `acme--${MARKER}` }],
    ['a slug with a trailing hyphen', { id: 'tenant_ok', slug: `${MARKER}-` }],
    ['a slug with an underscore', { id: 'tenant_ok', slug: `acme_${MARKER}` }],
    ['a slug longer than 60 characters', { id: 'tenant_ok', slug: MARKER.padEnd(61, 'a') }],
    ['a non-boolean synthetic flag', { id: 'tenant_ok', synthetic: `yes ${MARKER}` }],
    ['an unknown field', { id: 'tenant_ok', isAdmin: true }],
    ['null', null],
    ['a string instead of an object', `tenant_ok ${MARKER}`],
  ];

  it.each(invalid)(
    'rejects %s before any statement reaches the database, without echoing the value',
    async (_name, entry) => {
      const { db, statements } = recording(database);
      const error = await failure(
        provisionTenants(db, [{ id: 'tenant_before' }, entry as { id: string }]),
      );
      expect(error).toBeInstanceOf(ValidationFailedError);
      expect(statements).toEqual([]);
      const shown = JSON.stringify([
        (error as Error).message,
        (error as ValidationFailedError).issues,
      ]);
      expect(shown).not.toContain(MARKER);
      expect((error as ValidationFailedError).issues[0]?.path).toMatch(/^tenants\.1/);
      expect(await tenantIds(database)).toEqual([...SEEDED_TENANTS].sort());
    },
  );

  it('rejects a list that is not an array and more than the per-call maximum', async () => {
    const { db, statements } = recording(database);
    for (const bad of ['tenant_a', { id: 'tenant_a' }, null, undefined]) {
      const error = await failure(provisionTenants(db, bad as never));
      expect(error).toBeInstanceOf(ValidationFailedError);
    }
    const tooMany = Array.from({ length: MAX_PROVISIONED_TENANTS + 1 }, (_, i) => ({
      id: `tenant_${i}`,
    }));
    expect(await failure(provisionTenants(db, tooMany))).toBeInstanceOf(ValidationFailedError);
    expect(statements).toEqual([]);
  });

  it('rejects one tenant listed twice with different values', async () => {
    const error = await failure(
      provisionTenants(database, [
        { id: 'tenant_dup', name: 'First' },
        { id: 'tenant_dup', name: 'Second' },
      ]),
    );
    expect(error).toBeInstanceOf(ValidationFailedError);
    expect((error as ValidationFailedError).issues).toEqual([
      { path: 'tenants.1', message: 'A tenant listed twice must have identical values' },
    ]);
    expect(await tenantIds(database)).toEqual([...SEEDED_TENANTS].sort());
  });

  it('reports every invalid entry at once, by position', async () => {
    const error = await failure(
      provisionTenants(database, [{ id: 'ok_one' }, { id: 'bad id' }, { id: 'ok_two', slug: 'X' }]),
    );
    const paths = (error as ValidationFailedError).issues.map((issue) => issue.path);
    expect(paths).toEqual(['tenants.1.id', 'tenants.2.slug']);
  });

  it('isValidTenantId applies the schema rule exactly', () => {
    for (const good of ['a', 'A1', 'tenant_contoso_support', 'a.b:c-d_e', '1x', 'a'.repeat(120)]) {
      expect(isValidTenantId(good)).toBe(true);
    }
    for (const bad of [
      '',
      ' a',
      'a ',
      '-a',
      '_a',
      'a/b',
      'a'.repeat(121),
      'é',
      5,
      null,
      undefined,
    ]) {
      expect(isValidTenantId(bad)).toBe(false);
    }
  });
});

describe('[NFR-SEC-01] provisioned tenants work with the runtime repositories and stay isolated', () => {
  let database: Database;
  beforeAll(async () => {
    database = await createTestDatabase();
  }, TEST_DATABASE_STARTUP_TIMEOUT_MS);
  afterAll(async () => {
    await database.close();
  });
  afterEach(async () => {
    await resetTestDatabase(database);
  });

  const repositoriesFor = (tenantId: string) =>
    createRepositories(database, {
      now: new TestClock().now,
      newId: createSequentialIdGenerator(),
    }).forTenant({ tenantId, actorId: 'system:test' });

  const identity = {
    userId: 'entra-object-1',
    displayName: 'Acme Engineer (synthetic)',
    email: null,
    roles: ['engineer' as const],
    synthetic: true,
  };

  it('the first sign-in of an unprovisioned tenant cannot create its user; after provisioning it can', async () => {
    const repositories = repositoriesFor('tenant_acme');
    await expect(repositories.governance.getTenant()).rejects.toBeInstanceOf(NotFoundError);
    const refused = await failure(repositories.governance.upsertIdentityUser(identity));
    expect(refused).toBeInstanceOf(ConflictError);
    expect(refused).toMatchObject({ details: { reason: 'reference' } });

    await provisionTenants(database, [{ id: 'tenant_acme' }], { now: () => NOW });

    expect(await repositories.governance.getTenant()).toMatchObject({
      id: 'tenant_acme',
      synthetic: false,
    });
    const user = await repositories.governance.upsertIdentityUser(identity);
    expect(user).toMatchObject({ tenantId: 'tenant_acme', status: 'active', version: 1 });

    // The repository consumes the provisioned defaults as they are: nothing is re-seeded by the
    // first read, so every section still carries the provisioning actor and version 1.
    const settings = await repositories.governance.getSettings();
    for (const section of GOVERNANCE_SECTIONS) {
      expect(settings[section]).toMatchObject({
        version: 1,
        updatedBy: PROVISIONING_ACTOR,
        changeNote: 'Default configuration',
      });
    }
  });

  it('two provisioned tenants see only their own tenant row, settings and users', async () => {
    await provisionTenants(database, [{ id: 'tenant_acme' }, { id: 'tenant_beta' }]);
    const acme = repositoriesFor('tenant_acme');
    const beta = repositoriesFor('tenant_beta');
    await acme.governance.upsertIdentityUser(identity);

    expect((await acme.governance.getTenant()).id).toBe('tenant_acme');
    expect((await beta.governance.getTenant()).id).toBe('tenant_beta');
    expect((await acme.governance.listUsers()).map((u) => u.id)).toEqual(['entra-object-1']);
    expect(await beta.governance.listUsers()).toEqual([]);

    // The same holds in plain SQL as the runtime role: the tenant context decides what is visible.
    for (const tenantId of ['tenant_acme', 'tenant_beta']) {
      const visible = await database.withTenant(
        { tenantId, actorId: 'system:test' },
        async (tx) => {
          const tenants = await tx.query<{ id: string }>('SELECT id FROM tenants');
          const settings = await tx.query<{ tenant_id: string }>(
            'SELECT tenant_id FROM governance_settings',
          );
          return { tenants: tenants.rows.map((r) => r.id), settings: settings.rows };
        },
      );
      expect(visible.tenants).toEqual([tenantId]);
      expect(visible.settings).toHaveLength(GOVERNANCE_SECTIONS.length);
      expect(visible.settings.every((row) => row.tenant_id === tenantId)).toBe(true);
    }
  });

  it('provisioning writes only SELECT/INSERT statements and never touches users, audit events or other tenants', async () => {
    const before = await snapshot(database);
    const auditBefore = await database.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM audit_events',
    );
    const { db, statements } = recording(database);
    await provisionTenants(db, [{ id: 'tenant_acme' }, { id: CONTOSO_TENANT_ID }]);

    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement).toMatch(/^\s*(SELECT|INSERT INTO (tenants|governance_settings))\b/i);
      expect(statement).not.toMatch(/\b(UPDATE|DELETE|TRUNCATE|DROP|ALTER|GRANT|CREATE)\b/i);
      expect(statement).not.toMatch(/\b(users|audit_events)\b/i);
    }
    const after = await snapshot(database);
    expect(after.users).toEqual(before.users);
    expect(after.tenants.filter((t) => t.id !== 'tenant_acme')).toEqual(before.tenants);
    expect(after.settings.filter((s) => s.tenant_id !== 'tenant_acme')).toEqual(before.settings);
    const auditAfter = await database.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM audit_events',
    );
    expect(auditAfter.rows[0]?.n).toBe(auditBefore.rows[0]?.n);
  });

  it('is all-or-nothing: a failure while writing the second tenant leaves no trace of the first', async () => {
    const faulty = withFaultInjection(database);
    faulty.arm({ match: /INSERT INTO governance_settings/, after: 1 });
    await expect(
      provisionTenants(faulty, [{ id: 'tenant_a' }, { id: 'tenant_b' }]),
    ).rejects.toThrow('injected failure');
    faulty.disarm();

    expect(await tenantIds(database)).toEqual([...SEEDED_TENANTS].sort());
    const orphans = await database.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM governance_settings WHERE tenant_id IN ('tenant_a', 'tenant_b')",
    );
    expect(orphans.rows[0]?.n).toBe(0);

    // And the same call succeeds once the fault is gone.
    expect(await provisionTenants(faulty, [{ id: 'tenant_a' }, { id: 'tenant_b' }])).toEqual({
      created: ['tenant_a', 'tenant_b'],
      existing: [],
    });
  });

  it('the reserved synthetic fixture ids are provisioned as exactly the rows the seed creates', async () => {
    const tenantRows = async () => {
      const result = await database.query<{
        id: string;
        name: string;
        slug: string;
        synthetic: boolean;
        data: Row;
      }>('SELECT id, name, slug, synthetic, data FROM tenants ORDER BY id');
      return result.rows.map((row) => ({ ...row, data: { ...row.data, createdAt: undefined } }));
    };
    await database.query('TRUNCATE tenants CASCADE');
    expect(
      await provisionTenants(database, [{ id: CONTOSO_TENANT_ID }, { id: FABRIKAM_TENANT_ID }]),
    ).toEqual({
      created: [CONTOSO_TENANT_ID, FABRIKAM_TENANT_ID],
      existing: [],
    });
    const provisioned = await tenantRows();
    expect(provisioned.map((t) => [t.id, t.name, t.slug, t.synthetic])).toEqual([
      [CONTOSO_TENANT_ID, 'Contoso Support (synthetic)', 'contoso-support', true],
      [FABRIKAM_TENANT_ID, 'Fabrikam Lab (synthetic)', 'fabrikam-lab', true],
    ]);

    await database.query('TRUNCATE tenants CASCADE');
    await seedFoundation(database);
    expect(await tenantRows()).toEqual(provisioned);

    // An explicit value always wins over the fixture default.
    await database.query('TRUNCATE tenants CASCADE');
    await provisionTenants(database, [{ id: CONTOSO_TENANT_ID, synthetic: false }]);
    expect((await tenantRows())[0]).toMatchObject({ synthetic: false });
  });
});

describe('[NFR-SEC-01] findMissingTenants', () => {
  let database: Database;
  beforeAll(async () => {
    database = await createTestDatabase();
  }, TEST_DATABASE_STARTUP_TIMEOUT_MS);
  afterAll(async () => {
    await database.close();
  });
  afterEach(async () => {
    await resetTestDatabase(database);
  });

  it('returns the ids without a tenant row, in the order given and without duplicates, writing nothing', async () => {
    await provisionTenants(database, [{ id: 'tenant_acme' }]);
    const { db, statements } = recording(database);
    const missing = await findMissingTenants(db, [
      'tenant_zzz',
      'tenant_acme',
      CONTOSO_TENANT_ID,
      'tenant_nope',
      'tenant_zzz',
    ]);
    expect(missing).toEqual(['tenant_zzz', 'tenant_nope']);
    for (const statement of statements) expect(statement).toMatch(/^\s*SELECT\b/i);
    expect(await findMissingTenants(db, [])).toEqual([]);
  });

  it('rejects an invalid id without echoing it', async () => {
    const error = await failure(findMissingTenants(database, ['tenant_ok', 'bad id marker-77']));
    expect(error).toBeInstanceOf(ValidationFailedError);
    expect(
      JSON.stringify([(error as Error).message, (error as ValidationFailedError).issues]),
    ).not.toContain('marker-77');
  });
});

/*
 * The evidence that no migration is needed: the same statements run as a NON-superuser that owns the
 * schema, so the FORCED row-level-security policies of migration 0002 apply to it. The runtime role
 * `caseguard_app` can read tenants but never create them, and keeps that after provisioning.
 */
describe('[NFR-SEC-01] provisioning as a non-superuser owner under forced row-level security (PGlite)', () => {
  let db: Database;
  let owner: Database;
  let missingBeforeMigration: string[] = [];

  beforeAll(async () => {
    db = await createDatabase({ url: 'pglite://memory' });
    await db.query('CREATE ROLE cg_owner NOLOGIN CREATEROLE');
    await db.query('GRANT CREATE, USAGE ON SCHEMA public TO cg_owner');
    await db.query('CREATE ROLE cg_nobody NOLOGIN');
    await db.query('GRANT USAGE ON SCHEMA public TO cg_nobody');
    owner = asRole(db, 'cg_owner');
    // Before the first migration there is no tenants table: every id is reported missing.
    missingBeforeMigration = await findMissingTenants(owner, ['tenant_acme']);
    await migrate(owner);
  }, TEST_DATABASE_STARTUP_TIMEOUT_MS);
  afterAll(async () => {
    await db.close();
  });

  const insertTenant = (id: string) =>
    `INSERT INTO tenants (id, name, slug, synthetic, created_at, data)
     VALUES ('${id}', '${id}', '${id}', false, now(), '{}'::jsonb)`;

  it('reports every tenant missing before the schema exists', () => {
    expect(missingBeforeMigration).toEqual(['tenant_acme']);
  });

  it('creates tenants and their defaults although row-level security is forced on the owner', async () => {
    const facts = await owner.transaction(async (tx) => {
      const result = await tx.query<{ super: boolean; owner: string; forced: boolean }>(
        `SELECT r.rolsuper AS super, pg_get_userbyid(c.relowner) AS owner, c.relforcerowsecurity AS forced
           FROM pg_roles r, pg_class c
          WHERE r.rolname = current_user AND c.relname = 'tenants'`,
      );
      const settings = await tx.query<{ forced: boolean }>(
        "SELECT relforcerowsecurity AS forced FROM pg_class WHERE relname = 'governance_settings'",
      );
      return { tenants: result.rows[0], settings: settings.rows[0] };
    });
    expect(facts.tenants).toEqual({ super: false, owner: 'cg_owner', forced: true });
    expect(facts.settings).toEqual({ forced: true });

    const result = await provisionTenants(
      owner,
      [{ id: 'tenant_acme' }, { id: 'tenant_beta', name: 'Beta Labs' }],
      { now: () => NOW },
    );
    expect(result).toEqual({ created: ['tenant_acme', 'tenant_beta'], existing: [] });

    // Read back through the same forced policies: one tenant context at a time.
    for (const id of ['tenant_acme', 'tenant_beta']) {
      const seen = await owner.transaction(async (tx) => {
        await tx.query("SELECT set_config('app.tenant_id', $1, true)", [id]);
        const tenants = await tx.query<{ id: string; name: string }>(
          'SELECT id, name FROM tenants',
        );
        const settings = await tx.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM governance_settings',
        );
        return { tenants: tenants.rows, settings: settings.rows[0]?.n };
      });
      expect(seen.tenants.map((t) => t.id)).toEqual([id]);
      expect(seen.settings).toBe(GOVERNANCE_SECTIONS.length);
    }
  });

  it('the policy is what the tenant context satisfies: no context, or another tenant, is refused', async () => {
    const withoutContext = await failure(
      owner.transaction((tx) => tx.query(insertTenant('tenant_rogue'))),
    );
    expect(withoutContext).toMatchObject({ code: 'tenant_violation' });
    expect(getDatabaseErrorCode(withoutContext)).toBe('42501');

    const otherTenant = await failure(
      owner.transaction(async (tx) => {
        await tx.query("SELECT set_config('app.tenant_id', 'tenant_acme', true)");
        return tx.query(insertTenant('tenant_rogue'));
      }),
    );
    expect(otherTenant).toMatchObject({ code: 'tenant_violation' });
    expect(getDatabaseErrorCode(otherTenant)).toBe('42501');
    expect(await findMissingTenants(owner, ['tenant_rogue'])).toEqual(['tenant_rogue']);
  });

  it('is idempotent as the owner: a second run changes nothing', async () => {
    const read = async () => {
      const tenants = await db.query('SELECT * FROM tenants ORDER BY id');
      const settings = await db.query(
        'SELECT * FROM governance_settings ORDER BY tenant_id, section',
      );
      return { tenants: tenants.rows, settings: settings.rows };
    };
    await provisionTenants(owner, [{ id: 'tenant_acme' }]);
    const before = await read();
    const again = await provisionTenants(owner, [{ id: 'tenant_acme' }, { id: 'tenant_beta' }], {
      now: () => LATER,
    });
    expect(again).toEqual({ created: [], existing: ['tenant_acme', 'tenant_beta'] });
    expect(await read()).toEqual(before);
  });

  it.each(['caseguard_app', 'cg_nobody'])(
    'the role %s cannot provision a tenant: the database refuses and the error says which role to use',
    async (role) => {
      const error = await failure(provisionTenants(asRole(db, role), [{ id: 'tenant_gamma' }]));
      expect(error).toBeInstanceOf(ForbiddenError);
      expect((error as Error).message).toMatch(/run it as the role that owns the schema/);
      expect(getDatabaseErrorCode(error)).toBe('42501');
      expect(await findMissingTenants(owner, ['tenant_gamma'])).toEqual(['tenant_gamma']);
    },
  );

  it('the runtime role still cannot create a tenant, with or without a tenant context', async () => {
    const error = await failure(
      db.withTenant({ tenantId: 'tenant_new', actorId: 'system:test' }, (tx) =>
        tx.query(insertTenant('tenant_new')),
      ),
    );
    expect(error).toBeInstanceOf(ForbiddenError);
    expect(getDatabaseErrorCode(error)).toBe('42501');

    const visible = await db.transaction(async (tx) => {
      await tx.query('SET LOCAL ROLE caseguard_app');
      return (await tx.query('SELECT id FROM tenants')).rows;
    });
    expect(visible).toEqual([]);
  });

  it('the runtime role signs a user in to a provisioned tenant and sees nothing of the others', async () => {
    await provisionTenants(owner, [{ id: 'tenant_acme' }, { id: 'tenant_beta' }]);
    const repositories = createRepositories(db, {
      now: new TestClock().now,
      newId: createSequentialIdGenerator(),
    });
    const acme = repositories.forTenant({ tenantId: 'tenant_acme', actorId: 'system:test' });
    const beta = repositories.forTenant({ tenantId: 'tenant_beta', actorId: 'system:test' });

    const user = await acme.governance.upsertIdentityUser({
      userId: 'entra-object-9',
      displayName: 'Acme Admin (synthetic)',
      email: 'acme.admin@example.invalid',
      roles: ['administrator'],
      synthetic: true,
    });
    expect(user).toMatchObject({ tenantId: 'tenant_acme', status: 'active', version: 1 });
    expect(await beta.governance.listUsers()).toEqual([]);
    expect((await acme.governance.getTenant()).id).toBe('tenant_acme');
    expect((await acme.governance.getSettings()).model.updatedBy).toBe(PROVISIONING_ACTOR);

    const unprovisioned = repositories.forTenant({
      tenantId: 'tenant_unknown',
      actorId: 'system:test',
    });
    await expect(
      unprovisioned.governance.upsertIdentityUser({
        userId: 'entra-object-10',
        displayName: 'Nobody (synthetic)',
        email: null,
        roles: ['engineer'],
        synthetic: true,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('findMissingTenants sees the provisioned tenants as the owner', async () => {
    await provisionTenants(owner, [{ id: 'tenant_acme' }]);
    expect(await findMissingTenants(owner, ['tenant_acme', 'tenant_nope'])).toEqual([
      'tenant_nope',
    ]);
  });
});
