import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError } from '../src/errors';
import { TenantViolationError, getDatabaseErrorCode } from '../src/db/errors';
import {
  CONTOSO_SCOPE,
  FABRIKAM_SCOPE,
  TEST_DATABASE_STARTUP_TIMEOUT_MS,
  createTestRepositories,
  type TestHarness,
} from '../src/db/testing';
import {
  TENANT_A,
  TENANT_B,
  buildAuditInput,
  buildIngestInput,
  buildJob,
  buildSkill,
  buildSkillVersion,
  buildSnapshot,
} from './builders';

let h: TestHarness;

beforeAll(async () => {
  h = await createTestRepositories();
}, TEST_DATABASE_STARTUP_TIMEOUT_MS);
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.reset();
});

async function seedBothTenants() {
  const inputA = buildIngestInput({ tenantId: TENANT_A, caseId: 'case_alpha' });
  const inputB = buildIngestInput({
    tenantId: TENANT_B,
    caseId: 'case_alpha',
    reference: 'CG-9001',
  });
  await h.contoso().cases.ingest(inputA);
  await h.fabrikam().cases.ingest(inputB);
  await h.contoso().analysis.saveSnapshot(buildSnapshot(inputA));
  await h.fabrikam().analysis.saveSnapshot(buildSnapshot(inputB));
  return { inputA, inputB };
}

