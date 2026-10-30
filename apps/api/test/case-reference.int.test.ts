import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SanitizedDatabaseError, getDatabaseErrorCode } from '../src/db/errors';
import { createRepositories } from '../src/db/repositories';
import type { Database, TenantRepositories, TenantScope } from '../src/db/repositories/types';
import {
  CONTOSO_SCOPE,
  FABRIKAM_SCOPE,
  TEST_DATABASE_STARTUP_TIMEOUT_MS,
  createTestRepositories,
  type TestHarness,
} from '../src/db/testing';
import { ConflictError, ValidationFailedError } from '../src/errors';
import { TENANT_A, TENANT_B, buildAuditInput, buildIngestInput } from './builders';

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

/** A case with this reference; `seed` gives it content of its own (ingest is idempotent on content). */
function input(
  caseId: string,
  reference: string,
  seed: string = caseId,
  tenantId: string = TENANT_A,
) {
  return buildIngestInput({ tenantId, caseId, reference, receivedSeed: `${tenantId}:${seed}` });
}

const rejection = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => null,
    (error: unknown) => error,
  );

const countRows = async (table: string): Promise<number> =>
  (await h.database.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]?.n ??
  0;

/** Tenant sessions that skip the role switch: the connecting user is a superuser here, so no policy applies. */
function withoutRowLevelSecurity(scope: TenantScope): TenantRepositories {
  const database: Database = {
    kind: h.database.kind,
    query: (text, params) => h.database.query(text, params),
    transaction: (fn) => h.database.transaction(fn),
    withTenant: (_scope, fn) => h.database.transaction(fn),
    ping: () => h.database.ping(),
    close: () => Promise.resolve(),
  };
  return createRepositories(database).forTenant(scope);
}

// ------------------------------------------------------------------ findByReference

