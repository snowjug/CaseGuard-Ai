import { REVIEW_TARGETS, type ReviewDecision } from '@caseguard/schemas';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRepositories } from '../src/db/repositories';
import type {
  Database,
  SqlExecutor,
  TenantRepositories,
  TenantScope,
} from '../src/db/repositories/types';
import {
  CONTOSO_SCOPE,
  FABRIKAM_SCOPE,
  TEST_DATABASE_STARTUP_TIMEOUT_MS,
  createTestRepositories,
  type TestHarness,
} from '../src/db/testing';
import { ValidationFailedError } from '../src/errors';
import { TENANT_A, TENANT_B, at, buildIngestInput, buildReviewDecision } from './builders';

let h: TestHarness;

beforeAll(async () => {
  h = await createTestRepositories();
  await seed();
}, TEST_DATABASE_STARTUP_TIMEOUT_MS);
afterAll(async () => {
  await h.close();
});

// ------------------------------------------------------------------ the fixture

/** Ids have one shape, so any collation orders them the way code units do. */
const rid = (kind: string, caseTag: string, n: number): string =>
  `rev_${kind}_${caseTag}_${String(n).padStart(3, '0')}`;

function decision(
  tenantId: string,
  id: string,
  caseId: string | null,
  targetType: ReviewDecision['targetType'],
  minute: number,
): ReviewDecision {
  return buildReviewDecision({
    tenantId,
    id,
    caseId,
    targetType,
    targetId: `${targetType}_${id}`,
    decidedAt: at(minute),
    createdAt: at(minute),
    updatedAt: at(minute),
  });
}

/** Contoso: two cases, many types, groups of decisions that share a timestamp (ties). */
function contosoDecisions(): ReviewDecision[] {
  const all: ReviewDecision[] = [];
  for (let n = 1; n <= 30; n += 1) {
    all.push(decision(TENANT_A, rid('claim', 'a', n), 'case_a', 'claim', 100 + Math.floor(n / 3)));
    all.push(decision(TENANT_A, rid('claim', 'b', n), 'case_b', 'claim', 100 + Math.floor(n / 3)));
  }
  // 30 action-value overrides on case_a in ten minutes, three to a minute: every page boundary of a
  // small page size falls among decisions with the same decidedAt.
  for (let n = 1; n <= 30; n += 1) {
    all.push(
      decision(
        TENANT_A,
        rid('av', 'a', n),
        'case_a',
        'action_value',
        200 + Math.floor((n - 1) / 3),
      ),
    );
  }
  for (let n = 1; n <= 15; n += 1) {
    all.push(decision(TENANT_A, rid('av', 'b', n), 'case_b', 'action_value', 220 + n));
  }
  for (let n = 1; n <= 8; n += 1) {
    all.push(decision(TENANT_A, rid('warn', 'a', n), 'case_a', 'warning', 300 + n));
  }
  // `skill` is a prefix of `skill_version`: an exact match must tell them apart. No case.
  for (let n = 1; n <= 3; n += 1) {
    all.push(decision(TENANT_A, rid('skill', 'x', n), null, 'skill', 310 + n));
    all.push(decision(TENANT_A, rid('skver', 'x', n), null, 'skill_version', 320 + n));
  }
  return all;
}

/** Fabrikam holds decisions with the very same ids and targets as Contoso's action-value ones. */
function fabrikamDecisions(): ReviewDecision[] {
  const all: ReviewDecision[] = [];
  for (let n = 1; n <= 10; n += 1) {
    all.push(decision(TENANT_B, rid('av', 'a', n), 'case_a', 'action_value', 400 + n));
  }
  for (let n = 1; n <= 5; n += 1) {
    all.push(decision(TENANT_B, rid('claim', 'a', n), 'case_a', 'claim', 420 + n));
  }
  return all;
}

const CONTOSO = contosoDecisions();
const FABRIKAM = fabrikamDecisions();

/** What the list must return: newest first, ties broken by id descending. */
const newestFirst = (a: ReviewDecision, b: ReviewDecision): number =>
  a.decidedAt < b.decidedAt ? 1 : a.decidedAt > b.decidedAt ? -1 : a.id < b.id ? 1 : -1;