describe('[NFR-SEC-01] tenant isolation at the repository level', () => {
  it("lists, reads and counts only the calling tenant's rows", async () => {
    await seedBothTenants();
    const a = h.contoso();
    const b = h.fabrikam();

    expect((await a.cases.list({ limit: 50 })).items.map((c) => c.reference)).toEqual(['CG-1001']);
    expect((await b.cases.list({ limit: 50 })).items.map((c) => c.reference)).toEqual(['CG-9001']);
    // The same case id exists in both tenants without colliding.
    expect((await a.cases.get('case_alpha'))?.tenantId).toBe(TENANT_A);
    expect((await b.cases.get('case_alpha'))?.tenantId).toBe(TENANT_B);
    expect(await a.analysis.listHypotheses('case_alpha')).toHaveLength(2);
    expect((await a.governance.listUsers()).map((u) => u.id)).not.toContain('user_fabi_engineer');
    expect((await b.governance.getTenant()).id).toBe(TENANT_B);
  });

  it("cannot reach another tenant's data by id, even when the ids are guessed", async () => {
    const { inputA } = await seedBothTenants();
    const b = h.fabrikam();
    const claimId = inputA.case.id;
    expect(await b.cases.get('case_missing')).toBeNull();

    // Fabrikam has its own case_alpha: it must only ever see Fabrikam's artefacts.
    const claims = await b.analysis.listClaims('case_alpha', { limit: 50 });
    expect(claims.items.every((c) => c.tenantId === TENANT_B)).toBe(true);
    expect(claimId).toBe('case_alpha');

    // A tenant with no such case sees nothing at all.
    await h.reset();
    await h.contoso().cases.ingest(inputA);
    await h.contoso().analysis.saveSnapshot(buildSnapshot(inputA));
    expect(await b.cases.get('case_alpha')).toBeNull();
    expect(await b.cases.getAllEvents('case_alpha')).toEqual([]);
    expect((await b.analysis.listClaims('case_alpha', { limit: 50 })).items).toEqual([]);
    expect(await b.analysis.getQuality('case_alpha')).toBeNull();
    expect(await b.analysis.getTwin('case_alpha')).toBeNull();
  });

  it("cannot modify or erase another tenant's records", async () => {
    const inputA = buildIngestInput();
    await h.contoso().cases.ingest(inputA);
    const snapshot = buildSnapshot(inputA);
    await h.contoso().analysis.saveSnapshot(snapshot);
    const b = h.fabrikam();
    const claim = snapshot.claims[0];
    expect(claim).toBeDefined();

    expect(await b.cases.delete('case_alpha')).toBe(false);
    await expect(b.cases.setAnalysisState('case_alpha', 'failed')).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      b.analysis.reviewClaim('case_alpha', claim?.id ?? '', {
        reviewedCategory: 'confirmed_fact',
        reason: 'cross-tenant attempt',
        reviewedBy: 'user_fabi_engineer',
        reviewedAt: '2026-01-15T10:00:00.000Z',
        expectedVersion: 1,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(b.skills.update('skill_proxy', { name: 'hijacked' }, 1)).rejects.toBeInstanceOf(
      NotFoundError,
    );

    expect(await h.contoso().cases.get('case_alpha')).not.toBeNull();
    expect((await h.contoso().analysis.getClaim('case_alpha', claim?.id ?? ''))?.reviewState).toBe(
      'pending',
    );
  });

  it("refuses writes that carry another tenant's id (application-layer check)", async () => {
    const foreignSnapshot = buildSnapshot(buildIngestInput({ tenantId: TENANT_B }));
    await expect(h.contoso().analysis.saveSnapshot(foreignSnapshot)).rejects.toBeInstanceOf(
      TenantViolationError,
    );
    await expect(h.contoso().jobs.create(buildJob({ tenantId: TENANT_B }))).rejects.toBeInstanceOf(
      TenantViolationError,
    );
    await expect(
      h.contoso().skills.create({
        skill: buildSkill({ tenantId: TENANT_B }),
        version: buildSkillVersion({ tenantId: TENANT_B }),
      }),
    ).rejects.toBeInstanceOf(TenantViolationError);
  });

  it("keeps each tenant's audit chain separate and independently valid", async () => {
    const a = h.contoso();
    const b = h.fabrikam();
    await a.audit.append(buildAuditInput());
    await a.audit.append(buildAuditInput({ action: 'case.analyzed' }));
    await b.audit.append(buildAuditInput());
    expect((await a.audit.list({ limit: 10 })).items).toHaveLength(2);
    expect((await b.audit.list({ limit: 10 })).items).toHaveLength(1);
    expect((await a.audit.verify()).valid).toBe(true);
    expect((await b.audit.verify()).valid).toBe(true);
    expect((await b.audit.list({ limit: 10 })).items[0]?.sequence).toBe(1);
  });

  it('scopes jobs, idempotency keys and settings per tenant', async () => {
    await h.contoso().jobs.create(buildJob({ id: 'job_shared', idempotencyKey: 'key-1' }));
    await h
      .fabrikam()
      .jobs.create(buildJob({ id: 'job_shared', tenantId: TENANT_B, idempotencyKey: 'key-1' }));
    expect((await h.contoso().jobs.get('job_shared'))?.tenantId).toBe(TENANT_A);
    expect((await h.fabrikam().jobs.get('job_shared'))?.tenantId).toBe(TENANT_B);
    expect(await h.contoso().idempotency.begin('k', 'ingest', 'hash-a')).toEqual({ state: 'new' });
    // Same key and scope in the other tenant is a different reservation.
    expect(await h.fabrikam().idempotency.begin('k', 'ingest', 'hash-b')).toEqual({ state: 'new' });
    const settings = await h.contoso().governance.getSettings();
    await h.contoso().governance.updateSection(
      'retention',
      { ...settings.retention.value, caseDataDays: 30 },
      {
        expectedVersion: 1,
        changeNote: 'shorter retention for tests',
        by: 'user_alex_admin',
      },
    );
    expect((await h.fabrikam().governance.getSettings()).retention.value.caseDataDays).toBe(365);
  });
});

describe('[NFR-SEC-01] row-level security blocks cross-tenant access even when the filter is forgotten', () => {
  beforeEach(async () => {
    await seedBothTenants();
  });

  it("a raw SELECT without any tenant predicate only returns the session tenant's rows", async () => {
    const rows = await h.database.withTenant(CONTOSO_SCOPE, async (tx) => {
      const cases = await tx.query<{ tenant_id: string }>('SELECT tenant_id FROM cases');
      const events = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM case_events');
      const claims = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM claims');
      return { cases: cases.rows, events: events.rows[0]?.n, claims: claims.rows[0]?.n };
    });
    expect(rows.cases.map((r) => r.tenant_id)).toEqual([TENANT_A]);
    expect(rows.events).toBe(6);
    expect(rows.claims).toBe(3);

    const other = await h.database.withTenant(FABRIKAM_SCOPE, async (tx) =>
      (await tx.query<{ tenant_id: string }>('SELECT tenant_id FROM cases')).rows.map(
        (r) => r.tenant_id,
      ),
    );
    expect(other).toEqual([TENANT_B]);
  });

  it('naming the other tenant explicitly still returns nothing', async () => {
    const rows = await h.database.withTenant(CONTOSO_SCOPE, async (tx) => ({
      cases: (await tx.query(`SELECT * FROM cases WHERE tenant_id = '${TENANT_B}'`)).rows,
      users: (await tx.query(`SELECT * FROM users WHERE tenant_id = '${TENANT_B}'`)).rows,
      tenants: (await tx.query('SELECT id FROM tenants')).rows,
    }));
    expect(rows.cases).toEqual([]);
    expect(rows.users).toEqual([]);
    expect(rows.tenants).toEqual([{ id: TENANT_A }]);
  });

  it('a session with no tenant setting sees no rows at all', async () => {
    const counts = await h.database.transaction(async (tx) => {
      await tx.query('SET LOCAL ROLE caseguard_app');
      const cases = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM cases');
      const tenants = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM tenants');
      const audit = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_events');
      return [cases.rows[0]?.n, tenants.rows[0]?.n, audit.rows[0]?.n];
    });
    expect(counts).toEqual([0, 0, 0]);

    const emptySetting = await h.database.transaction(async (tx) => {
      await tx.query('SET LOCAL ROLE caseguard_app');
      await tx.query("SELECT set_config('app.tenant_id', '', true)");
      return (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM cases')).rows[0]?.n;
    });
    expect(emptySetting).toBe(0);
  });

  it('the tenant setting does not leak into the next transaction on the same connection', async () => {
    await h.database.withTenant(CONTOSO_SCOPE, async (tx) => {
      expect(
        (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM cases')).rows[0]?.n,
      ).toBe(1);
    });
    const after = await h.database.transaction(async (tx) => {
      await tx.query('SET LOCAL ROLE caseguard_app');
      return (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM cases')).rows[0]?.n;
    });
    expect(after).toBe(0);
  });

  it('a raw INSERT for another tenant is rejected by the row-level security policy', async () => {
    const attempt = h.database.withTenant(CONTOSO_SCOPE, (tx) =>
      tx.query(
        `INSERT INTO jobs (tenant_id, id, kind, status, created_at, created_by, cancellable, data)
         VALUES ('${TENANT_B}', 'job_smuggled', 'case_analysis', 'queued', now(), 'attacker', false, '{}'::jsonb)`,
      ),
    );
    await expect(attempt).rejects.toMatchObject({ code: 'tenant_violation' });
    const count = await h.database.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM jobs WHERE id = 'job_smuggled'",
    );
    expect(count.rows[0]?.n).toBe(0);
  });

  it("a raw UPDATE or DELETE cannot touch another tenant's rows", async () => {
    const result = await h.database.withTenant(CONTOSO_SCOPE, async (tx) => {
      const update = await tx.query(
        `UPDATE cases SET title = 'hijacked' WHERE tenant_id = '${TENANT_B}'`,
      );
      const del = await tx.query(`DELETE FROM cases WHERE tenant_id = '${TENANT_B}'`);
      const blanket = await tx.query(`UPDATE users SET display_name = 'x'`);
      return { updated: update.rowCount, deleted: del.rowCount, blanketUsers: blanket.rowCount };
    });
    expect(result.updated).toBe(0);
    expect(result.deleted).toBe(0);
    expect(result.blanketUsers).toBe(5); // Contoso's five users, never Fabrikam's
    const fabrikam = await h.fabrikam().cases.get('case_alpha');
    expect(fabrikam?.title).not.toBe('hijacked');
    expect((await h.fabrikam().governance.getUser('user_fabi_engineer'))?.displayName).toBe(
      'Fabi Engineer (synthetic)',
    );
  });

  it('rewriting tenant_id to another tenant is rejected', async () => {
    const attempt = h.database.withTenant(CONTOSO_SCOPE, (tx) =>
      tx.query(`UPDATE users SET tenant_id = '${TENANT_B}' WHERE id = 'user_ava_engineer'`),
    );
    await expect(attempt).rejects.toMatchObject({ code: 'tenant_violation' });
  });

  it("composite foreign keys stop a child row from pointing at another tenant's parent", async () => {
    // A case that only exists in Contoso: even the owner (who bypasses RLS) cannot attach a
    // Fabrikam event to it, because the foreign key includes tenant_id.
    await h
      .contoso()
      .cases.ingest(buildIngestInput({ caseId: 'case_only_contoso', receivedSeed: 'only-a' }));
    const attempt = h.database.query(
      `INSERT INTO case_events (tenant_id, case_id, id, source_id, sequence, event_ts, participant_id,
         participant_role, type, created_at, updated_at, created_by, data)
       VALUES ('${TENANT_B}', 'case_only_contoso', 'evt_cross', 'src_case_only_contoso', 99, now(), 'p_customer',
         'customer_admin', 'customer_email', now(), now(), 'x', '{}'::jsonb)`,
    );
    await expect(attempt).rejects.toMatchObject({ code: 'conflict' });
  });

  it('the application role is a plain NOLOGIN role without RLS bypass, and every tenant table forces RLS', async () => {
    const role = await h.database.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcanlogin: boolean;
    }>("SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'caseguard_app'");
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, rolcanlogin: false });

    const tables = await h.database.query<{
      relname: string;
      rls: boolean;
      forced: boolean;
      policies: number;
    }>(
      `SELECT c.relname AS relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
              (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relkind = 'r' AND c.relname <> 'schema_migrations'`,
    );
    // 37 tenant-owned tables today; a new table without RLS makes the next assertion fail.
    expect(tables.rows.length).toBeGreaterThanOrEqual(37);
    const unsafe = tables.rows
      .filter((t) => !t.rls || !t.forced || t.policies < 1)
      .map((t) => t.relname);
    expect(unsafe).toEqual([]);
  });

  it('the application role cannot read migration bookkeeping', async () => {
    const attempt = h.database.withTenant(CONTOSO_SCOPE, (tx) =>
      tx.query('SELECT * FROM schema_migrations'),
    );
    await expect(attempt).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('a failed statement inside withTenant never leaks the role or tenant to later work', async () => {
    await expect(
      h.database.withTenant(CONTOSO_SCOPE, (tx) => tx.query('SELECT * FROM no_such_table')),
    ).rejects.toBeDefined();
    const sessionUser = await h.database.query<{ current_user: string }>('SELECT current_user');
    expect(sessionUser.rows[0]?.current_user).not.toBe('caseguard_app');
    expect(getDatabaseErrorCode(new Error('plain'))).toBeNull();
  });
});
