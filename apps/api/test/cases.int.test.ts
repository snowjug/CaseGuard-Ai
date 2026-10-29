import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CaseDetailSchema, CaseSummarySchema, PageQuerySchema } from '@caseguard/schemas';
import { MAX_SUMMARY_CASES, type Database } from '../src/db';
import { SUMMARY_SQL } from '../src/db/repositories/analysis-read-models';
import { TEST_DATABASE_STARTUP_TIMEOUT_MS } from '../src/db/testing';
import { buildIngestInput, buildSnapshot } from './builders';
import {
  FOLLOWUP_SOURCE,
  SAMPLE_SOURCE,
  auditOf,
  createCase,
  openHarness,
  openWarmDatabase,
  resetDatabase,
  storedObjects,
  withStatementLog,
} from './ingestion-support';
import { CONTOSO, FABRIKAM, PERSONAS, type ApiResponse, type Harness } from './support/app-harness';
import { fakeJob } from './support/fixtures';

let database: Database;
const harnesses: Harness[] = [];

beforeAll(async () => {
  database = await openWarmDatabase();
}, TEST_DATABASE_STARTUP_TIMEOUT_MS);

afterAll(async () => {
  for (const h of harnesses) await h.close();
  await database.close();
});

beforeEach(() => resetDatabase(database));

const list = (h: Harness, persona: string | null, query = ''): Promise<ApiResponse> =>
  h.call(persona, { method: 'GET', url: `/api/v1/cases${query}` });
const get = (h: Harness, persona: string | null, caseId: string): Promise<ApiResponse> =>
  h.call(persona, { method: 'GET', url: `/api/v1/cases/${caseId}` });
const remove = (h: Harness, persona: string | null, caseId: string): Promise<ApiResponse> =>
  h.call(persona, { method: 'DELETE', url: `/api/v1/cases/${caseId}` });

/** Both samples, created through the route (Case One opened 2026-03-09, Case Two 2026-04-14). */
async function createBothSamples(h: Harness): Promise<{ one: string; two: string }> {
  const one = await createCase(h, PERSONAS.engineer, SAMPLE_SOURCE);
  const two = await createCase(h, PERSONAS.engineer, FOLLOWUP_SOURCE);
  return { one: one.data.case.id, two: two.data.case.id };
}

/** A case with a stored analysis (inserted through the repositories, as the analysis service would). */
async function seedAnalysed(h: Harness, caseId: string, reference: string) {
  const repos = h.repos(CONTOSO);
  const input = buildIngestInput({ tenantId: CONTOSO, caseId, reference, receivedSeed: reference });
  await repos.cases.ingest(input);
  await repos.analysis.saveSnapshot(buildSnapshot(input));
  return input;
}

