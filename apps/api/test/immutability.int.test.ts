import type { Database, SqlExecutor } from '../src/db/repositories/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDatabaseErrorCode } from '../src/db/errors';
import { createRepositories } from '../src/db/repositories';
import {
  CONTOSO_SCOPE,
  TEST_DATABASE_STARTUP_TIMEOUT_MS,
  createSequentialIdGenerator,
  createTestRepositories,
  type TestHarness,
} from '../src/db/testing';
import {
  TENANT_B,
  buildAuditInput,
  buildExecution,
  buildIngestInput,
  buildJob,
  buildReviewDecision,
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

async function count(table: string, where = 'TRUE'): Promise<number> {
  const result = await h.database.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
  );
  return result.rows[0]?.n ?? -1;
}

async function ingestWithAudit() {
  const input = buildIngestInput({ withResolution: true });
  await h.contoso().cases.ingest(input);
  await h.contoso().audit.append(buildAuditInput());
  return input;
}

const IMMUTABLE_UPDATES: [string, string][] = [
  ['case_sources', "UPDATE case_sources SET file_name = 'tampered.json'"],
  ['case_events', "UPDATE case_events SET created_by = 'tampered'"],
  ['case_resolutions', "UPDATE case_resolutions SET created_by = 'tampered'"],
  ['audit_events', "UPDATE audit_events SET action = 'tampered'"],
];
const IMMUTABLE_DELETES: [string, string][] = [
  ['case_sources', 'DELETE FROM case_sources'],
  ['case_events', 'DELETE FROM case_events'],
  ['case_resolutions', 'DELETE FROM case_resolutions'],
  ['audit_events', 'DELETE FROM audit_events'],
];

