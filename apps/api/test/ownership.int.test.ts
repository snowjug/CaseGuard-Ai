import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../src/db/client';
import { migrate } from '../src/db/migrate';
import { createRepositories } from '../src/db/repositories';
import { seedFoundation } from '../src/db/seed';
import { createSequentialIdGenerator, createTestDatabase, TestClock } from '../src/db/testing';
import type { Database } from '../src/db/repositories/types';
import { buildIngestInput, buildSnapshot } from './builders';

const open: Database[] = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()?.close();
});

// Each test starts its own PGlite instance, which takes seconds and slows further when the
// whole suite runs in parallel.
const SLOW = { timeout: 120_000 };

describe('production-like ownership: a non-superuser owns the schema', () => {
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

  it(
    '[NFR-SEC-01] migrates, seeds and runs the repositories; row-level security still binds the owner',
    SLOW,
    async () => {
      const db = await createDatabase({ url: 'pglite://memory' });
      open.push(db);
      await db.query('CREATE ROLE cg_owner NOLOGIN CREATEROLE');
      await db.query('GRANT CREATE, USAGE ON SCHEMA public TO cg_owner');
      const owner = asRole(db, 'cg_owner');

      expect((await migrate(owner)).appliedNow).toHaveLength(9);
      await seedFoundation(owner);

      const tableOwner = await db.query<{ owner: string }>(
        "SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE relname = 'cases'",
      );
      expect(tableOwner.rows[0]?.owner).toBe('cg_owner');

      // The owner is subject to forced RLS: without a tenant it sees nothing, with one it sees its rows.
      const unscoped = await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM users');
      expect(unscoped.rows[0]?.n).toBe(0);
      const scoped = await owner.transaction(async (tx) => {
        await tx.query("SELECT set_config('app.tenant_id', 'tenant_contoso_support', true)");
        return (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM users')).rows[0]?.n;
      });
      expect(scoped).toBe(5);

      // The whole repository surface works through caseguard_app, including the erasure cascade.
      const repos = createRepositories(db, {
        now: new TestClock().now,
        newId: createSequentialIdGenerator(),
      }).forTenant({
        tenantId: 'tenant_contoso_support',
        actorId: 'user_ava_engineer',
      });
      const input = buildIngestInput({ withResolution: true });
      await repos.cases.ingest(input);
      await repos.analysis.saveSnapshot(buildSnapshot(input));
      expect((await repos.cases.list({ limit: 10 })).items).toHaveLength(1);

      // Migration 0007 as a non-superuser owner: the generated search vectors are computed while the
      // application role inserts, full-text search runs as that role, and a just-in-time sign-in can
      // insert the user (the grant added by the migration).
      expect((await repos.search.query({ text: 'sign-in', limit: 5 })).length).toBeGreaterThan(0);
      const signedIn = await repos.governance.upsertIdentityUser({
        userId: 'entra-object-1',
        displayName: 'Entra User (synthetic)',
        email: null,
        roles: ['engineer'],
        synthetic: true,
      });
      expect(signedIn).toMatchObject({ status: 'active', version: 1, email: '' });

      expect(await repos.cases.delete('case_alpha')).toBe(true);
      expect((await repos.cases.list({ limit: 10 })).items).toHaveLength(0);
      const events = await owner.transaction(async (tx) => {
        await tx.query("SELECT set_config('app.tenant_id', 'tenant_contoso_support', true)");
        return (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM case_events')).rows[0]
          ?.n;
      });
      expect(events).toBe(0);
    },
  );
});

describe('test database helper', () => {
  it('createTestDatabase returns a migrated, seeded database', SLOW, async () => {
    const db = await createTestDatabase();
    open.push(db);
    const tenants = await db.query<{ id: string }>('SELECT id FROM tenants ORDER BY id');
    expect(tenants.rows.map((r) => r.id)).toEqual([
      'tenant_contoso_support',
      'tenant_fabrikam_lab',
    ]);
  });
});