describe('cases.list', () => {
  it('returns an empty page, requires case:read and is open to a manager', async () => {
    const { h } = await openHarness(database, harnesses);
    const empty = await list(h, PERSONAS.engineer);
    expect(empty.statusCode).toBe(200);
    expect(empty.data).toEqual({ items: [], nextCursor: null });
    expect((await list(h, null)).statusCode).toBe(401);
    expect((await list(h, PERSONAS.manager)).statusCode).toBe(200);
  });

  it('[FR-ING-01] lists cases newest first with the summary shape and no analysis figures yet', async () => {
    const { h } = await openHarness(database, harnesses);
    const ids = await createBothSamples(h);
    const res = await list(h, PERSONAS.engineer);
    expect(res.statusCode).toBe(200);
    expect(res.data.items.map((item: { id: string }) => item.id)).toEqual([ids.two, ids.one]);
    for (const item of res.data.items) expect(CaseSummarySchema.safeParse(item).success).toBe(true);
    expect(res.data.items[1]).toMatchObject({
      reference: 'CG-SYN-1001',
      eventCount: 31,
      severity: 'A',
      status: 'resolved',
      synthetic: true,
      hasResolution: true,
      injectionDetected: false,
      analysisState: 'not_analyzed',
      analyzedAt: null,
      qualityIndex: null,
      avoidableEffortPct: null,
      leadingHypothesis: null,
      openWarningCount: 0,
    });
    expect(res.data.items[0]).toMatchObject({ reference: 'CG-SYN-1002', eventCount: 15 });
  });

  it('adds the figures of the latest analysis (estimates) to analysed cases', async () => {
    const { h } = await openHarness(database, harnesses);
    await seedAnalysed(h, 'case_analysed', 'CG-AN-1001');
    const repos = h.repos(CONTOSO);
    const open = await repos.analysis.listWarnings('case_analysed', { state: 'open' });
    const res = await list(h, PERSONAS.engineer);
    expect(res.statusCode).toBe(200);
    expect(res.data.items[0]).toMatchObject({
      id: 'case_analysed',
      analysisState: 'analyzed',
      qualityIndex: 72,
      avoidableEffortPct: 31,
      leadingHypothesis: { confidence: 0.6 },
      openWarningCount: open.length,
    });
    expect(res.data.items[0].leadingHypothesis.name).toEqual(expect.any(String));
  });

  it('fills a whole page with one analysis statement, however many cases it holds', async () => {
    const log = withStatementLog(database);
    const { h } = await openHarness(log, harnesses);
    const summaryReads = () => log.statements.filter((statement) => statement.sql === SUMMARY_SQL);
    const fullPage = `?limit=${MAX_SUMMARY_CASES}`;

    await seedAnalysed(h, 'case_page_1', 'CG-PG-1001');
    await list(h, PERSONAS.engineer); // the first request of a user also records the sign-in
    log.clear();
    const one = await list(h, PERSONAS.engineer, fullPage);
    expect(one.data.items).toHaveLength(1);
    expect(summaryReads()).toHaveLength(1);
    const statementsForOneCase = log.statements.length;

    for (const n of [2, 3, 4, 5, 6, 7]) await seedAnalysed(h, `case_page_${n}`, `CG-PG-100${n}`);
    log.clear();
    const page = await list(h, PERSONAS.engineer, fullPage);
    const ids = page.data.items.map((item: { id: string }) => item.id);
    expect(page.statusCode).toBe(200);
    expect(ids).toHaveLength(7);
    expect(summaryReads()).toHaveLength(1);
    expect(summaryReads()[0]?.params[1]).toEqual(ids);
    expect(log.statements.length).toBe(statementsForOneCase);
    for (const item of page.data.items) {
      expect(item).toMatchObject({ qualityIndex: 72, avoidableEffortPct: 31 });
    }
  });

  it('keeps the largest list page within what one summarize call accepts', () => {
    expect(PageQuerySchema.safeParse({ limit: MAX_SUMMARY_CASES }).success).toBe(true);
    expect(PageQuerySchema.safeParse({ limit: MAX_SUMMARY_CASES + 1 }).success).toBe(false);
  });

  it('filters by status, workload, analysis state and text', async () => {
    const { h } = await openHarness(database, harnesses);
    const ids = await createBothSamples(h);
    const idsOf = (res: ApiResponse): string[] =>
      (res.data as { items: { id: string }[] }).items.map((item) => item.id);
    expect(idsOf(await list(h, PERSONAS.engineer, '?status=resolved'))).toHaveLength(2);
    expect(idsOf(await list(h, PERSONAS.engineer, '?status=open'))).toEqual([]);
    expect(idsOf(await list(h, PERSONAS.engineer, '?workload=teams-authentication'))).toHaveLength(
      2,
    );
    expect(idsOf(await list(h, PERSONAS.engineer, '?workload=other'))).toEqual([]);
    expect(idsOf(await list(h, PERSONAS.engineer, '?analysisState=not_analyzed'))).toHaveLength(2);
    expect(idsOf(await list(h, PERSONAS.engineer, '?analysisState=analyzed'))).toEqual([]);
    expect(idsOf(await list(h, PERSONAS.engineer, '?q=Rotterdam'))).toEqual([ids.two]);
    expect(idsOf(await list(h, PERSONAS.engineer, '?q=cg-syn-1001'))).toEqual([ids.one]);
  });

  it('paginates with an opaque cursor and rejects bad paging parameters with 422', async () => {
    const { h } = await openHarness(database, harnesses);
    const ids = await createBothSamples(h);
    const first = await list(h, PERSONAS.engineer, '?limit=1');
    expect(first.data.items.map((item: { id: string }) => item.id)).toEqual([ids.two]);
    expect(typeof first.data.nextCursor).toBe('string');
    const second = await list(h, PERSONAS.engineer, `?limit=1&cursor=${first.data.nextCursor}`);
    expect(second.data.items.map((item: { id: string }) => item.id)).toEqual([ids.one]);
    expect(second.data.nextCursor).toBeNull();

    expect((await list(h, PERSONAS.engineer, '?cursor=garbage')).statusCode).toBe(422);
    expect((await list(h, PERSONAS.engineer, '?limit=0')).statusCode).toBe(422);
    expect((await list(h, PERSONAS.engineer, '?limit=201')).statusCode).toBe(422);
    expect((await list(h, PERSONAS.engineer, '?status=bogus')).statusCode).toBe(422);
  });

  it('[NFR-SEC-01] shows each tenant only its own cases', async () => {
    const { h } = await openHarness(database, harnesses);
    const ids = await createBothSamples(h);
    const theirs = await createCase(h, PERSONAS.otherTenantEngineer, SAMPLE_SOURCE);
    const mine = await list(h, PERSONAS.engineer);
    const other = await list(h, PERSONAS.otherTenantEngineer);
    expect(mine.data.items.map((item: { id: string }) => item.id).sort()).toEqual(
      [ids.one, ids.two].sort(),
    );
    expect(other.data.items.map((item: { id: string }) => item.id)).toEqual([theirs.data.case.id]);
  });
});

