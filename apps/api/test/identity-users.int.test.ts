import { UserSchema, type Role } from '@caseguard/schemas';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ValidationFailedError, VersionConflictError } from '../src/errors';
import type { IdentityUserInput } from '../src/db/repositories/types';
import {
  CONTOSO_SCOPE,
  FABRIKAM_SCOPE,
  TEST_DATABASE_STARTUP_TIMEOUT_MS,
  createTestRepositories,
  type TestHarness,
} from '../src/db/testing';
import { TENANT_A, TENANT_B } from './builders';

const OBJECT_ID = '6c7a0e2b-1111-4222-8333-444455556666';
const START = '2026-01-15T09:00:00.000Z';

let h: TestHarness;

beforeAll(async () => {
  h = await createTestRepositories();
}, TEST_DATABASE_STARTUP_TIMEOUT_MS);
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.reset();
  h.clock.set(START);
});

const profile = (overrides: Partial<IdentityUserInput> = {}): IdentityUserInput => ({
  userId: OBJECT_ID,
  displayName: 'Nora Entra (synthetic)',
  email: 'nora.entra@contoso-synthetic.invalid',
  roles: ['engineer'],
  synthetic: true,
  ...overrides,
});

const upsert = (input: IdentityUserInput, tenant: 'contoso' | 'fabrikam' = 'contoso') =>
  h[tenant]().governance.upsertIdentityUser(input);

interface StoredRow {
  display_name: string;
  email: string;
  roles: string[];
  status: string;
  synthetic: boolean;
  created_at: string;
  updated_at: string;
  created_by: string;
  version: number;
  data: unknown;
}

/** The row as the owner sees it (bypassing RLS), to compare the relational columns with `data`. */
async function stored(userId = OBJECT_ID, tenantId = TENANT_A): Promise<StoredRow | undefined> {
  const result = await h.database.query<StoredRow>(
    `SELECT display_name, email, roles, status, synthetic, created_at, updated_at, created_by, version, data
       FROM users WHERE tenant_id = $1 AND id = $2`,
    [tenantId, userId],
  );
  return result.rows[0];
}

/** The row's transaction id: it changes whenever the row is written, even to the same values. */
async function writeStamp(userId = OBJECT_ID, tenantId = TENANT_A): Promise<string | undefined> {
  const result = await h.database.query<{ stamp: string }>(
    'SELECT xmin::text AS stamp FROM users WHERE tenant_id = $1 AND id = $2',
    [tenantId, userId],
  );
  return result.rows[0]?.stamp;
}

