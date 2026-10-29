import {
  AnalysisStateSchema,
  CaseWarningSchema,
  IdSchema,
  MissingEvidenceSchema,
  type CaseWarning,
  type MissingEvidence,
} from '@caseguard/schemas';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRepositories } from '../src/db/repositories';
import {
  CRITICAL_MISSING_SQL,
  MAX_DASHBOARD_LIST,
  MAX_SUMMARY_CASES,
  MISSING_CRITICALITY_ORDER,
  OPEN_WARNINGS_SQL,
  SUMMARY_SQL,
  WARNING_PRIORITY_ORDER,
} from '../src/db/repositories/analysis-read-models';
import type {
  AnalysisSnapshot,
  Database,
  IngestCaseInput,
  SqlExecutor,
  TenantScope,
} from '../src/db/repositories/types';
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
  at,
  buildIngestInput,
  buildMissingEvidence,
  buildSnapshot,
  buildWarning,
} from './builders';

const MissingWithCaseSchema = MissingEvidenceSchema.extend({ caseId: IdSchema });

let h: TestHarness;

beforeAll(async () => {
  h = await createTestRepositories();
}, TEST_DATABASE_STARTUP_TIMEOUT_MS);
afterAll(async () => {
  await h.close();
});

const contoso = () => h.contoso();
const fabrikam = () => h.fabrikam();

// ------------------------------------------------------------------ fixture helpers

type Priority = CaseWarning['priority'];
type Criticality = MissingEvidence['criticality'];

function warning(
  tenantId: string,
  caseId: string,
  id: string,
  priority: Priority,
  minutes: number,
  state: CaseWarning['state'] = 'open',
  rank = 1,
  run = 1,
): CaseWarning {
  return buildWarning({
    tenantId,
    caseId,
    analysisRunId: `run_${caseId}_${run}`,
    id,
    ruleId: `rule.${id}`,
    fingerprint: `fp.${id}`,
    title: `Warning ${id}`,
    priority,
    rank,
    raisedAt: at(minutes),
    state,
    ...(state === 'resolved'
      ? { resolvedAt: at(minutes + 10), resolvedReason: 'Resolved in the test' }
      : {}),
    ...(state === 'dismissed'
      ? {
          dismissal: {
            by: 'user_riley_reviewer',
            at: at(minutes + 5),
            reason: 'Not relevant for this case',
          },
        }
      : {}),
  });
}

function missing(
  id: string,
  criticality: Criticality,
  minutes: number,
  resolved = false,
): MissingEvidence {
  return buildMissingEvidence({
    id,
    requirementId: `req.${id}`,
    label: `Missing ${id}`,
    criticality,
    firstRelevantAt: at(minutes),
    resolvedAt: resolved ? at(minutes + 10) : null,
  });
}

interface AnalysisShape {
  qualityScore: number;
  /** Null makes the Avoidable Support Effort metric unknown. */
  ase: number | null;
  confidences: [number, number];
  names?: [string, string];
  warnings: CaseWarning[];
  missing: MissingEvidence[];
}

/** A consistent snapshot whose summary-relevant values are exactly the ones in `shape`. */
function snapshotFor(
  input: IngestCaseInput,
  shape: AnalysisShape,
  runId?: string,
): AnalysisSnapshot {
  const base = buildSnapshot(input, { warnings: shape.warnings, ...(runId ? { runId } : {}) });
  const around = (value: number, delta: number) => Math.min(1, Math.max(0, value + delta));
  return {
    ...base,
    quality: {
      ...base.quality,
      compositeScore: shape.qualityScore,
      compositeLow: Math.max(0, shape.qualityScore - 7),
      compositeHigh: Math.min(100, shape.qualityScore + 7),
    },
    metrics: base.metrics.map((metric) => {
      if (metric.key !== 'avoidable_support_effort') return metric;
      return shape.ase === null
        ? {
            ...metric,
            value: null,
            low: null,
            high: null,
            status: 'unknown' as const,
            display: 'Not available',
            ase: null,
          }
        : { ...metric, value: shape.ase, display: `${shape.ase}%` };
    }),
    hypotheses: base.hypotheses.map((hypothesis, index) => {
      const confidence = shape.confidences[index] ?? hypothesis.currentConfidence;
      return {
        ...hypothesis,
        name: shape.names?.[index] ?? hypothesis.name,
        currentConfidence: confidence,
        currentLow: around(confidence, -0.1),
        currentHigh: around(confidence, 0.1),
      };
    }),
    missing: shape.missing,
  };
}

async function analyse(
  scope: 'contoso' | 'fabrikam',
  input: IngestCaseInput,
  shape: AnalysisShape,
  runId?: string,
): Promise<void> {
  const repos = scope === 'contoso' ? contoso() : fabrikam();
  await repos.cases.ingest(input);
  await repos.analysis.saveSnapshot(snapshotFor(input, shape, runId));
}

function ingestInput(caseId: string, tenantId = TENANT_A, synthetic = true): IngestCaseInput {
  const input = buildIngestInput({ tenantId, caseId, receivedSeed: `${tenantId}:${caseId}` });
  return { ...input, case: { ...input.case, synthetic } };
}

/**
 * Contoso: a1 (analysed, leading hypothesis is the SECOND one), a2 (analysed, unknown ASE, tied
 * hypotheses, many warnings), a3 (ingested only), a4 (queued, no artefacts).
 * Fabrikam: its own `case_a1` (same id as Contoso's) and `case_b1`.
 */