describe('cases.get', () => {
  it('[FR-ING-07] returns the case with its participants, the source record and the resolution', async () => {
    const { h } = await openHarness(database, harnesses);
    const { one } = await createBothSamples(h);
    const res = await get(h, PERSONAS.engineer, one);
    expect(res.statusCode).toBe(200);
    expect(CaseDetailSchema.safeParse(res.data).success).toBe(true);
    expect(res.data).toMatchObject({
      id: one,
      reference: 'CG-SYN-1001',
      eventCount: 31,
      sourceKind: 'builtin_sample',
      createdBy: PERSONAS.engineer,
      tenantId: CONTOSO,
    });
    expect(res.data.participants).toHaveLength(6);
    expect(res.data.participants[0]).toEqual(
      expect.objectContaining({
        role: expect.any(String),
        alias: expect.any(String),
        eventCount: expect.any(Number),
      }),
    );
    expect(res.data.source).toMatchObject({
      kind: 'builtin_sample',
      fileName: 'case-one-teams-signin-dns.json',
      redactionApplied: false,
      redactionReplacements: 0,
      synthetic: true,
    });
    expect(res.data.source.storageRef).toBeUndefined();
    expect(res.data.resolution).toMatchObject({
      rootCauseHypothesisKey: 'hyp.dns-resolution',
      validation: expect.objectContaining({ outcome: expect.any(String) }),
    });
  });

  it('answers 404 for an unknown case and for another tenant’s case, 401 anonymous, 422 for a bad id', async () => {
    const { h } = await openHarness(database, harnesses);
    const { one } = await createBothSamples(h);
    const missing = await get(h, PERSONAS.engineer, 'case_missing');
    expect(missing.statusCode).toBe(404);
    expect(missing.data.code).toBe('not_found');

    const foreign = await get(h, PERSONAS.otherTenantEngineer, one);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.body).not.toContain('CG-SYN-1001');

    expect((await get(h, null, one)).statusCode).toBe(401);
    expect((await get(h, PERSONAS.manager, one)).statusCode).toBe(200);
    expect((await get(h, PERSONAS.engineer, '%20bad%20id')).statusCode).toBe(422);
  });
});