const expectedIds = (
  rows: readonly ReviewDecision[],
  filter: { caseId?: string; targetType?: string } = {},
): string[] =>
  rows
    .filter((row) => filter.caseId === undefined || row.caseId === filter.caseId)
    .filter((row) => filter.targetType === undefined || row.targetType === filter.targetType)
    .sort(newestFirst)
    .map((row) => row.id);

async function seed(): Promise<void> {
  await h.reset();
  for (const [repos, caseIds] of [
    [h.contoso(), ['case_a', 'case_b']],
    [h.fabrikam(), ['case_a']],
  ] as const) {
    for (const caseId of caseIds) {
      const { tenantId } = repos.scope;
      await repos.cases.ingest(
        buildIngestInput({ tenantId, caseId, receivedSeed: `${tenantId}:${caseId}` }),
      );
    }
  }
  await h.contoso().transaction(async (tx) => {
    for (const row of CONTOSO) await tx.reviews.record(row);
  });
  await h.fabrikam().transaction(async (tx) => {
    for (const row of FABRIKAM) await tx.reviews.record(row);
  });
}

async function everyPage(
  repos: TenantRepositories,
  query: { caseId?: string; targetType?: string },
  limit: number,
): Promise<{ ids: string[]; pages: number; sizes: number[] }> {
  const ids: string[] = [];
  const sizes: number[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await repos.reviews.list({ ...query, limit, ...(cursor ? { cursor } : {}) });
    pages += 1;
    sizes.push(page.items.length);
    ids.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined && pages < 100);
  return { ids, pages, sizes };
}

/** Repositories that remember the statements they ran (not the role and tenant setup). */
function recorded(scope: TenantScope = CONTOSO_SCOPE) {
  const statements: { text: string; params: readonly unknown[] | undefined }[] = [];
  const spy = (tx: SqlExecutor): SqlExecutor => ({
    query: (text, params) => {
      statements.push({ text, params });
      return tx.query(text, params);
    },
  });
  const database: Database = {
    kind: h.database.kind,
    query: (text, params) => spy(h.database).query(text, params),
    transaction: (fn) => h.database.transaction((tx) => fn(spy(tx))),
    withTenant: (tenant, fn) => h.database.withTenant(tenant, (tx) => fn(spy(tx))),
    ping: () => h.database.ping(),
    close: () => Promise.resolve(),
  };
  return { repos: createRepositories(database).forTenant(scope), statements };
}

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

// ------------------------------------------------------------------ the filter

describe('[NFR-REL-01] ReviewRepository.list by target type', () => {
  it('has decisions of five kinds, in the numbers the other tests rely on', () => {
    const count = (targetType: string) => CONTOSO.filter((r) => r.targetType === targetType).length;
    expect([count('claim'), count('action_value'), count('warning')]).toEqual([60, 45, 8]);
    expect([count('skill'), count('skill_version'), count('fork')]).toEqual([3, 3, 0]);
  });

  it.each([...REVIEW_TARGETS])(
    '%s: returns exactly the decisions of that type, newest first',
    async (type) => {
      const page = await h.contoso().reviews.list({ limit: 200, targetType: type });
      expect(page.items.map((item) => item.id)).toEqual(expectedIds(CONTOSO, { targetType: type }));
      expect(page.items.every((item) => item.targetType === type)).toBe(true);
      expect(page.nextCursor).toBeNull();
    },
  );

  it('matches the stored type exactly: skill is not skill_version, and nothing matches by prefix or pattern', async () => {
    const repos = h.contoso();
    const skills = await repos.reviews.list({ limit: 50, targetType: 'skill' });
    const versions = await repos.reviews.list({ limit: 50, targetType: 'skill_version' });
    expect(skills.items.map((item) => item.id)).toEqual(
      expectedIds(CONTOSO, { targetType: 'skill' }),
    );
    expect(versions.items.map((item) => item.id)).toEqual(
      expectedIds(CONTOSO, { targetType: 'skill_version' }),
    );
    expect(skills.items).toHaveLength(3);
    expect(versions.items).toHaveLength(3);
  });

  it('without the filter the list is what it always was: every decision, newest first', async () => {
    const everything = await everyPage(h.contoso(), {}, 50);
    expect(everything.ids).toEqual(expectedIds(CONTOSO));
    expect(everything.ids).toHaveLength(CONTOSO.length);
  });

  it('combines with the case: the decisions of that type in that case', async () => {
    const repos = h.contoso();
    for (const [caseId, targetType, count] of [
      ['case_a', 'action_value', 30],
      ['case_b', 'action_value', 15],
      ['case_a', 'claim', 30],
      ['case_b', 'warning', 0],
      ['case_a', 'skill', 0], // decisions without a case are in no case
      ['case_unknown', 'action_value', 0],
    ] as const) {
      const page = await repos.reviews.list({ limit: 100, caseId, targetType });
      expect(
        page.items.map((item) => item.id),
        `${caseId} ${targetType}`,
      ).toEqual(expectedIds(CONTOSO, { caseId, targetType }));
      expect(page.items).toHaveLength(count);
    }
  });

  it('returns validated decisions, whole', async () => {
    const [first] = (await h.contoso().reviews.list({ limit: 1, targetType: 'warning' })).items;
    expect(first).toEqual(
      CONTOSO.filter((row) => row.targetType === 'warning').sort(newestFirst)[0],
    );
  });
});