describe('[FR-ING-08] CaseRepository.findByReference', () => {
  it('finds the case with exactly that reference, as stored', async () => {
    const repos = h.contoso();
    await repos.cases.ingest(input('case_one', 'CG-SYN-1001'));
    await repos.cases.ingest(input('case_two', 'CG-SYN-1002'));

    const found = await repos.cases.findByReference('CG-SYN-1002');
    expect(found?.id).toBe('case_two');
    expect(found).toEqual(await repos.cases.get('case_two'));
    expect((await repos.cases.findByReference('CG-SYN-1001'))?.id).toBe('case_one');
  });

  it('answers null for a reference nobody has', async () => {
    const repos = h.contoso();
    await repos.cases.ingest(input('case_one', 'CG-SYN-1001'));
    expect(await repos.cases.findByReference('CG-SYN-9999')).toBeNull();
    expect(await h.fabrikam().cases.findByReference('CG-SYN-1001')).toBeNull();
  });

  it('is exact: not by case, prefix, suffix, substring, whitespace or pattern', async () => {
    const repos = h.contoso();
    await repos.cases.ingest(input('case_one', 'CG-SYN-1001'));
    for (const near of [
      'cg-syn-1001',
      'CG-SYN-100',
      'CG-SYN-10010',
      'G-SYN-1001',
      'CG-SYN-1001 ',
      ' CG-SYN-1001',
      'CG-SYN-100_',
      'CG-SYN-1001%',
      '%',
      '_',
      '.*',
      'CG-SYN-1001|x',
      "CG-SYN-1001' OR '1'='1",
    ]) {
      expect(await repos.cases.findByReference(near), JSON.stringify(near)).toBeNull();
    }
  });

  it('keeps references that differ only in case, blanks or look-alike characters apart', async () => {
    const repos = h.contoso();
    const references = ['CG-1001', 'cg-1001', 'CG-1001 ', 'CG\u20131001', 'CG-1001\u200b'];
    for (const [index, reference] of references.entries()) {
      await repos.cases.ingest(input(`case_${index}`, reference));
    }
    for (const [index, reference] of references.entries()) {
      expect((await repos.cases.findByReference(reference))?.id, JSON.stringify(reference)).toBe(
        `case_${index}`,
      );
    }
    expect(await repos.cases.counts()).toMatchObject({ total: references.length });
  });

  it.each([
    ['empty', ''],
    ['over 200 characters', 'x'.repeat(201)],
    ['a NUL character', 'CG-1\u0000'],
    ['a control character', 'CG-1\u0007'],
    ['null', null],
    ['a number', 1001],
  ])('refuses %s with a ValidationFailedError that names the field', async (_what, value) => {
    const error = await rejection(h.contoso().cases.findByReference(value as string));
    expect(error).toBeInstanceOf(ValidationFailedError);
    expect(error).toMatchObject({ code: 'validation_failed', status: 422 });
  });

  it('accepts what a case can carry, up to 200 characters, including non-ASCII text', async () => {
    const repos = h.contoso();
    const long = `CG-${'X'.repeat(197)}`;
    await repos.cases.ingest(input('case_long', long));
    await repos.cases.ingest(input('case_unicode', 'CG-ÄÖÜ-ß-日本'));
    expect((await repos.cases.findByReference(long))?.id).toBe('case_long');
    expect((await repos.cases.findByReference('CG-ÄÖÜ-ß-日本'))?.id).toBe('case_unicode');
  });

  it('[NFR-SEC-01] sees only the calling tenant, which may use the same reference for another case', async () => {
    await h.contoso().cases.ingest(input('case_mine', 'CG-SHARED'));
    await h.fabrikam().cases.ingest(input('case_theirs', 'CG-SHARED', 'theirs', TENANT_B));

    expect((await h.contoso().cases.findByReference('CG-SHARED'))?.id).toBe('case_mine');
    expect((await h.fabrikam().cases.findByReference('CG-SHARED'))?.id).toBe('case_theirs');
    // Without row-level security only the statement's own tenant predicate separates them.
    expect(
      (await withoutRowLevelSecurity(CONTOSO_SCOPE).cases.findByReference('CG-SHARED'))?.tenantId,
    ).toBe(TENANT_A);
    expect(
      (await withoutRowLevelSecurity(FABRIKAM_SCOPE).cases.findByReference('CG-SHARED'))?.tenantId,
    ).toBe(TENANT_B);
    // And row-level security alone hides the other tenant's row from the same statement.
    const hidden = await h.database.withTenant(FABRIKAM_SCOPE, (tx) =>
      tx.query('SELECT 1 FROM cases WHERE tenant_id = $1 AND reference = $2', [
        TENANT_A,
        'CG-SHARED',
      ]),
    );
    expect(hidden.rows).toEqual([]);
    const unprovisioned = h.repositories.forTenant({
      tenantId: 'tenant_with_no_data',
      actorId: 'system:test',
    });
    expect(await unprovisioned.cases.findByReference('CG-SHARED')).toBeNull();
  });

  it('is answered by the unique index on (tenant, reference)', async () => {
    const repos = h.contoso();
    await repos.cases.ingest(input('case_one', 'CG-SYN-1001'));
    const statements: { text: string; params: readonly unknown[] | undefined }[] = [];
    const database: Database = {
      kind: h.database.kind,
      query: (text, params) => h.database.query(text, params),
      transaction: (fn) => h.database.transaction(fn),
      withTenant: (tenant, fn) =>
        h.database.withTenant(tenant, (tx) =>
          fn({
            query: (text, params) => {
              statements.push({ text, params });
              return tx.query(text, params);
            },
          }),
        ),
      ping: () => h.database.ping(),
      close: () => Promise.resolve(),
    };
    await createRepositories(database)
      .forTenant(CONTOSO_SCOPE)
      .cases.findByReference('CG-SYN-1001');
    expect(statements).toHaveLength(1);
    expect(statements[0]?.text).toMatch(/tenant_id = \$1 AND reference = \$2/);

    const plan = await h.database.withTenant(CONTOSO_SCOPE, async (tx) => {
      await tx.query('SET LOCAL enable_seqscan = off');
      const result = await tx.query<Record<string, string>>(
        `EXPLAIN ${statements[0]?.text ?? ''}`,
        statements[0]?.params,
      );
      return result.rows.map((row) => Object.values(row)[0]).join('\n');
    });
    expect(plan).toContain('cases_tenant_reference_uq');
  });
});

// ------------------------------------------------------------------ uniqueness