describe('[FR-ING-07] source, event, resolution and audit records are immutable', () => {
  it.each(IMMUTABLE_UPDATES)(
    'the %s trigger rejects UPDATE even for the table owner',
    async (table, sql) => {
      await ingestWithAudit();
      const before = await count(table);
      const error = await h.database.query(sql).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toMatchObject({ code: 'conflict', details: { reason: 'immutable' } });
      expect(getDatabaseErrorCode(error)).toBe('CG001');
      expect(await count(table)).toBe(before);
    },
  );

  it.each(IMMUTABLE_DELETES)(
    'the %s trigger rejects DELETE even for the table owner',
    async (table, sql) => {
      await ingestWithAudit();
      const before = await count(table);
      const error = await h.database.query(sql).then(
        () => null,
        (e: unknown) => e,
      );
      expect(getDatabaseErrorCode(error)).toBe('CG001');
      expect(await count(table)).toBe(before);
    },
  );

  it.each([...IMMUTABLE_UPDATES, ...IMMUTABLE_DELETES])(
    'the application role cannot modify or delete %s rows either',
    async (table, sql) => {
      await ingestWithAudit();
      const before = await count(table);
      await expect(
        h.database.withTenant(CONTOSO_SCOPE, (tx) => tx.query(sql)),
      ).rejects.toBeDefined();
      expect(await count(table)).toBe(before);
    },
  );

  it('the immutability triggers are installed, and the audit trigger fires even when replication triggers are off', async () => {
    // pg_trigger is database-wide. On a real server every test file migrates its own schema in the
    // same database, so the same four names come back once per schema in use: look at this one.
    const triggers = await h.database.query<{
      table_name: string;
      tgname: string;
      tgenabled: string;
    }>(
      `SELECT c.relname AS table_name, t.tgname, t.tgenabled
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE NOT t.tgisinternal
          AND n.nspname = current_schema()
          AND t.tgname IN ('case_sources_immutable', 'case_events_immutable',
                           'case_resolutions_immutable', 'audit_events_immutable')
        ORDER BY c.relname, t.tgname`,
    );
    expect(triggers.rows.map((t) => [t.table_name, t.tgname])).toEqual([
      ['audit_events', 'audit_events_immutable'],
      ['case_events', 'case_events_immutable'],
      ['case_resolutions', 'case_resolutions_immutable'],
      ['case_sources', 'case_sources_immutable'],
    ]);
    expect(triggers.rows.find((t) => t.tgname === 'audit_events_immutable')?.tgenabled).toBe('A');

    await h.contoso().audit.append(buildAuditInput());
    await expect(
      h.database.transaction(async (tx) => {
        await tx.query("SET LOCAL session_replication_role = 'replica'");
        await tx.query("UPDATE audit_events SET action = 'tampered'");
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('a case cannot be deleted through the cascade without the erasure setting', async () => {
    await ingestWithAudit();
    const error = await h.database.query("DELETE FROM cases WHERE id = 'case_alpha'").then(
      () => null,
      (e: unknown) => e,
    );
    expect(getDatabaseErrorCode(error)).toBe('CG001');
    expect(await count('cases')).toBe(1);
    expect(await count('case_events')).toBe(6);
  });

  it('the erasure setting allows deleting but never updating, and never deletes audit events', async () => {
    await ingestWithAudit();
    await expect(
      h.database.transaction(async (tx) => {
        await tx.query("SELECT set_config('app.allow_erasure', 'on', true)");
        await tx.query("UPDATE case_events SET created_by = 'tampered'");
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      h.database.transaction(async (tx) => {
        await tx.query("SELECT set_config('app.allow_erasure', 'on', true)");
        await tx.query('DELETE FROM audit_events');
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await count('audit_events')).toBe(1);
    expect(await count('case_events')).toBe(6);
  });
});

describe('[FR-ING-07] the administrator erasure path', () => {
  it('CaseRepository.delete removes the case and every derived row but keeps the audit trail', async () => {
    const input = await ingestWithAudit();
    const repos = h.contoso();
    await repos.analysis.saveSnapshot(buildSnapshot(input));
    await repos.jobs.create(buildJob({ caseId: 'case_alpha' }));
    await repos.reviews.record(buildReviewDecision());
    await repos.audit.append(buildAuditInput({ action: 'case.analyzed' }));

    expect(await repos.cases.delete('case_alpha')).toBe(true);

    for (const table of [
      'cases',
      'case_sources',
      'case_participants',
      'case_events',
      'case_resolutions',
      'analysis_runs',
      'digital_twins',
      'evidence',
      'hypotheses',
      'hypothesis_evidence_links',
      'claims',
      'missing_evidence',
      'diagnostic_actions',
      'decision_forks',
      'quality_assessments',
      'quality_dimensions',
      'metric_estimates',
      'case_warnings',
      'coaching_reports',
      'model_executions',
      'token_usage',
      'jobs',
      'review_decisions',
    ]) {
      expect(await count(table), table).toBe(0);
    }
    expect(await count('audit_events')).toBe(2);
    expect((await repos.audit.verify()).valid).toBe(true);
    expect(await repos.cases.delete('case_alpha')).toBe(false);
  });

  it("only erases the requested case and the calling tenant's data", async () => {
    await h.contoso().cases.ingest(buildIngestInput({ caseId: 'case_keep', receivedSeed: 'keep' }));
    await h.contoso().cases.ingest(buildIngestInput({ caseId: 'case_drop', receivedSeed: 'drop' }));
    await h
      .fabrikam()
      .cases.ingest(
        buildIngestInput({ tenantId: TENANT_B, caseId: 'case_drop', receivedSeed: 'drop-b' }),
      );

    expect(await h.contoso().cases.delete('case_drop')).toBe(true);
    expect((await h.contoso().cases.list({ limit: 10 })).items.map((c) => c.id)).toEqual([
      'case_keep',
    ]);
    expect(await h.fabrikam().cases.get('case_drop')).not.toBeNull();
    expect(await count('case_events', "case_id = 'case_keep'")).toBe(6);
  });

  it('switches the erasure setting off again so later statements in the same transaction cannot erase', async () => {
    await h.contoso().cases.ingest(buildIngestInput({ caseId: 'case_one', receivedSeed: '1' }));
    await h.contoso().cases.ingest(buildIngestInput({ caseId: 'case_two', receivedSeed: '2' }));
    const holder: { tx: SqlExecutor | null } = { tx: null };
    const spy: Database = {
      kind: h.database.kind,
      query: (text, params) => h.database.query(text, params),
      transaction: (fn) => h.database.transaction(fn),
      withTenant: (scope, fn) =>
        h.database.withTenant(scope, (tx) => {
          holder.tx = tx;
          return fn(tx);
        }),
      ping: () => h.database.ping(),
      close: () => h.database.close(),
    };
    const repos = createRepositories(spy, {
      now: h.clock.now,
      newId: createSequentialIdGenerator(5000),
    }).forTenant(CONTOSO_SCOPE);
    const flag = await repos.transaction(async (bound) => {
      await bound.cases.delete('case_one');
      const state = await holder.tx?.query<{ v: string }>(
        "SELECT current_setting('app.allow_erasure', true) AS v",
      );
      return state?.rows[0]?.v;
    });
    expect(flag).toBe('off');
    expect(await count('cases')).toBe(1);
  });
});

describe('demo reset keeps identity, settings and audit', () => {
  it('[FR-ING-07] resetTenantData deletes case-derived data only', async () => {
    const input = buildIngestInput();
    const a = h.contoso();
    await a.cases.ingest(input);
    await a.analysis.saveSnapshot(buildSnapshot(input));
    await a.skills.create({ skill: buildSkill(), version: buildSkillVersion() });
    await a.jobs.create(buildJob());
    await a.telemetry.saveExecutions([
      buildExecution({ id: 'exe_loose', caseId: null, analysisRunId: null }),
    ]);
    await a.reviews.record(
      buildReviewDecision({ caseId: null, targetType: 'skill', targetId: 'skill_proxy' }),
    );
    await a.idempotency.begin('key-1', 'ingest', 'hash-1');
    await a.demo.setSeedMarker({ seededAt: '2026-01-15T09:00:00.000Z', profile: 'default' });
    await a.audit.append(buildAuditInput());
    await a.governance.getSettings();

    const other = buildIngestInput({ tenantId: TENANT_B, caseId: 'case_b' });
    await h.fabrikam().cases.ingest(other);
    await h.fabrikam().audit.append(buildAuditInput());

    await a.demo.resetTenantData();

    const tenant = "tenant_id = 'tenant_contoso_support'";
    for (const table of [
      'cases',
      'case_events',
      'case_sources',
      'skills',
      'skill_versions',
      'jobs',
      'model_executions',
      'token_usage',
      'review_decisions',
      'idempotency_keys',
      'demo_state',
      'claims',
      'evidence',
      'skill_matches',
    ]) {
      expect(await count(table, tenant), table).toBe(0);
    }
    expect(await count('tenants')).toBe(2);
    expect(await count('users', tenant)).toBe(5);
    expect(await count('governance_settings', tenant)).toBe(7);
    expect(await count('audit_events', tenant)).toBe(1);
    expect(await a.demo.getSeedMarker()).toBeNull();

    // The other tenant is untouched.
    expect(await h.fabrikam().cases.get('case_b')).not.toBeNull();
    expect(await count('audit_events', "tenant_id = 'tenant_fabrikam_lab'")).toBe(1);
    expect((await a.audit.verify()).valid).toBe(true);
  });

  it('can be repeated and re-seeded', async () => {
    const a = h.contoso();
    await a.demo.resetTenantData();
    await a.demo.setSeedMarker({ seededAt: '2026-01-15T09:00:00.000Z', profile: 'default' });
    expect(await a.demo.getSeedMarker()).toEqual({
      seededAt: '2026-01-15T09:00:00.000Z',
      profile: 'default',
    });
    await a.demo.setSeedMarker({ seededAt: '2026-01-16T09:00:00.000Z', profile: 'portfolio' });
    expect((await a.demo.getSeedMarker())?.profile).toBe('portfolio');
    await a.demo.resetTenantData();
    await a.demo.resetTenantData();
    expect(await a.demo.getSeedMarker()).toBeNull();
  });
});