async function disable(userId = OBJECT_ID, tenantId = TENANT_A): Promise<void> {
  await h.database.query(
    `UPDATE users SET status = 'disabled', data = jsonb_set(data, '{status}', '"disabled"')
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, userId],
  );
}

describe('[NFR-SEC-02] Entra just-in-time user sync: insert', () => {
  it('creates an absent user as active, version 1, and reads it back everywhere', async () => {
    const repos = h.contoso();
    const user = await repos.governance.upsertIdentityUser(profile());

    expect(user).toEqual({
      id: OBJECT_ID,
      tenantId: TENANT_A,
      displayName: 'Nora Entra (synthetic)',
      email: 'nora.entra@contoso-synthetic.invalid',
      roles: ['engineer'],
      status: 'active',
      synthetic: true,
      createdAt: START,
      updatedAt: START,
      version: 1,
    });
    expect(UserSchema.safeParse(user).success).toBe(true);
    expect(await repos.governance.getUser(OBJECT_ID)).toEqual(user);
    expect((await repos.governance.listUsers()).map((u) => u.id)).toContain(OBJECT_ID);

    const row = await stored();
    expect(row).toMatchObject({
      display_name: 'Nora Entra (synthetic)',
      email: 'nora.entra@contoso-synthetic.invalid',
      roles: ['engineer'],
      status: 'active',
      synthetic: true,
      created_at: START,
      updated_at: START,
      created_by: CONTOSO_SCOPE.actorId,
      version: 1,
    });
    expect(row?.data).toEqual(user);
  });

  it('stores roles once each, in the canonical order, whatever order the token lists them in', async () => {
    const repos = h.contoso();
    const first = await repos.governance.upsertIdentityUser(
      profile({ roles: ['manager', 'engineer', 'manager', 'reviewer'] }),
    );
    expect(first.roles).toEqual(['engineer', 'reviewer', 'manager']);
    expect((await stored())?.roles).toEqual(['engineer', 'reviewer', 'manager']);

    h.clock.advance(1000);
    expect(
      await repos.governance.upsertIdentityUser(
        profile({ roles: ['reviewer', 'manager', 'engineer'] }),
      ),
    ).toEqual(first);
  });

  it('an absent e-mail is stored as an empty string, and such users do not collide', async () => {
    const a = await upsert(profile({ userId: 'user-without-mail-1', email: null }));
    const b = await upsert(profile({ userId: 'user-without-mail-2', email: null }));
    expect([a.email, b.email]).toEqual(['', '']);
    expect(UserSchema.safeParse(a).success).toBe(true);
    expect((await stored('user-without-mail-2'))?.email).toBe('');
  });

  it('two accounts may share an e-mail address (Entra does not guarantee it is unique)', async () => {
    const first = await upsert(profile({ userId: 'user-shared-1', email: 'jane@contoso.example' }));
    const second = await upsert(
      profile({ userId: 'user-shared-2', email: 'Jane@Contoso.example' }),
    );
    expect(first.email).toBe('jane@contoso.example');
    expect(second.email).toBe('Jane@Contoso.example');
    const count = await h.database.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM users WHERE tenant_id = $1 AND lower(email) = 'jane@contoso.example'",
      [TENANT_A],
    );
    expect(count.rows[0]?.n).toBe(2);
  });

  it('cleans the display name and falls back when it is blank, instead of failing a sign-in', async () => {
    const messy = await upsert(
      profile({ userId: 'user-messy', displayName: 'Nora\n\t Entra\u0000X ' }),
    );
    expect(messy.displayName).toBe('Nora Entra X');

    const blank = await upsert(profile({ userId: 'user-blank', displayName: '  \n ' }));
    expect(blank.displayName).toBe('nora.entra@contoso-synthetic.invalid');
    const blankNoMail = await upsert(
      profile({ userId: 'user-blank-nomail', displayName: '', email: null }),
    );
    expect(blankNoMail.displayName).toBe('user-blank-nomail');

    const long = await upsert(profile({ userId: 'user-long', displayName: 'N'.repeat(300) }));
    expect(long.displayName).toHaveLength(120);
    const astral = await upsert(
      profile({ userId: 'user-astral', displayName: '\u{1D514}'.repeat(130) }),
    );
    expect(Array.from(astral.displayName)).toHaveLength(120);
    expect(UserSchema.safeParse(astral).success).toBe(true);
  });
});

describe('[NFR-SEC-02] Entra just-in-time user sync: update', () => {
  it('takes display name, e-mail and roles from the token and bumps updatedAt and version once', async () => {
    const created = await upsert(profile());
    h.clock.advance(60_000);
    const changed = await upsert(
      profile({
        displayName: 'Nora E. (synthetic)',
        email: 'nora@contoso-synthetic.invalid',
        roles: ['reviewer', 'engineer'],
      }),
    );

    expect(changed).toEqual({
      ...created,
      displayName: 'Nora E. (synthetic)',
      email: 'nora@contoso-synthetic.invalid',
      roles: ['engineer', 'reviewer'],
      updatedAt: '2026-01-15T09:01:00.000Z',
      version: 2,
    });
    const row = await stored();
    expect(row).toMatchObject({
      display_name: 'Nora E. (synthetic)',
      email: 'nora@contoso-synthetic.invalid',
      roles: ['engineer', 'reviewer'],
      created_at: START,
      updated_at: '2026-01-15T09:01:00.000Z',
      created_by: CONTOSO_SCOPE.actorId,
      version: 2,
    });
    expect(row?.data).toEqual(changed);
  });

  it('any single changed field is enough for exactly one new version', async () => {
    await upsert(profile());
    const steps: [Partial<IdentityUserInput>, number][] = [
      [{ displayName: 'Only the name changed' }, 2],
      [{ displayName: 'Only the name changed', email: 'only.mail@contoso.example' }, 3],
      [
        {
          displayName: 'Only the name changed',
          email: 'only.mail@contoso.example',
          roles: ['manager'],
        },
        4,
      ],
    ];
    for (const [overrides, version] of steps) {
      h.clock.advance(1000);
      expect((await upsert(profile(overrides))).version).toBe(version);
    }
  });

  it('is idempotent: an unchanged profile writes nothing, however often it signs in', async () => {
    const created = await upsert(profile());
    const before = await writeStamp();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      h.clock.advance(5000);
      expect(await upsert(profile())).toEqual(created);
    }
    expect(await writeStamp()).toBe(before);
    expect(await stored()).toMatchObject({ version: 1, updated_at: START });
  });

  it('[NFR-SEC-02] never changes status: a disabled user stays disabled while the profile is refreshed', async () => {
    await upsert(profile());
    await disable();
    h.clock.advance(1000);

    const synced = await upsert(profile({ displayName: 'Nora (promoted)', roles: ['manager'] }));
    expect(synced).toMatchObject({
      status: 'disabled',
      displayName: 'Nora (promoted)',
      roles: ['manager'],
      version: 2,
    });
    expect((await stored())?.status).toBe('disabled');
    expect((await h.contoso().governance.getUser(OBJECT_ID))?.status).toBe('disabled');

    // An unchanged profile returns the stored (disabled) user and writes nothing.
    const before = await writeStamp();
    expect(await upsert(profile({ displayName: 'Nora (promoted)', roles: ['manager'] }))).toEqual(
      synced,
    );
    expect(await writeStamp()).toBe(before);
  });

  it('keeps createdAt, status and the synthetic flag of the stored user', async () => {
    const created = await upsert(profile({ synthetic: true }));
    h.clock.advance(5000);
    const next = await upsert(profile({ synthetic: false, displayName: 'Changed' }));
    expect(next).toMatchObject({
      createdAt: created.createdAt,
      status: 'active',
      synthetic: true,
      version: 2,
    });
  });

  it('a token without an e-mail does not erase the stored address, but an explicit empty one does', async () => {
    await upsert(profile({ email: 'keep@contoso.example' }));
    const before = await writeStamp();
    h.clock.advance(1000);
    const kept = await upsert(profile({ email: null }));
    expect(kept).toMatchObject({ email: 'keep@contoso.example', version: 1 });
    expect(await writeStamp()).toBe(before);

    const cleared = await upsert(profile({ email: '' }));
    expect(cleared).toMatchObject({ email: '', version: 2 });
  });

  it('works with the rest of the user API: token roles win, and optimistic locking still holds', async () => {
    const repos = h.contoso();
    await upsert(profile());
    const demoted = await repos.governance.updateUserRoles(OBJECT_ID, ['reviewer'], 1);
    expect(demoted.version).toBe(2);

    const refreshed = await upsert(profile({ roles: ['engineer'] }));
    expect(refreshed).toMatchObject({ roles: ['engineer'], version: 3 });
    await expect(
      repos.governance.updateUserRoles(OBJECT_ID, ['manager'], 2),
    ).rejects.toBeInstanceOf(VersionConflictError);
  });
});

describe('[NFR-SEC-02] Entra just-in-time user sync: input and side effects', () => {
  it.each<[string, Partial<IdentityUserInput>]>([
    ['no roles', { roles: [] }],
    ['an unknown role', { roles: ['superuser' as Role] }],
    ['an empty user id', { userId: '' }],
    ['a malformed user id', { userId: 'has spaces' }],
    ['an e-mail over 200 characters', { email: `${'x'.repeat(201)}@contoso.example` }],
  ])('rejects %s and persists nothing', async (_label, overrides) => {
    await expect(upsert(profile(overrides))).rejects.toBeInstanceOf(ValidationFailedError);
    expect(await stored(overrides.userId ?? OBJECT_ID)).toBeUndefined();
  });

  it('cannot add users to a tenant that was never provisioned: the insert fails cleanly', async () => {
    // Tenants are created out of band (the application role may only read them), so the foreign key
    // rejects a user for an unknown tenant instead of inventing the tenant.
    const stranger = h.repositories.forTenant({
      tenantId: 'tenant_not_provisioned',
      actorId: 'system:auth',
    });
    await expect(stranger.governance.upsertIdentityUser(profile())).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(await stored(OBJECT_ID, 'tenant_not_provisioned')).toBeUndefined();
  });

  it('writes no audit rows (the caller audits)', async () => {
    const count = () =>
      h.database.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_events');
    const before = (await count()).rows[0]?.n;
    await upsert(profile());
    await upsert(profile({ roles: ['manager'] }));
    expect((await count()).rows[0]?.n).toBe(before);
  });

  it('takes part in a surrounding transaction and rolls back with it', async () => {
    await expect(
      h.contoso().transaction(async (repos) => {
        await repos.governance.upsertIdentityUser(profile());
        expect((await repos.governance.getUser(OBJECT_ID))?.version).toBe(1);
        throw new Error('abort the unit of work');
      }),
    ).rejects.toThrow('abort the unit of work');
    expect(await stored()).toBeUndefined();

    const committed = await h
      .contoso()
      .transaction((repos) => repos.governance.upsertIdentityUser(profile()));
    expect(committed.version).toBe(1);
  });

  it('simultaneous first sign-ins of one user create exactly one row and none of them fails', async () => {
    const results = await Promise.all([
      upsert(profile()),
      upsert(profile()),
      upsert(profile()),
      upsert(profile({ roles: ['manager'] })),
    ]);
    expect(results.every((user) => user.id === OBJECT_ID)).toBe(true);
    const count = await h.database.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM users WHERE tenant_id = $1 AND id = $2',
      [TENANT_A, OBJECT_ID],
    );
    expect(count.rows[0]?.n).toBe(1);
    expect((await stored())?.version).toBeGreaterThanOrEqual(1);
  });
});

describe('[NFR-SEC-01] Entra just-in-time user sync: tenant isolation', () => {
  it('the same user id in two tenants is two independent users', async () => {
    const contoso = await upsert(profile({ roles: ['engineer'] }), 'contoso');
    const fabrikam = await upsert(profile({ roles: ['administrator'] }), 'fabrikam');
    expect(contoso).toMatchObject({ tenantId: TENANT_A, roles: ['engineer'], version: 1 });
    expect(fabrikam).toMatchObject({ tenantId: TENANT_B, roles: ['administrator'], version: 1 });

    h.clock.advance(1000);
    await upsert(profile({ roles: ['manager'] }), 'contoso');
    expect(await h.fabrikam().governance.getUser(OBJECT_ID)).toEqual(fabrikam);
    expect((await stored(OBJECT_ID, TENANT_B))?.version).toBe(1);
  });

  it('a tenant never sees or changes the other tenant users through it', async () => {
    await upsert(profile({ userId: 'only-in-contoso' }), 'contoso');
    expect(await h.fabrikam().governance.getUser('only-in-contoso')).toBeNull();
    expect((await h.fabrikam().governance.listUsers()).map((u) => u.id)).not.toContain(
      'only-in-contoso',
    );

    // Even raw SQL as the application role cannot reach it or plant a user in the other tenant.
    const visible = await h.database.withTenant(FABRIKAM_SCOPE, async (tx) => ({
      select: (await tx.query("SELECT id FROM users WHERE id = 'only-in-contoso'")).rowCount,
      update: (
        await tx.query(
          "UPDATE users SET roles = ARRAY['administrator'] WHERE id = 'only-in-contoso'",
        )
      ).rowCount,
    }));
    expect(visible).toEqual({ select: 0, update: 0 });
    expect((await stored('only-in-contoso'))?.roles).toEqual(['engineer']);

    const plant = h.database.withTenant(CONTOSO_SCOPE, (tx) =>
      tx.query(
        `INSERT INTO users (tenant_id, id, display_name, email, roles, status, synthetic, created_at,
           updated_at, created_by, version, data)
         VALUES ('${TENANT_B}', 'planted', 'Planted', '', ARRAY['administrator'], 'active', true, now(),
           now(), 'attacker', 1, '{}'::jsonb)`,
      ),
    );
    await expect(plant).rejects.toMatchObject({ code: 'tenant_violation' });
    expect(await stored('planted', TENANT_B)).toBeUndefined();
  });
});