describe('[FR-ING-08] a reference is used by one case per tenant', () => {
  it('has the constraint, and no longer the plain index it replaces', async () => {
    const constraint = await h.database.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid = 'cases'::regclass AND conname = 'cases_tenant_reference_uq'`,
    );
    expect(constraint.rows).toEqual([{ definition: 'UNIQUE (tenant_id, reference)' }]);
    const plain = await h.database.query(
      "SELECT 1 FROM pg_indexes WHERE tablename = 'cases' AND indexname = 'cases_reference_idx'",
    );
    expect(plain.rows).toEqual([]);
  });

  it('refuses a case with different content under a used reference: ConflictError, reason duplicate', async () => {
    const repos = h.contoso();
    await repos.cases.ingest(input('case_one', 'CG-1001'));
    const error = await rejection(repos.cases.ingest(input('case_two', 'CG-1001')));

    expect(error).toBeInstanceOf(ConflictError);
    expect(error).toMatchObject({
      code: 'conflict',
      status: 409,
      message: 'A case with this reference already exists in this workspace',
      details: { reason: 'duplicate' },
    });
    // The constraint is named in the sanitised cause (for logs), and neither the SQL nor a value is shown.
    expect(getDatabaseErrorCode(error)).toBe('23505');
    const cause = (error as ConflictError).cause;
    expect(cause).toBeInstanceOf(SanitizedDatabaseError);
    expect((cause as SanitizedDatabaseError).info.constraint).toBe('cases_tenant_reference_uq');
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error as object))).not.toMatch(
      /INSERT|CG-1001/,
    );
  });

  it('leaves nothing of the refused case behind, and the first one untouched', async () => {
    const repos = h.contoso();
    await repos.cases.ingest(input('case_one', 'CG-1001'));
    const before = {
      cases: await countRows('cases'),
      sources: await countRows('case_sources'),
      participants: await countRows('case_participants'),
      events: await countRows('case_events'),
    };
    await expect(repos.cases.ingest(input('case_two', 'CG-1001'))).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect({
      cases: await countRows('cases'),
      sources: await countRows('case_sources'),
      participants: await countRows('case_participants'),
      events: await countRows('case_events'),
    }).toEqual(before);
    expect(await repos.cases.get('case_two')).toBeNull();
    expect((await repos.cases.findByReference('CG-1001'))?.id).toBe('case_one');
  });

  it('is still idempotent: the same content under the same reference is the same case, not a conflict', async () => {
    const repos = h.contoso();
    const first = await repos.cases.ingest(input('case_one', 'CG-1001', 'same-content'));
    const again = await repos.cases.ingest(input('case_two', 'CG-1001', 'same-content'));
    expect(first.created).toBe(true);
    expect(again).toMatchObject({ created: false });
    expect(again.case.id).toBe('case_one');
    expect(await repos.cases.counts()).toMatchObject({ total: 1 });
  });

  it('[NFR-SEC-01] is per tenant: another workspace may use the same reference', async () => {
    await h.contoso().cases.ingest(input('case_mine', 'CG-1001'));
    await h.fabrikam().cases.ingest(input('case_theirs', 'CG-1001', 'theirs', TENANT_B));
    await expect(
      h.fabrikam().cases.ingest(input('case_theirs_2', 'CG-1001', 'theirs-2', TENANT_B)),
    ).rejects.toMatchObject({ details: { reason: 'duplicate' } });
    expect(await h.contoso().cases.counts()).toMatchObject({ total: 1 });
    expect(await h.fabrikam().cases.counts()).toMatchObject({ total: 1 });
  });

  it('frees the reference when the case is erased', async () => {
    const repos = h.contoso();
    await repos.cases.ingest(input('case_one', 'CG-1001'));
    await expect(repos.cases.ingest(input('case_two', 'CG-1001'))).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(await repos.cases.delete('case_one')).toBe(true);
    expect((await repos.cases.ingest(input('case_two', 'CG-1001'))).created).toBe(true);
    expect((await repos.cases.findByReference('CG-1001'))?.id).toBe('case_two');
  });

  it('settles two ingests of different content under one new reference: one wins, one is refused', async () => {
    const repos = h.contoso();
    const outcomes = await Promise.allSettled([
      repos.cases.ingest(input('case_one', 'CG-RACE-1')),
      repos.cases.ingest(input('case_two', 'CG-RACE-1')),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const refused = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({
      details: { reason: 'duplicate' },
    });
    expect(await repos.cases.counts()).toMatchObject({ total: 1 });
  });

  it('rolls back what shares its transaction: an audit record written before the refused ingest is gone too', async () => {
    const repos = h.contoso();
    await repos.cases.ingest(input('case_one', 'CG-1001'));
    const error = await rejection(
      repos.transaction(async (tx) => {
        await tx.audit.append(buildAuditInput({ action: 'case.ingested', caseId: 'case_two' }));
        await tx.cases.ingest(input('case_two', 'CG-1001'));
      }),
    );
    expect(error).toMatchObject({ details: { reason: 'duplicate' } });
    expect((await repos.audit.list({ limit: 10 })).items).toEqual([]);
    expect((await repos.audit.verify()).valid).toBe(true);
  });

  it('does not stop the same reference being read, listed or found by search while it is used once', async () => {
    const repos = h.contoso();
    await repos.cases.ingest(input('case_one', 'CG-FIND-1'));
    expect((await repos.cases.list({ limit: 10, q: 'CG-FIND-1' })).items.map((i) => i.id)).toEqual([
      'case_one',
    ]);
    expect(
      (await repos.search.query({ text: 'CG-FIND-1', limit: 5 })).map((hit) => hit.id),
    ).toContain('case_one');
  });
});