async function seedDashboardData(): Promise<void> {
  await analyse('contoso', ingestInput('case_a1'), {
    qualityScore: 81.5,
    ase: 31,
    confidences: [0.3, 0.7],
    names: ['Proxy rule blocks the sign-in endpoint', 'Identity provider outage'],
    warnings: [
      warning(TENANT_A, 'case_a1', 'w1', 'high', 30, 'open', 1),
      warning(TENANT_A, 'case_a1', 'w2', 'critical', 10, 'open', 2),
      warning(TENANT_A, 'case_a1', 'w3', 'low', 50, 'resolved', 3),
      warning(TENANT_A, 'case_a1', 'w4', 'medium', 40, 'dismissed', 4),
    ],
    missing: [
      missing('m_crit_new', 'critical', 80),
      missing('m_crit_old', 'critical', 20),
      missing('m_important', 'important', 40),
      missing('m_helpful', 'helpful', 60),
      missing('m_crit_done', 'critical', 30, true),
    ],
  });
  await analyse('contoso', ingestInput('case_a2'), {
    qualityScore: 55,
    ase: null,
    confidences: [0.5, 0.5],
    names: ['Alpha hypothesis', 'Beta hypothesis'],
    warnings: [
      warning(TENANT_A, 'case_a2', 'w5', 'critical', 60, 'open', 1),
      warning(TENANT_A, 'case_a2', 'w6', 'high', 5, 'open', 2),
      warning(TENANT_A, 'case_a2', 'w7', 'low', 70, 'open', 3),
      warning(TENANT_A, 'case_a2', 'w8', 'medium', 40, 'open', 4),
    ],
    missing: [missing('m5', 'critical', 70), missing('m6', 'important', 5)],
  });
  await contoso().cases.ingest(ingestInput('case_a3'));
  await contoso().cases.ingest(ingestInput('case_a4'));
  await contoso().cases.setAnalysisState('case_a4', 'queued');

  await analyse('fabrikam', ingestInput('case_a1', TENANT_B), {
    qualityScore: 33,
    ase: 12,
    confidences: [0.8, 0.1],
    names: ['Fabrikam proxy hypothesis', 'Fabrikam other hypothesis'],
    warnings: [warning(TENANT_B, 'case_a1', 'fw1', 'critical', 100, 'open', 1)],
    missing: [missing('fm1', 'critical', 95)],
  });
  await analyse('fabrikam', ingestInput('case_b1', TENANT_B), {
    qualityScore: 90,
    ase: 5,
    confidences: [0.9, 0.05],
    warnings: [warning(TENANT_B, 'case_b1', 'fw2', 'high', 90, 'open', 1)],
    missing: [missing('fm2', 'important', 10)],
  });
}

/** Repositories that remember every statement they run (the role and tenant setup is not recorded). */
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

const EMPTY_TENANT: TenantScope = { tenantId: 'tenant_with_no_data', actorId: 'system:test' };
const emptyTenant = () => h.repositories.forTenant(EMPTY_TENANT);

const ids = (items: { id: string }[]) => items.map((item) => item.id);

function onlyStatement(statements: { text: string; params: readonly unknown[] | undefined }[]) {
  expect(statements).toHaveLength(1);
  const [statement] = statements;
  if (!statement) throw new Error('No statement was recorded');
  return statement;
}

// ------------------------------------------------------------------ the shared, read-only fixture