// ------------------------------------------------------------------ input

describe('[NFR-SEC-05] a target type that no decision can have', () => {
  it.each([
    ['empty', ''],
    ['a plural', 'claims'],
    ['another case', 'CLAIM'],
    ['a trailing blank', 'skill '],
    ['SQL', "claim' OR '1'='1"],
    ['a LIKE wildcard', 'claim%'],
    ['a lone wildcard', '%'],
    ['an underscore pattern', 'skill_versio_'],
    ['a regular expression', '.*'],
    ['a NUL character', 'claim\u0000'],
    ['null', null],
    ['a number', 5],
    ['an object', {}],
  ])(
    '%s is a ValidationFailedError that names the field and the choices, before any SQL',
    async (_what, value) => {
      const { repos, statements } = recorded();
      const error = await repos.reviews.list({ limit: 5, targetType: value as string }).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(ValidationFailedError);
      expect(error).toMatchObject({ code: 'validation_failed', status: 422 });
      const [issue] = (error as ValidationFailedError).issues;
      expect(issue?.path).toBe('targetType');
      expect(issue?.message).toContain('action_value');
      expect(statements).toHaveLength(0);
    },
  );
});

// ------------------------------------------------------------------ pagination

describe('[NFR-REL-01] keyset pagination under the filter', () => {
  it.each([1, 4, 7, 10, 44, 45, 46, 200])(
    'pages of %i over a type that has ties: every decision exactly once, in order',
    async (limit) => {
      const { ids, pages, sizes } = await everyPage(
        h.contoso(),
        { targetType: 'action_value' },
        limit,
      );
      const expected = expectedIds(CONTOSO, { targetType: 'action_value' });
      expect(ids).toEqual(expected);
      expect(new Set(ids).size).toBe(ids.length);
      expect(pages).toBe(Math.ceil(expected.length / limit));
      expect(sizes.slice(0, -1).every((size) => size === limit)).toBe(true);
    },
  );

  it('pages through one case and one type the same way', async () => {
    const { ids } = await everyPage(
      h.contoso(),
      { caseId: 'case_a', targetType: 'action_value' },
      4,
    );
    expect(ids).toEqual(expectedIds(CONTOSO, { caseId: 'case_a', targetType: 'action_value' }));
    expect(ids).toHaveLength(30);
  });

  it('answers a null cursor exactly when nothing is left, including on a page that is exactly full', async () => {
    const repos = h.contoso();
    const full = await repos.reviews.list({ limit: 45, targetType: 'action_value' });
    expect(full.items).toHaveLength(45);
    expect(full.nextCursor).toBeNull();
    const short = await repos.reviews.list({ limit: 44, targetType: 'action_value' });
    expect(short.nextCursor).not.toBeNull();
    expect(
      (
        await repos.reviews.list({
          limit: 44,
          targetType: 'action_value',
          cursor: short.nextCursor ?? '',
        })
      ).items,
    ).toHaveLength(1);
  });

  it('a decision recorded between two pages neither repeats nor skips anything after the cursor', async () => {
    const repos = h.contoso();
    const first = await repos.reviews.list({ limit: 10, targetType: 'action_value' });
    // Newer than everything: it belongs in front of the first page, which was already read.
    await repos.reviews.record(
      decision(TENANT_A, rid('av', 'z', 1), 'case_b', 'action_value', 900),
    );
    try {
      const rest: string[] = [];
      let cursor = first.nextCursor ?? undefined;
      while (cursor !== undefined) {
        const page = await repos.reviews.list({ limit: 10, targetType: 'action_value', cursor });
        rest.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor ?? undefined;
      }
      const original = expectedIds(CONTOSO, { targetType: 'action_value' });
      expect([...first.items.map((item) => item.id), ...rest]).toEqual(original);
    } finally {
      await h.database.query('DELETE FROM review_decisions WHERE tenant_id = $1 AND id = $2', [
        TENANT_A,
        rid('av', 'z', 1),
      ]);
    }
  });

  it('refuses a forged cursor with the filter on, as without it', async () => {
    await expect(
      h.contoso().reviews.list({ limit: 5, targetType: 'claim', cursor: 'forged.cursor' }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });
});

// ------------------------------------------------------------------ tenants

describe('[NFR-SEC-01] the filter never crosses tenants', () => {
  it('each tenant sees only its own decisions of the type, though ids and targets coincide', async () => {
    const mine = await everyPage(h.contoso(), { targetType: 'action_value' }, 50);
    const theirs = await everyPage(h.fabrikam(), { targetType: 'action_value' }, 50);
    expect(mine.ids).toEqual(expectedIds(CONTOSO, { targetType: 'action_value' }));
    expect(theirs.ids).toEqual(expectedIds(FABRIKAM, { targetType: 'action_value' }));
    expect(theirs.ids).toHaveLength(10);
    // The same ids exist in both tenants; the rows are different.
    const overlap = mine.ids.filter((id) => theirs.ids.includes(id));
    expect(overlap.length).toBeGreaterThan(0);
    const mineRows = (await h.contoso().reviews.list({ limit: 200, targetType: 'action_value' }))
      .items;
    const theirRows = (await h.fabrikam().reviews.list({ limit: 200, targetType: 'action_value' }))
      .items;
    expect(mineRows.every((row) => row.tenantId === TENANT_A)).toBe(true);
    expect(theirRows.every((row) => row.tenantId === TENANT_B)).toBe(true);
    // A type that only one tenant has decisions of.
    expect((await h.fabrikam().reviews.list({ limit: 50, targetType: 'warning' })).items).toEqual(
      [],
    );
  });

  it('an unprovisioned tenant has none', async () => {
    const empty = h.repositories.forTenant({
      tenantId: 'tenant_with_no_data',
      actorId: 'system:test',
    });
    expect((await empty.reviews.list({ limit: 50, targetType: 'action_value' })).items).toEqual([]);
  });

  it('the statement filters by tenant itself: with row-level security out of the picture, the other tenant stays out', async () => {
    const withoutPolicy = withoutRowLevelSecurity(CONTOSO_SCOPE);
    const page = await withoutPolicy.reviews.list({ limit: 200, targetType: 'action_value' });
    expect(page.items.map((item) => item.id)).toEqual(
      expectedIds(CONTOSO, { targetType: 'action_value' }),
    );
    expect(page.items.every((item) => item.tenantId === TENANT_A)).toBe(true);
  });

  it('and row-level security alone confines the very same statement to the session tenant', async () => {
    const { repos, statements } = recorded();
    await repos.reviews.list({ limit: 200, targetType: 'action_value' });
    const [statement] = statements;
    // Contoso's tenant id in the predicate, but the session belongs to Fabrikam.
    const crossTenant = await h.database.withTenant(FABRIKAM_SCOPE, (tx) =>
      tx.query(statement?.text ?? '', statement?.params),
    );
    expect(crossTenant.rows).toEqual([]);
  });
});

// ------------------------------------------------------------------ the statement and its indexes

describe('[NFR-REL-01] the filter is one parameterised statement served by an index', () => {
  it('is a single statement whose type is a bound value, never part of the text', async () => {
    const { repos, statements } = recorded();
    await repos.reviews.list({ limit: 5, caseId: 'case_a', targetType: 'action_value' });
    expect(statements).toHaveLength(1);
    expect(statements[0]?.text).toMatch(/target_type = \$\d+/);
    expect(statements[0]?.text).not.toContain('action_value');
    expect(statements[0]?.params).toContain('action_value');
  });

  async function plan(text: string, params: readonly unknown[]): Promise<string> {
    // As the application role, so row-level security is in play; sequential scans are switched off
    // so the planner has to choose among the indexes that exist.
    return h.database.withTenant(CONTOSO_SCOPE, async (tx) => {
      await tx.query('SET LOCAL enable_seqscan = off');
      const result = await tx.query<Record<string, string>>(`EXPLAIN ${text}`, params);
      return result.rows.map((row) => Object.values(row)[0]).join('\n');
    });
  }

  it('reads one type through (tenant, type, time), and one type of one case through (tenant, case, type, time), with no sort', async () => {
    // The statements as the repository runs them, captured on the valid fixture ...
    const { repos, statements } = recorded();
    await repos.reviews.list({ limit: 51, targetType: 'action_value' });
    await repos.reviews.list({ limit: 51, caseId: 'case_a', targetType: 'action_value' });
    const [typeOnly, inCase] = statements;

    // ... and planned over many more decisions than the fixture, so that the choice of index matters.
    // (These rows hold placeholder data, which the repository would rightly refuse to return.)
    await h.database.query(
      `INSERT INTO cases (tenant_id, id, reference, title, product, workload, severity, status, customer_alias,
         opened_at, synthetic, tags, event_count, source_id, source_kind, content_hash, redaction_applied,
         redaction_replacements, injection_detected, has_resolution, analysis_state, last_analysis_run_id,
         created_at, updated_at, created_by, data)
       SELECT $1, 'bulk' || g, 'CG-BULK-' || g, 'Case ' || g, 'p', 'w', 'B', 'open', 'alias', now(), true,
              '{}', 0, 'src', 'json_bundle', 'h' || g, false, 0, false, false, 'analyzed', 'run_1', now(), now(),
              'x', '{}'::jsonb
         FROM generate_series(1, 100) g`,
      [TENANT_A],
    );
    await h.database.query(
      `INSERT INTO review_decisions (tenant_id, id, case_id, target_type, target_id, decision, reviewer_id,
         reviewer_role, decided_at, created_at, updated_at, created_by, version, data)
       SELECT $1, 'bulk_' || g, 'bulk' || (1 + g % 100),
              (ARRAY['claim','claim','claim','claim','warning','fork','counterfactual','action_value'])[1 + g % 8],
              'target_' || g, 'confirm', 'u', 'reviewer', '2026-02-01'::timestamptz + g * interval '1 minute',
              now(), now(), 'x', 1, '{}'::jsonb
         FROM generate_series(1, 8000) g`,
      [TENANT_A],
    );
    await h.database.query('ANALYZE review_decisions');

    const typePlan = await plan(typeOnly?.text ?? '', typeOnly?.params ?? []);
    expect(typePlan).toContain('review_decisions_type_idx');
    expect(typePlan).not.toMatch(/Sort/);
    // The same statement for a case that holds a hundred decisions.
    const bulkCaseParams = (inCase?.params ?? []).map((value) =>
      value === 'case_a' ? 'bulk7' : value,
    );
    const casePlan = await plan(inCase?.text ?? '', bulkCaseParams);
    expect(casePlan).toContain('review_decisions_case_type_idx');
    expect(casePlan).not.toMatch(/Sort/);

    // Leave the fixture as it was for any test that runs after this one.
    await h.database.query("DELETE FROM review_decisions WHERE id LIKE 'bulk\\_%'");
    await h.database.query("DELETE FROM cases WHERE id LIKE 'bulk%' AND tenant_id = $1", [
      TENANT_A,
    ]);
  });
});