describe('cases.delete', () => {
  it('[FR-ING-07] erases the case, its derived data and its stored payload, audited and not repeatable', async () => {
    const { h } = await openHarness(database, harnesses);
    const { one, two } = await createBothSamples(h);
    await seedAnalysed(h, 'case_analysed', 'CG-AN-1001');
    const theirs = await createCase(h, PERSONAS.otherTenantEngineer, SAMPLE_SOURCE);
    expect(storedObjects(h)).toHaveLength(3);

    const res = await remove(h, PERSONAS.admin, one);
    expect(res.statusCode).toBe(200);
    expect(res.data).toEqual({ deleted: true });

    const repos = h.repos(CONTOSO);
    expect(await repos.cases.get(one)).toBeNull();
    expect(await repos.cases.getAllEvents(one)).toEqual([]);
    expect(await repos.cases.getSource(one)).toBeNull();
    expect((await get(h, PERSONAS.engineer, one)).statusCode).toBe(404);
    const remaining = (await list(h, PERSONAS.engineer)).data.items.map(
      (item: { id: string }) => item.id,
    );
    expect([...remaining].sort()).toEqual(['case_analysed', two].sort());
    expect(storedObjects(h)).toHaveLength(2);

    const [audit] = await auditOf(h, 'case.deleted');
    expect(audit).toMatchObject({
      actorId: PERSONAS.admin,
      targetType: 'case',
      targetId: one,
      caseId: one,
      outcome: 'success',
      details: {
        reference: 'CG-SYN-1001',
        eventCount: 31,
        participantCount: 6,
        hadAnalysis: false,
        sourceKind: 'builtin_sample',
      },
    });
    expect(await auditOf(h, 'api.cases.delete')).toEqual([]);

    const again = await remove(h, PERSONAS.admin, one);
    expect(again.statusCode).toBe(404);
    expect(await auditOf(h, 'case.deleted')).toHaveLength(1);

    // Another tenant's identical case is untouched.
    expect((await get(h, PERSONAS.otherTenantEngineer, theirs.data.case.id)).statusCode).toBe(200);
  });

  it('removes analysis artefacts together with the case and records that an analysis existed', async () => {
    const { h } = await openHarness(database, harnesses);
    await seedAnalysed(h, 'case_analysed', 'CG-AN-1001');
    const before = await h.infra.database.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM hypotheses WHERE case_id = 'case_analysed'",
    );
    expect(before.rows[0]?.n).toBeGreaterThan(0);

    expect((await remove(h, PERSONAS.admin, 'case_analysed')).statusCode).toBe(200);
    for (const table of [
      'hypotheses',
      'analysis_runs',
      'case_events',
      'case_participants',
      'case_sources',
    ]) {
      const rows = await h.infra.database.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${table} WHERE case_id = 'case_analysed'`,
      );
      expect(rows.rows[0]?.n, table).toBe(0);
    }
    const [audit] = await auditOf(h, 'case.deleted');
    expect(audit?.details.hadAnalysis).toBe(true);
  });

  it('[NFR-SEC-02] needs case:delete: 401 anonymous, 403 (audited) for everyone but an administrator', async () => {
    const { h } = await openHarness(database, harnesses);
    const { one } = await createBothSamples(h);
    expect((await remove(h, null, one)).statusCode).toBe(401);
    for (const persona of [
      PERSONAS.engineer,
      PERSONAS.reviewer,
      PERSONAS.manager,
      PERSONAS.curator,
    ]) {
      expect((await remove(h, persona, one)).statusCode, persona).toBe(403);
    }
    expect((await get(h, PERSONAS.engineer, one)).statusCode).toBe(200);
    const denied = await auditOf(h, 'access.denied');
    expect(denied.filter((event) => event.details.routeId === 'cases.delete')).toHaveLength(4);
  });

  it('refuses with 409 while a job for the case is queued or running, and deletes once it finished', async () => {
    const { h } = await openHarness(database, harnesses);
    const { one } = await createBothSamples(h);
    const jobs = h.repos(CONTOSO).jobs;
    await jobs.create(fakeJob(one, { id: 'job_queued_0001', status: 'queued' }));
    const queued = await remove(h, PERSONAS.admin, one);
    expect(queued.statusCode).toBe(409);
    expect(queued.data.code).toBe('conflict');
    expect(queued.data.detail).toContain('queued or running');
    expect(queued.data.detail).not.toContain(one);

    await jobs.update('job_queued_0001', {
      status: 'running',
      startedAt: '2026-01-15T09:00:01.000Z',
    });
    expect((await remove(h, PERSONAS.admin, one)).statusCode).toBe(409);
    expect((await get(h, PERSONAS.engineer, one)).statusCode).toBe(200);
    expect(await auditOf(h, 'case.deleted')).toEqual([]);
    expect(storedObjects(h)).toHaveLength(2);

    await jobs.update('job_queued_0001', {
      status: 'succeeded',
      completedAt: '2026-01-15T09:00:05.000Z',
      cancellable: false,
    });
    expect((await remove(h, PERSONAS.admin, one)).statusCode).toBe(200);
  });

  it('[NFR-SEC-01] cannot delete another tenant’s case: 404 and the case survives', async () => {
    const { h } = await openHarness(database, harnesses);
    const theirs = await createCase(h, PERSONAS.otherTenantEngineer, SAMPLE_SOURCE);
    const res = await remove(h, PERSONAS.admin, theirs.data.case.id);
    expect(res.statusCode).toBe(404);
    expect((await get(h, PERSONAS.otherTenantEngineer, theirs.data.case.id)).statusCode).toBe(200);
    expect(await auditOf(h, 'case.deleted', FABRIKAM)).toEqual([]);
    expect(storedObjects(h)).toHaveLength(1);
  });
});