describe('dashboard read models over a shared fixture', () => {
  beforeAll(async () => {
    await h.reset();
    await seedDashboardData();
  }, TEST_DATABASE_STARTUP_TIMEOUT_MS);

  describe('[FR-UX-01] AnalysisRepository.summarize', () => {
    it('reports the four analysis-derived fields of each case, in the order requested', async () => {
      const summaries = await contoso().analysis.summarize([
        'case_a1',
        'case_a2',
        'case_a3',
        'case_a4',
      ]);
      expect(summaries).toEqual([
        {
          caseId: 'case_a1',
          qualityIndex: 81.5,
          avoidableEffortPct: 31,
          // The second hypothesis has the higher confidence: the leader is chosen by confidence, not position.
          leadingHypothesis: { name: 'Identity provider outage', confidence: 0.7 },
          openWarningCount: 2,
        },
        {
          caseId: 'case_a2',
          qualityIndex: 55,
          // The Avoidable Support Effort metric of this case is unknown, so no value is reported.
          avoidableEffortPct: null,
          // Equal confidences: the earlier hypothesis (lower ordinal) leads, deterministically.
          leadingHypothesis: { name: 'Alpha hypothesis', confidence: 0.5 },
          openWarningCount: 4,
        },
        // Not analysed (ingested only) and queued (no artefacts yet): nothing but zero warnings.
        {
          caseId: 'case_a3',
          qualityIndex: null,
          avoidableEffortPct: null,
          leadingHypothesis: null,
          openWarningCount: 0,
        },
        {
          caseId: 'case_a4',
          qualityIndex: null,
          avoidableEffortPct: null,
          leadingHypothesis: null,
          openWarningCount: 0,
        },
      ]);

      expect(
        (await contoso().analysis.summarize(['case_a3', 'case_a1'])).map((s) => s.caseId),
      ).toEqual(['case_a3', 'case_a1']);
    });

    it('agrees with what the per-case methods report for the same case', async () => {
      const repos = contoso();
      for (const caseId of ['case_a1', 'case_a2', 'case_a3']) {
        const [summary] = await repos.analysis.summarize([caseId]);
        const quality = await repos.analysis.getQuality(caseId);
        const hypotheses = await repos.analysis.listHypotheses(caseId);
        const ase = (await repos.analysis.listMetrics(caseId)).find(
          (metric) => metric.key === 'avoidable_support_effort',
        );
        const open = await repos.analysis.listWarnings(caseId, { state: 'open' });
        const leader = [...hypotheses].sort((a, b) => b.currentConfidence - a.currentConfidence)[0];
        expect(summary).toEqual({
          caseId,
          qualityIndex: quality?.compositeScore ?? null,
          avoidableEffortPct: ase?.value ?? null,
          leadingHypothesis: leader
            ? { name: leader.name, confidence: leader.currentConfidence }
            : null,
          openWarningCount: open.length,
        });
      }
    });

    it('collapses duplicates and omits ids that are not cases of the tenant', async () => {
      const summaries = await contoso().analysis.summarize([
        'case_a2',
        'case_does_not_exist',
        'case_a2',
        'case_a1',
        'case_a1',
      ]);
      expect(summaries.map((s) => s.caseId)).toEqual(['case_a2', 'case_a1']);
      expect(await contoso().analysis.summarize(['nothing', 'nowhere'])).toEqual([]);
      expect(await contoso().analysis.summarize([])).toEqual([]);
    });

    it('[NFR-SEC-01] never reports on another tenant, even for the same case id', async () => {
      // Fabrikam has its own case_a1 with different values; Contoso's case_a2 does not exist there.
      expect(await fabrikam().analysis.summarize(['case_a1', 'case_a2', 'case_b1'])).toEqual([
        {
          caseId: 'case_a1',
          qualityIndex: 33,
          avoidableEffortPct: 12,
          leadingHypothesis: { name: 'Fabrikam proxy hypothesis', confidence: 0.8 },
          openWarningCount: 1,
        },
        {
          caseId: 'case_b1',
          qualityIndex: 90,
          avoidableEffortPct: 5,
          leadingHypothesis: { name: 'Proxy rule blocks the sign-in endpoint', confidence: 0.9 },
          openWarningCount: 1,
        },
      ]);
      // Contoso cannot see Fabrikam's case_b1 at all.
      expect(await contoso().analysis.summarize(['case_b1'])).toEqual([]);
    });

    it('[NFR-SEC-01] row-level security alone hides other tenants, even if the tenant id is wrong', async () => {
      // The statement is handed Contoso's tenant id but runs as Fabrikam: the policy returns nothing.
      const rows = await h.database.withTenant(FABRIKAM_SCOPE, (tx) =>
        tx.query(SUMMARY_SQL, [TENANT_A, ['case_a1', 'case_a2', 'case_a3']]),
      );
      expect(rows.rows).toEqual([]);
      const own = await h.database.withTenant(CONTOSO_SCOPE, (tx) =>
        tx.query(SUMMARY_SQL, [TENANT_A, ['case_a1', 'case_a2', 'case_a3']]),
      );
      expect(own.rows).toHaveLength(3);
    });

    it('an empty tenant has nothing to report', async () => {
      expect(await emptyTenant().analysis.summarize(['case_a1', 'case_a2'])).toEqual([]);
    });
  });

  describe('[NFR-REL-01] AnalysisRepository.summarize is bounded and cheap', () => {
    it('accepts exactly 200 ids and rejects more, counting duplicates, with a clear error', async () => {
      const many = Array.from({ length: MAX_SUMMARY_CASES }, (_, index) => `case_none_${index}`);
      expect(await contoso().analysis.summarize(many)).toEqual([]);

      const tooMany = [...many, 'case_a1'];
      const rejection = contoso().analysis.summarize(tooMany);
      await expect(rejection).rejects.toMatchObject({
        code: 'validation_failed',
        message: expect.stringContaining('200'),
        issues: [expect.objectContaining({ path: 'caseIds' })],
      });
      await expect(
        contoso().analysis.summarize(Array.from({ length: 201 }, () => 'case_a1')),
      ).rejects.toMatchObject({ code: 'validation_failed' });
      expect(MAX_SUMMARY_CASES).toBe(200);
    });

    it.each([
      ['a number', 42],
      ['null', null],
      ['an empty string', ''],
      ['an id over 120 characters', 'x'.repeat(121)],
      ['an id with a control character', 'case_a1\u0000'],
    ])('rejects %s among the ids and names its position', async (_label, bad) => {
      await expect(
        contoso().analysis.summarize(['case_a1', bad as unknown as string]),
      ).rejects.toMatchObject({
        code: 'validation_failed',
        issues: [expect.objectContaining({ path: 'caseIds.1' })],
      });
    });

    it('rejects something that is not a list', async () => {
      await expect(
        contoso().analysis.summarize('case_a1' as unknown as string[]),
      ).rejects.toMatchObject({ code: 'validation_failed' });
    });

    it('reads the whole list with ONE statement, however many ids there are', async () => {
      for (const count of [1, 2, 50, 200]) {
        const { repos, statements } = recorded();
        const requested = Array.from({ length: count }, (_, index) =>
          index === 0 ? 'case_a1' : `case_x_${index}`,
        );
        const summaries = await repos.analysis.summarize(requested);
        expect(summaries.map((s) => s.caseId)).toEqual(['case_a1']);
        expect(statements).toHaveLength(1);
        expect(statements[0]?.text).toBe(SUMMARY_SQL);
        expect(statements[0]?.params).toEqual([TENANT_A, requested]);
      }
      // An empty list does not even reach the database.
      const { repos, statements } = recorded();
      await repos.analysis.summarize([]);
      expect(statements).toHaveLength(0);
    });
  });

  describe('[FR-LQ-01] AnalysisRepository.listOpenWarnings', () => {
    it('ranks open warnings across all cases: severity first, then most recently raised', async () => {
      const warnings = await contoso().analysis.listOpenWarnings({ limit: 100 });
      // critical: w5 (raised at 60) before w2 (10); high: w1 (30) before w6 (5); then medium, then low.
      expect(ids(warnings)).toEqual(['w5', 'w2', 'w1', 'w6', 'w8', 'w7']);
      expect(warnings.map((w) => `${w.caseId}:${w.priority}`)).toEqual([
        'case_a2:critical',
        'case_a1:critical',
        'case_a1:high',
        'case_a2:high',
        'case_a2:medium',
        'case_a2:low',
      ]);
      expect(warnings.every((w) => w.state === 'open')).toBe(true);
      for (const item of warnings) expect(CaseWarningSchema.safeParse(item).success).toBe(true);
    });

    it('leaves out dismissed and resolved warnings and matches the per-case lists', async () => {
      const all = await contoso().analysis.listOpenWarnings({ limit: 100 });
      expect(ids(all)).not.toContain('w3'); // resolved
      expect(ids(all)).not.toContain('w4'); // dismissed
      const perCase = (
        await Promise.all(
          ['case_a1', 'case_a2', 'case_a3', 'case_a4'].map((caseId) =>
            contoso().analysis.listWarnings(caseId, { state: 'open' }),
          ),
        )
      ).flat();
      expect(ids(all).sort()).toEqual(ids(perCase).sort());
    });

    it('respects the limit and returns the best warnings first', async () => {
      const everything = await contoso().analysis.listOpenWarnings({ limit: MAX_DASHBOARD_LIST });
      for (const limit of [1, 2, 3, 5, 6, 7]) {
        const page = await contoso().analysis.listOpenWarnings({ limit });
        expect(page).toEqual(everything.slice(0, limit));
      }
    });

    it.each([
      ['0', 0],
      ['a negative number', -1],
      ['a fraction', 2.5],
      [`more than ${MAX_DASHBOARD_LIST}`, MAX_DASHBOARD_LIST + 1],
      ['NaN', Number.NaN],
      ['a string', '5' as unknown as number],
    ])('rejects a limit of %s', async (_label, limit) => {
      await expect(contoso().analysis.listOpenWarnings({ limit })).rejects.toMatchObject({
        code: 'validation_failed',
        issues: [expect.objectContaining({ path: 'limit' })],
      });
    });

    it('[NFR-SEC-01] never lists another tenant, and row-level security backs that up', async () => {
      expect(ids(await fabrikam().analysis.listOpenWarnings({ limit: 100 }))).toEqual([
        'fw1',
        'fw2',
      ]);
      expect(ids(await contoso().analysis.listOpenWarnings({ limit: 100 }))).not.toContain('fw1');

      const leaked = await h.database.withTenant(FABRIKAM_SCOPE, (tx) =>
        tx.query(OPEN_WARNINGS_SQL, [TENANT_A, [...WARNING_PRIORITY_ORDER], 100]),
      );
      expect(leaked.rows).toEqual([]);
    });

    it('an empty tenant has no open warnings', async () => {
      expect(await emptyTenant().analysis.listOpenWarnings({ limit: 10 })).toEqual([]);
    });

    it('ranks by the declared severity order and reads with one statement', async () => {
      expect(WARNING_PRIORITY_ORDER).toEqual(['critical', 'high', 'medium', 'low']);
      const { repos, statements } = recorded();
      await repos.analysis.listOpenWarnings({ limit: 5 });
      expect(statements).toHaveLength(1);
      expect(statements[0]?.text).toBe(OPEN_WARNINGS_SQL);
      expect(statements[0]?.params).toEqual([TENANT_A, ['critical', 'high', 'medium', 'low'], 5]);
    });
  });

  describe('[FR-UX-01] AnalysisRepository.listCriticalMissing', () => {
    it('lists unresolved missing evidence across cases, most critical first, then most recent', async () => {
      const items = await contoso().analysis.listCriticalMissing({ limit: 100 });
      expect(items.map((item) => `${item.caseId}:${item.id}`)).toEqual([
        'case_a1:m_crit_new', // critical, relevant since 80
        'case_a2:m5', // critical, relevant since 70
        'case_a1:m_crit_old', // critical, relevant since 20
        'case_a1:m_important', // important
        'case_a2:m6', // important, older
        'case_a1:m_helpful',
      ]);
      expect(items.every((item) => item.resolvedAt === null)).toBe(true);
      expect(ids(items)).not.toContain('m_crit_done'); // resolved
      for (const item of items) expect(MissingWithCaseSchema.safeParse(item).success).toBe(true);
    });

    it('can be narrowed to the most critical items', async () => {
      const critical = await contoso().analysis.listCriticalMissing({
        limit: 100,
        minCriticality: 'critical',
      });
      expect(ids(critical)).toEqual(['m_crit_new', 'm5', 'm_crit_old']);
      const important = await contoso().analysis.listCriticalMissing({
        limit: 100,
        minCriticality: 'important',
      });
      expect(ids(important)).toEqual(['m_crit_new', 'm5', 'm_crit_old', 'm_important', 'm6']);
      const everything = await contoso().analysis.listCriticalMissing({
        limit: 100,
        minCriticality: 'helpful',
      });
      expect(ids(everything)).toHaveLength(6);
      await expect(
        contoso().analysis.listCriticalMissing({
          limit: 10,
          minCriticality: 'urgent' as unknown as 'critical',
        }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
    });

    it('respects the limit and returns the best items first', async () => {
      const everything = await contoso().analysis.listCriticalMissing({
        limit: MAX_DASHBOARD_LIST,
      });
      for (const limit of [1, 2, 3, 5, 6, 7]) {
        expect(await contoso().analysis.listCriticalMissing({ limit })).toEqual(
          everything.slice(0, limit),
        );
      }
    });

    it.each([
      ['0', 0],
      ['a negative number', -3],
      ['a fraction', 1.5],
      [`more than ${MAX_DASHBOARD_LIST}`, MAX_DASHBOARD_LIST + 1],
      ['a string', '5' as unknown as number],
    ])('rejects a limit of %s', async (_label, limit) => {
      await expect(contoso().analysis.listCriticalMissing({ limit })).rejects.toMatchObject({
        code: 'validation_failed',
        issues: [expect.objectContaining({ path: 'limit' })],
      });
    });

    it('[NFR-SEC-01] never lists another tenant, and row-level security backs that up', async () => {
      const theirs = await fabrikam().analysis.listCriticalMissing({ limit: 100 });
      expect(theirs.map((item) => `${item.caseId}:${item.id}`)).toEqual([
        'case_a1:fm1',
        'case_b1:fm2',
      ]);
      expect(ids(await contoso().analysis.listCriticalMissing({ limit: 100 }))).not.toContain(
        'fm1',
      );

      const leaked = await h.database.withTenant(FABRIKAM_SCOPE, (tx) =>
        tx.query(CRITICAL_MISSING_SQL, [TENANT_A, [...MISSING_CRITICALITY_ORDER], 100]),
      );
      expect(leaked.rows).toEqual([]);
    });

    it('an empty tenant has none, and one statement reads the whole list', async () => {
      expect(await emptyTenant().analysis.listCriticalMissing({ limit: 10 })).toEqual([]);
      expect(MISSING_CRITICALITY_ORDER).toEqual(['critical', 'important', 'helpful']);
      const { repos, statements } = recorded();
      await repos.analysis.listCriticalMissing({ limit: 4, minCriticality: 'important' });
      expect(statements).toHaveLength(1);
      expect(statements[0]?.text).toBe(CRITICAL_MISSING_SQL);
      expect(statements[0]?.params).toEqual([TENANT_A, ['critical', 'important'], 4]);
    });
  });

  describe('[FR-HY-02] AnalysisRepository.getHypothesis', () => {
    it('returns the stored hypothesis of that case, validated', async () => {
      const listed = await contoso().analysis.listHypotheses('case_a1');
      expect(listed).toHaveLength(2);
      for (const hypothesis of listed) {
        expect(await contoso().analysis.getHypothesis('case_a1', hypothesis.id)).toEqual(
          hypothesis,
        );
      }
      expect(
        (await contoso().analysis.getHypothesis('case_a1', 'hyp_case_a1_identity'))?.name,
      ).toBe('Identity provider outage');
    });

    it('returns null for an unknown id, for a hypothesis of another case, and for nonsense', async () => {
      expect(await contoso().analysis.getHypothesis('case_a1', 'hyp_missing')).toBeNull();
      expect(await contoso().analysis.getHypothesis('case_a1', 'hyp_case_a2_proxy')).toBeNull();
      expect(
        await contoso().analysis.getHypothesis('case_missing', 'hyp_case_a1_proxy'),
      ).toBeNull();
      expect(await contoso().analysis.getHypothesis('', '')).toBeNull();
      expect(await contoso().analysis.getHypothesis('case_a1', "x' OR '1'='1")).toBeNull();
      // A case that exists but was never analysed has no hypotheses.
      expect(await contoso().analysis.getHypothesis('case_a3', 'hyp_case_a3_proxy')).toBeNull();
    });

    it('[NFR-SEC-01] the same ids in two tenants are two different hypotheses', async () => {
      const mine = await contoso().analysis.getHypothesis('case_a1', 'hyp_case_a1_proxy');
      const theirs = await fabrikam().analysis.getHypothesis('case_a1', 'hyp_case_a1_proxy');
      expect(mine).toMatchObject({
        tenantId: TENANT_A,
        name: 'Proxy rule blocks the sign-in endpoint',
      });
      expect(theirs).toMatchObject({ tenantId: TENANT_B, name: 'Fabrikam proxy hypothesis' });
      // Fabrikam's case_b1 hypotheses do not exist for Contoso, and the empty tenant sees nothing.
      expect(await contoso().analysis.getHypothesis('case_b1', 'hyp_case_b1_proxy')).toBeNull();
      expect(await emptyTenant().analysis.getHypothesis('case_a1', 'hyp_case_a1_proxy')).toBeNull();
    });

    it('[NFR-SEC-01] row-level security alone hides the hypothesis from another tenant', async () => {
      const { repos, statements } = recorded();
      expect(await repos.analysis.getHypothesis('case_a1', 'hyp_case_a1_proxy')).not.toBeNull();
      const statement = onlyStatement(statements);
      // The statement the repository really runs, handed Contoso's tenant id but executed as Fabrikam.
      const crossTenant = await h.database.withTenant(FABRIKAM_SCOPE, (tx) =>
        tx.query(statement.text, statement.params),
      );
      expect(crossTenant.rows).toEqual([]);
      const own = await h.database.withTenant(CONTOSO_SCOPE, (tx) =>
        tx.query(statement.text, statement.params),
      );
      expect(own.rows).toHaveLength(1);
    });
  });

  describe('[FR-UX-01] CaseRepository.counts', () => {
    it('counts the tenant: all cases, the synthetic ones, and every analysis state', async () => {
      expect(await contoso().cases.counts()).toEqual({
        total: 4,
        synthetic: 4,
        byAnalysisState: { not_analyzed: 1, queued: 1, running: 0, analyzed: 2, failed: 0 },
      });
      expect(await fabrikam().cases.counts()).toEqual({
        total: 2,
        synthetic: 2,
        byAnalysisState: { not_analyzed: 0, queued: 0, running: 0, analyzed: 2, failed: 0 },
      });
    });

    it('[NFR-SEC-01] an empty tenant has all zeros, with every state present, and reads with one statement', async () => {
      expect(await emptyTenant().cases.counts()).toEqual({
        total: 0,
        synthetic: 0,
        byAnalysisState: { not_analyzed: 0, queued: 0, running: 0, analyzed: 0, failed: 0 },
      });
      const { repos, statements } = recorded(EMPTY_TENANT);
      const counts = await repos.cases.counts();
      expect(Object.keys(counts.byAnalysisState).sort()).toEqual(
        [...AnalysisStateSchema.options].sort(),
      );
      expect(statements).toHaveLength(1);
      expect(statements[0]?.params).toEqual([EMPTY_TENANT.tenantId]);
    });

    it('[NFR-SEC-01] row-level security alone confines the counting statement to one tenant', async () => {
      const { repos, statements } = recorded();
      await repos.cases.counts();
      const statement = onlyStatement(statements);
      // The statement the repository really runs, handed Contoso's tenant id but executed as Fabrikam.
      const crossTenant = await h.database.withTenant(FABRIKAM_SCOPE, (tx) =>
        tx.query(statement.text, statement.params),
      );
      expect(crossTenant.rows).toEqual([]);
      const own = await h.database.withTenant(CONTOSO_SCOPE, (tx) =>
        tx.query(statement.text, statement.params),
      );
      expect(own.rows.length).toBeGreaterThan(0);
    });
  });

  /** Tenant sessions that skip the role switch: the connecting user is a superuser here, so no policy applies. */
  function withoutRowLevelSecurity(scope: TenantScope) {
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

  describe('[NFR-SEC-01] the statements filter by tenant themselves, without relying on row-level security', () => {
    // Skipped (not failed) on a server where the connecting user is subject to row-level security.
    async function unprotected(skip: () => never, scope: TenantScope) {
      const role = await h.database.query<{ bypass: boolean }>(
        'SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user',
      );
      if (role.rows[0]?.bypass !== true) skip();
      return withoutRowLevelSecurity(scope);
    }

    it('the harness really sees both tenants at once, so only the statements can tell them apart', async ({
      skip,
    }) => {
      await unprotected(skip, CONTOSO_SCOPE);
      const everything = await h.database.transaction((tx) =>
        tx.query<{ tenant_id: string; n: number }>(
          'SELECT tenant_id, count(*)::int AS n FROM cases GROUP BY tenant_id ORDER BY tenant_id',
        ),
      );
      expect(everything.rows).toEqual([
        { tenant_id: TENANT_A, n: 4 },
        { tenant_id: TENANT_B, n: 2 },
      ]);
    });

    it('summarize and getHypothesis answer for the calling tenant only, though both have a case_a1', async ({
      skip,
    }) => {
      const mine = await unprotected(skip, CONTOSO_SCOPE);
      const theirs = await unprotected(skip, FABRIKAM_SCOPE);
      expect(await mine.analysis.summarize(['case_a1', 'case_b1'])).toMatchObject([
        { caseId: 'case_a1', qualityIndex: 81.5 },
      ]);
      expect(await theirs.analysis.summarize(['case_a1', 'case_a2'])).toMatchObject([
        { caseId: 'case_a1', qualityIndex: 33 },
      ]);
      expect(await mine.analysis.getHypothesis('case_a1', 'hyp_case_a1_proxy')).toMatchObject({
        tenantId: TENANT_A,
      });
      expect(await theirs.analysis.getHypothesis('case_a1', 'hyp_case_a1_proxy')).toMatchObject({
        tenantId: TENANT_B,
      });
      expect(await mine.analysis.getHypothesis('case_b1', 'hyp_case_b1_proxy')).toBeNull();
    });

    it('the tenant-wide lists never contain another tenant’s rows', async ({ skip }) => {
      const mine = await unprotected(skip, CONTOSO_SCOPE);
      const theirs = await unprotected(skip, FABRIKAM_SCOPE);
      expect(ids(await mine.analysis.listOpenWarnings({ limit: 100 }))).toEqual([
        'w5',
        'w2',
        'w1',
        'w6',
        'w8',
        'w7',
      ]);
      expect(ids(await theirs.analysis.listOpenWarnings({ limit: 100 }))).toEqual(['fw1', 'fw2']);
      expect(ids(await mine.analysis.listCriticalMissing({ limit: 100 }))).toHaveLength(6);
      expect(ids(await mine.analysis.listCriticalMissing({ limit: 100 }))).not.toContain('fm1');
      expect(ids(await theirs.analysis.listCriticalMissing({ limit: 100 }))).toEqual([
        'fm1',
        'fm2',
      ]);
    });

    it('counts covers the calling tenant only', async ({ skip }) => {
      const mine = await unprotected(skip, CONTOSO_SCOPE);
      const theirs = await unprotected(skip, FABRIKAM_SCOPE);
      expect((await mine.cases.counts()).total).toBe(4);
      expect((await theirs.cases.counts()).total).toBe(2);
      expect((await withoutRowLevelSecurity(EMPTY_TENANT).cases.counts()).total).toBe(0);
    });
  });
});

// ------------------------------------------------------------------ data that changes

describe('[FR-UX-01] the read models follow the data', () => {
  beforeEach(async () => {
    await h.reset();
    h.clock.set('2026-01-15T09:00:00.000Z');
  });

  const shape = (overrides: Partial<AnalysisShape> = {}): AnalysisShape => ({
    qualityScore: 70,
    ase: 25,
    confidences: [0.6, 0.2],
    warnings: [],
    missing: [],
    ...overrides,
  });

  it('a re-analysis replaces the summary, the warnings and the missing evidence', async () => {
    const input = ingestInput('case_live');
    await analyse(
      'contoso',
      input,
      shape({
        qualityScore: 40,
        ase: 50,
        confidences: [0.6, 0.2],
        warnings: [warning(TENANT_A, 'case_live', 'old_w', 'critical', 10)],
        missing: [missing('old_m', 'critical', 10)],
      }),
    );
    expect(await contoso().analysis.summarize(['case_live'])).toMatchObject([
      { qualityIndex: 40, avoidableEffortPct: 50, openWarningCount: 1 },
    ]);

    await contoso().analysis.saveSnapshot(
      snapshotFor(
        input,
        shape({
          qualityScore: 88,
          ase: 9,
          confidences: [0.1, 0.8],
          names: ['First after rerun', 'Second after rerun'],
          warnings: [
            warning(TENANT_A, 'case_live', 'new_w1', 'low', 20, 'open', 1, 2),
            warning(TENANT_A, 'case_live', 'new_w2', 'medium', 30, 'open', 2, 2),
          ],
          missing: [missing('new_m', 'helpful', 20)],
        }),
        'run_case_live_2',
      ),
    );
    expect(await contoso().analysis.summarize(['case_live'])).toEqual([
      {
        caseId: 'case_live',
        qualityIndex: 88,
        avoidableEffortPct: 9,
        leadingHypothesis: { name: 'Second after rerun', confidence: 0.8 },
        openWarningCount: 2,
      },
    ]);
    expect(ids(await contoso().analysis.listOpenWarnings({ limit: 10 }))).toEqual([
      'new_w2',
      'new_w1',
    ]);
    expect(ids(await contoso().analysis.listCriticalMissing({ limit: 10 }))).toEqual(['new_m']);
  });

  it('a case being re-analysed keeps showing its last analysis until the new one is saved', async () => {
    await analyse('contoso', ingestInput('case_busy'), shape({ qualityScore: 61 }));
    await contoso().cases.setAnalysisState('case_busy', 'running');
    expect(await contoso().analysis.summarize(['case_busy'])).toMatchObject([
      { qualityIndex: 61, avoidableEffortPct: 25 },
    ]);
    expect((await contoso().cases.counts()).byAnalysisState).toMatchObject({
      running: 1,
      analyzed: 0,
    });
  });

  it('dismissing a warning removes it from the count and from the open list at once', async () => {
    const input = ingestInput('case_dismiss');
    await analyse(
      'contoso',
      input,
      shape({
        warnings: [
          warning(TENANT_A, 'case_dismiss', 'd1', 'high', 10),
          warning(TENANT_A, 'case_dismiss', 'd2', 'low', 20),
        ],
      }),
    );
    expect((await contoso().analysis.summarize(['case_dismiss']))[0]?.openWarningCount).toBe(2);
    await contoso().analysis.dismissWarning('case_dismiss', 'd1', {
      by: 'user_riley_reviewer',
      at: '2026-01-15T10:00:00.000Z',
      reason: 'Confirmed with the customer',
      expectedVersion: 1,
    });
    expect((await contoso().analysis.summarize(['case_dismiss']))[0]?.openWarningCount).toBe(1);
    expect(ids(await contoso().analysis.listOpenWarnings({ limit: 10 }))).toEqual(['d2']);
  });

  it('only the latest run counts: rows left over from an earlier run are ignored', async () => {
    const input = ingestInput('case_runs');
    await analyse(
      'contoso',
      input,
      shape({ missing: [missing('m_first', 'critical', 10)], qualityScore: 30 }),
    );
    await contoso().analysis.saveSnapshot(
      snapshotFor(
        input,
        shape({ missing: [missing('m_second', 'critical', 20)], qualityScore: 50 }),
        'run_case_runs_2',
      ),
    );
    // Both runs exist in the history. Plant rows of the OLD run next to the new ones, as a stale
    // writer or a partial failure could: they must not show up anywhere.
    await h.database.query(`
      INSERT INTO missing_evidence (tenant_id, case_id, id, analysis_run_id, requirement_id, criticality,
        category, first_relevant_at, resolved_at, ordinal, created_at, data)
      SELECT tenant_id, case_id, 'm_stale', 'run_case_runs_1', requirement_id, criticality, category,
             first_relevant_at + interval '1 hour', NULL, ordinal + 10, created_at, data
        FROM missing_evidence WHERE case_id = 'case_runs' AND id = 'm_second'`);
    await h.database.query(`
      INSERT INTO quality_assessments (tenant_id, case_id, id, analysis_run_id, as_of, composite_score,
        composite_low, composite_high, band, created_at, updated_at, created_by, version, data)
      SELECT tenant_id, case_id, 'qa_stale', 'run_case_runs_1', as_of, 99.9, composite_low, composite_high,
             band, created_at + interval '1 day', updated_at, created_by, version, data
        FROM quality_assessments WHERE case_id = 'case_runs'`);
    await h.database.query(`
      INSERT INTO hypotheses (tenant_id, case_id, id, analysis_run_id, key, name, category, prior,
        current_confidence, current_status, ordinal, created_at, updated_at, created_by, version, data)
      SELECT tenant_id, case_id, 'hyp_stale', 'run_case_runs_1', key || '.stale', 'Stale hypothesis', category,
             prior, 0.99, current_status, 0, created_at, updated_at, created_by, version, data
        FROM hypotheses WHERE case_id = 'case_runs' LIMIT 1`);

    // The planted rows really are there (and the old run's own rows were replaced by the re-analysis).
    const rowsOf = async (table: string) =>
      (
        await h.database.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${table} WHERE case_id = 'case_runs'`,
        )
      ).rows[0]?.n;
    expect(await rowsOf('missing_evidence')).toBe(2);
    expect(await rowsOf('quality_assessments')).toBe(2);
    expect(await rowsOf('hypotheses')).toBe(3);
    expect(ids(await contoso().analysis.listCriticalMissing({ limit: 10 }))).toEqual(['m_second']);
    expect(await contoso().analysis.summarize(['case_runs'])).toMatchObject([
      {
        qualityIndex: 50,
        leadingHypothesis: { name: 'Proxy rule blocks the sign-in endpoint', confidence: 0.6 },
      },
    ]);
  });

  it('equal rank is settled by rank, then case id, then id, so the order never wobbles', async () => {
    for (const caseId of ['case_t2', 'case_t1']) {
      await analyse(
        'contoso',
        ingestInput(caseId),
        shape({
          warnings: [
            warning(TENANT_A, caseId, 'tie_b', 'critical', 10, 'open', 2),
            warning(TENANT_A, caseId, 'tie_a', 'critical', 10, 'open', 2),
            warning(TENANT_A, caseId, 'tie_first', 'critical', 10, 'open', 1),
          ],
          missing: [missing('tie_b', 'critical', 10), missing('tie_a', 'critical', 10)],
        }),
      );
    }
    const warnings = await contoso().analysis.listOpenWarnings({ limit: 10 });
    expect(warnings.map((w) => `${w.caseId}:${w.id}`)).toEqual([
      'case_t1:tie_first',
      'case_t2:tie_first',
      'case_t1:tie_a',
      'case_t1:tie_b',
      'case_t2:tie_a',
      'case_t2:tie_b',
    ]);
    const missingItems = await contoso().analysis.listCriticalMissing({ limit: 10 });
    expect(missingItems.map((m) => `${m.caseId}:${m.id}`)).toEqual([
      'case_t1:tie_a',
      'case_t1:tie_b',
      'case_t2:tie_a',
      'case_t2:tie_b',
    ]);
    expect(await contoso().analysis.listOpenWarnings({ limit: 10 })).toEqual(warnings);
  });

  it('erasing a case removes it from every read model', async () => {
    const input = ingestInput('case_erase');
    await analyse(
      'contoso',
      input,
      shape({
        warnings: [warning(TENANT_A, 'case_erase', 'e1', 'critical', 10)],
        missing: [missing('e_m', 'critical', 10)],
      }),
    );
    expect((await contoso().cases.counts()).total).toBe(1);
    expect(await contoso().cases.delete('case_erase')).toBe(true);
    expect(await contoso().analysis.summarize(['case_erase'])).toEqual([]);
    expect(await contoso().analysis.listOpenWarnings({ limit: 10 })).toEqual([]);
    expect(await contoso().analysis.listCriticalMissing({ limit: 10 })).toEqual([]);
    expect(await contoso().analysis.getHypothesis('case_erase', 'hyp_case_erase_proxy')).toBeNull();
    expect((await contoso().cases.counts()).total).toBe(0);
  });

  it('counts follow ingestion, analysis states, the synthetic flag and erasure', async () => {
    expect(await contoso().cases.counts()).toEqual({
      total: 0,
      synthetic: 0,
      byAnalysisState: { not_analyzed: 0, queued: 0, running: 0, analyzed: 0, failed: 0 },
    });
    await contoso().cases.ingest(ingestInput('c_synthetic_1', TENANT_A, true));
    await contoso().cases.ingest(ingestInput('c_synthetic_2', TENANT_A, true));
    await contoso().cases.ingest(ingestInput('c_real_1', TENANT_A, false));
    await contoso().cases.ingest(ingestInput('c_real_2', TENANT_A, false));
    await contoso().cases.ingest(ingestInput('c_real_3', TENANT_A, false));
    await fabrikam().cases.ingest(ingestInput('c_other', TENANT_B, false));
    expect(await contoso().cases.counts()).toMatchObject({
      total: 5,
      synthetic: 2,
      byAnalysisState: { not_analyzed: 5 },
    });

    await contoso().cases.setAnalysisState('c_synthetic_1', 'queued');
    await contoso().cases.setAnalysisState('c_synthetic_2', 'running');
    await contoso().cases.setAnalysisState('c_real_1', 'failed');
    await contoso().analysis.saveSnapshot(
      snapshotFor(ingestInput('c_real_2', TENANT_A, false), shape()),
    );
    const counts = await contoso().cases.counts();
    expect(counts).toEqual({
      total: 5,
      synthetic: 2,
      byAnalysisState: { not_analyzed: 1, queued: 1, running: 1, analyzed: 1, failed: 1 },
    });
    expect(Object.values(counts.byAnalysisState).reduce((a, b) => a + b, 0)).toBe(counts.total);

    expect(await contoso().cases.delete('c_real_3')).toBe(true);
    expect(await contoso().cases.counts()).toMatchObject({
      total: 4,
      byAnalysisState: { not_analyzed: 0 },
    });
    // The other tenant is untouched by all of it.
    expect(await fabrikam().cases.counts()).toMatchObject({ total: 1, synthetic: 0 });
  });
});

describe('[FR-UX-01] the open-item indexes serve the tenant-wide lists', () => {
  beforeEach(async () => {
    await h.reset();
  });

  /** Many cases with mostly closed items, written directly (the lists are not read through the repositories). */
  async function bulkLoad(cases: number): Promise<void> {
    await h.database.query(`
      INSERT INTO cases (tenant_id, id, reference, title, product, workload, severity, status, customer_alias,
        opened_at, synthetic, tags, event_count, source_id, source_kind, content_hash, redaction_applied,
        redaction_replacements, injection_detected, has_resolution, analysis_state, last_analysis_run_id,
        created_at, updated_at, created_by, data)
      SELECT '${TENANT_A}', 'bulk' || g, 'CG-' || g, 'Case ' || g, 'p', 'w', 'B', 'open', 'alias', now(), true,
             '{}', 0, 'src', 'json_bundle', 'h' || g, false, 0, false, false, 'analyzed', 'run_1', now(), now(),
             'x', '{}'::jsonb
        FROM generate_series(1, ${cases}) g`);
    await h.database.query(`
      INSERT INTO analysis_runs (tenant_id, case_id, id, status, provider, model, input_hash, started_at,
        completed_at, created_at, updated_at, created_by, data)
      SELECT '${TENANT_A}', 'bulk' || g, 'run_1', 'succeeded', 'p', 'm', 'h', now(), now(), now(), now(), 'x',
             '{}'::jsonb
        FROM generate_series(1, ${cases}) g`);
    await h.database.query(`
      INSERT INTO case_warnings (tenant_id, case_id, id, analysis_run_id, rule_id, category, priority, rank,
        fingerprint, raised_at, state, created_at, updated_at, created_by, data)
      SELECT '${TENANT_A}', 'bulk' || g, 'w' || k, 'run_1', 'r' || k, 'scoping',
             (ARRAY['critical','high','medium','low'])[1 + (g + k) % 4], k, 'f' || k,
             now() - ((g * 7 + k) || ' minutes')::interval,
             CASE WHEN (g + k) % 20 = 0 THEN 'open' ELSE 'dismissed' END, now(), now(), 'x', '{}'::jsonb
        FROM generate_series(1, ${cases}) g, generate_series(1, 5) k`);
    await h.database.query(`
      INSERT INTO missing_evidence (tenant_id, case_id, id, analysis_run_id, requirement_id, criticality,
        category, first_relevant_at, resolved_at, ordinal, created_at, data)
      SELECT '${TENANT_A}', 'bulk' || g, 'm' || k, 'run_1', 'req' || k,
             (ARRAY['critical','important','helpful'])[1 + (g + k) % 3], 'evidence',
             now() - ((g * 5 + k) || ' minutes')::interval,
             CASE WHEN (g + k) % 20 = 0 THEN NULL ELSE now() END, k, now(), '{}'::jsonb
        FROM generate_series(1, ${cases}) g, generate_series(1, 3) k`);
    for (const table of ['cases', 'case_warnings', 'missing_evidence']) {
      await h.database.query(`ANALYZE ${table}`);
    }
  }

  async function plan(sql: string, params: unknown[]): Promise<string> {
    // As the application role, so row-level security is in play. Sequential scans are switched off
    // so the planner has to choose between the indexes that exist.
    return h.database.withTenant(CONTOSO_SCOPE, async (tx) => {
      await tx.query('SET LOCAL enable_seqscan = off');
      const result = await tx.query<Record<string, string>>(`EXPLAIN ${sql}`, params);
      return result.rows.map((row) => Object.values(row)[0]).join('\n');
    });
  }

  it('open warnings and unresolved missing evidence are found through their partial indexes', async () => {
    await bulkLoad(1500);
    const warnings = await plan(OPEN_WARNINGS_SQL, [TENANT_A, [...WARNING_PRIORITY_ORDER], 20]);
    expect(warnings).toContain('case_warnings_open_idx');
    const missingPlan = await plan(CRITICAL_MISSING_SQL, [
      TENANT_A,
      [...MISSING_CRITICALITY_ORDER],
      20,
    ]);
    expect(missingPlan).toContain('missing_evidence_open_idx');

    // And the lists really are small: only the open items were ever candidates.
    const open = await h.database.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM case_warnings WHERE state = 'open'",
    );
    expect(open.rows[0]?.n).toBe(375);
  });
});
