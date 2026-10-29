import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IngestResultSchema, IngestionPreviewSchema } from '@caseguard/schemas';
import type { Database } from '../src/db';
import { TEST_DATABASE_STARTUP_TIMEOUT_MS } from '../src/db/testing';
import { NotImplementedError } from '../src/errors';
import { bundleOf } from './ingestion-fixtures';
import {
  FOLLOWUP_SOURCE,
  SAMPLE_SOURCE,
  auditOf,
  createCase,
  openHarness,
  openWarmDatabase,
  previewCase,
  resetDatabase,
  storedObjects,
} from './ingestion-support';
import { CONTOSO, FABRIKAM, PERSONAS, type Harness } from './support/app-harness';

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

describe('ingestion.preview (FR-ING-02, FR-ING-03)', () => {
  it('[FR-ING-03] previews a sample without persisting anything', async () => {
    const { h, analysis } = await openHarness(database, harnesses);
    const res = await previewCase(h, PERSONAS.engineer, SAMPLE_SOURCE);
    expect(res.statusCode).toBe(200);
    expect(IngestionPreviewSchema.safeParse(res.data).success).toBe(true);
    expect(res.data).toMatchObject({
      ok: true,
      sourceKind: 'builtin_sample',
      synthetic: true,
      alreadyIngestedCaseId: null,
      summary: { reference: 'CG-SYN-1001', eventCount: 31, participantCount: 6 },
    });
    expect(res.data.eventsPreview).toHaveLength(25);
    expect((await h.repos(CONTOSO).cases.list({ limit: 10 })).items).toEqual([]);
    expect(storedObjects(h)).toEqual([]);
    expect(analysis.started).toEqual([]);
  });

  it('[FR-ING-02] reports unreadable pasted text as a normal 200 preview with field-level issues', async () => {
    const { h } = await openHarness(database, harnesses);
    const res = await previewCase(h, PERSONAS.engineer, {
      type: 'paste',
      text: 'no structure at all',
    });
    expect(res.statusCode).toBe(200);
    expect(res.data).toMatchObject({ ok: false, summary: null, eventsPreview: [] });
    expect(res.data.issues[0]).toMatchObject({ severity: 'error', path: '(input)' });
  });

  it('[FR-ING-03] previews pasted text and notes that its synthetic label comes from the workspace', async () => {
    const { h } = await openHarness(database, harnesses);
    const res = await previewCase(h, PERSONAS.engineer, {
      type: 'paste',
      text: '2026-05-05T09:00:00Z - Customer - Teams sign-in fails.\n2026-05-05T09:05:00Z - Engineer - Please send a timestamp.',
      title: 'Sign-in failures at one site',
      workload: 'teams-authentication',
    });
    expect(res.statusCode).toBe(200);
    expect(res.data).toMatchObject({ ok: true, sourceKind: 'pasted_text', synthetic: true });
    expect(res.data.summary).toMatchObject({
      title: 'Sign-in failures at one site',
      eventCount: 2,
    });
    const note = res.data.issues.find((issue: { path: string }) => issue.path === 'synthetic');
    expect(note.message).toContain('labelled synthetic');
  });

  it('[FR-ING-02] refuses a bundle that declares real data in a synthetic workspace, as a failed preview', async () => {
    const { h } = await openHarness(database, harnesses);
    const res = await previewCase(h, PERSONAS.engineer, {
      type: 'bundle',
      bundle: bundleOf({ synthetic: false }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.data.ok).toBe(false);
    expect(res.data.issues[0]).toMatchObject({ path: 'synthetic', severity: 'error' });
  });

  it('[FR-ING-08] tells the caller when identical content is already stored', async () => {
    const { h } = await openHarness(database, harnesses);
    const created = await createCase(h, PERSONAS.engineer, SAMPLE_SOURCE);
    expect(created.statusCode).toBe(201);
    const res = await previewCase(h, PERSONAS.engineer, SAMPLE_SOURCE);
    expect(res.data.alreadyIngestedCaseId).toBe(created.data.case.id);
    // The preview promises exactly what ingestion stored: the content hash is the same.
    const stored = await h.repos(CONTOSO).cases.get(created.data.case.id);
    expect(res.data.contentHash).toBe(stored?.contentHash);
    const other = await previewCase(h, PERSONAS.engineer, FOLLOWUP_SOURCE);
    expect(other.data.alreadyIngestedCaseId).toBeNull();
  });

  it('[NFR-SEC-02] needs case:ingest: 401 anonymous, 403 for manager, reviewer and curator', async () => {
    const { h } = await openHarness(database, harnesses);
    expect((await previewCase(h, null, SAMPLE_SOURCE)).statusCode).toBe(401);
    for (const persona of [PERSONAS.manager, PERSONAS.reviewer, PERSONAS.curator]) {
      const res = await previewCase(h, persona, SAMPLE_SOURCE);
      expect(res.statusCode, persona).toBe(403);
      expect(res.data.code).toBe('forbidden');
    }
  });

  it('[FR-ING-02] validates the request body: unknown source types and missing fields are 422', async () => {
    const { h } = await openHarness(database, harnesses);
    const wrongType = await previewCase(h, PERSONAS.engineer, { type: 'nonsense' });
    expect(wrongType.statusCode).toBe(422);
    const emptyPaste = await previewCase(h, PERSONAS.engineer, { type: 'paste', text: '' });
    expect(emptyPaste.statusCode).toBe(422);
    const noBundle = await previewCase(h, PERSONAS.engineer, { type: 'bundle' });
    expect(noBundle.statusCode).toBe(422);
    const unknownSample = await previewCase(h, PERSONAS.engineer, {
      type: 'sample',
      sampleId: 'nope',
    });
    expect(unknownSample.statusCode).toBe(404);
  });
});

describe('cases.create (FR-ING-01, FR-ING-07, FR-ING-08)', () => {
  it('[FR-ING-01] ingests a sample: immutable records, mirrored payload, audit and an analysis job', async () => {
    const { h, analysis } = await openHarness(database, harnesses);
    const res = await createCase(h, PERSONAS.engineer, SAMPLE_SOURCE);
    expect(res.statusCode).toBe(201);
    expect(IngestResultSchema.safeParse(res.data).success).toBe(true);
    expect(res.data).toMatchObject({
      created: true,
      eventCount: 31,
      case: { reference: 'CG-SYN-1001', eventCount: 31, synthetic: true, hasResolution: true },
      preview: {
        redaction: { applied: false, totalReplacements: 0 },
        injection: { detected: false },
      },
    });
    const caseId: string = res.data.case.id;
    expect(analysis.started).toEqual([caseId]);
    expect(res.data.analysisJob).toMatchObject({ caseId, kind: 'case_analysis' });

    const repos = h.repos(CONTOSO);
    const stored = await repos.cases.get(caseId);
    expect(stored).toMatchObject({
      sourceKind: 'builtin_sample',
      createdBy: PERSONAS.engineer,
      injectionDetected: false,
      redactionApplied: false,
    });
    expect(await repos.cases.getAllEvents(caseId)).toHaveLength(31);
    expect(await repos.cases.getParticipants(caseId)).toHaveLength(6);

    const source = await repos.cases.getSource(caseId);
    expect(source).toMatchObject({
      fileName: 'case-one-teams-signin-dns.json',
      mediaType: 'application/json',
      immutable: true,
      receivedSha256: stored?.contentHash,
      storedSha256: stored?.contentHash,
    });
    const object = await h.infra.objects.get(source?.storageRef ?? '');
    expect(object).not.toBeNull();
    expect(object?.sha256).toBe(source?.storedSha256);
    expect(storedObjects(h)).toHaveLength(1);

    const audit = await auditOf(h, 'case.ingested');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorId: PERSONAS.engineer,
      targetType: 'case',
      targetId: caseId,
      caseId,
      outcome: 'success',
      details: {
        reference: 'CG-SYN-1001',
        eventCount: 31,
        participantCount: 6,
        sourceKind: 'builtin_sample',
        synthetic: true,
        redactionReplacements: 0,
        injectionHighestSeverity: 'none',
        contentHash: stored?.contentHash,
      },
    });
    expect(await auditOf(h, 'api.cases.create')).toEqual([]);
  });

  it('[FR-ING-01] creates from pasted text and from a JSON bundle', async () => {
    const { h } = await openHarness(database, harnesses);
    const pasted = await createCase(h, PERSONAS.engineer, {
      type: 'paste',
      text: '2026-05-05T09:00:00Z - Customer - Teams sign-in fails.\n2026-05-05T09:05:00Z - Engineer - Please send a timestamp.',
      workload: 'teams-authentication',
    });
    expect(pasted.statusCode).toBe(201);
    expect(pasted.data.case.reference).toMatch(/^CG-DRAFT-[A-F0-9]{8}$/);
    expect(pasted.data.eventCount).toBe(2);

    const bundle = await createCase(h, PERSONAS.engineer, { type: 'bundle', bundle: bundleOf() });
    expect(bundle.statusCode).toBe(201);
    expect(bundle.data.case.reference).toBe('CG-TEST-1001');
    expect(
      (await auditOf(h, 'case.ingested')).map((event) => event.details.sourceKind).sort(),
    ).toEqual(['json_bundle', 'pasted_text']);
  });

  it('starts no analysis when options.analyze is false', async () => {
    const { h, analysis } = await openHarness(database, harnesses);
    const res = await createCase(h, PERSONAS.engineer, SAMPLE_SOURCE, { analyze: false });
    expect(res.statusCode).toBe(201);
    expect(res.data.analysisJob).toBeNull();
    expect(analysis.started).toEqual([]);
  });

  it('[FR-ING-08] an identical payload returns the existing case: created false, no job, one case, one object', async () => {
    const { h, analysis } = await openHarness(database, harnesses);
    const first = await createCase(h, PERSONAS.engineer, SAMPLE_SOURCE);
    const again = await createCase(h, PERSONAS.engineer, SAMPLE_SOURCE);
    expect(again.statusCode).toBe(201);
    expect(again.data).toMatchObject({ created: false, analysisJob: null, eventCount: 31 });
    expect(again.data.case.id).toBe(first.data.case.id);
    expect(again.data.sourceId).toBe(first.data.sourceId);
    expect(analysis.started).toHaveLength(1);
    expect((await h.repos(CONTOSO).cases.list({ limit: 10 })).items).toHaveLength(1);
    expect(storedObjects(h)).toHaveLength(1);
    expect(await auditOf(h, 'case.ingested')).toHaveLength(1);
    expect(await auditOf(h, 'api.cases.create')).toHaveLength(1);
  });

  it('[FR-ING-08] replays by Idempotency-Key and rejects the same key with a different request', async () => {
    const { h } = await openHarness(database, harnesses);
    const key = 'ingest-key-0001';
    const first = await createCase(h, PERSONAS.engineer, SAMPLE_SOURCE, undefined, {
      'idempotency-key': key,
    });
    const replay = await createCase(h, PERSONAS.engineer, SAMPLE_SOURCE, undefined, {
      'idempotency-key': key,
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.data).toEqual(first.data);

    const reused = await createCase(h, PERSONAS.engineer, FOLLOWUP_SOURCE, undefined, {
      'idempotency-key': key,
    });
    expect(reused.statusCode).toBe(422);
    expect(reused.data.code).toBe('idempotency_conflict');
    expect((await h.repos(CONTOSO).cases.list({ limit: 10 })).items).toHaveLength(1);
  });

  it('[FR-ING-08] a different payload under a used reference is a friendly 409 and leaves nothing behind', async () => {
    const { h } = await openHarness(database, harnesses);
    const first = await createCase(h, PERSONAS.engineer, {
      type: 'bundle',
      bundle: bundleOf({ reference: 'CG-DUP-1001', body: 'The first version of the message.' }),
    });
    expect(first.statusCode).toBe(201);
    const second = await createCase(h, PERSONAS.engineer, {
      type: 'bundle',
      bundle: bundleOf({ reference: 'CG-DUP-1001', body: 'A different version of the message.' }),
    });
    expect(second.statusCode).toBe(409);
    expect(second.data.code).toBe('conflict');
    expect(second.data.detail).toContain('CG-DUP-1001');
    expect(second.data.detail).toContain('different content');
    expect(second.data.detail).not.toMatch(/constraint|_uq|_idx|violates|duplicate key/i);
    expect((await h.repos(CONTOSO).cases.list({ limit: 10 })).items).toHaveLength(1);
    expect(storedObjects(h)).toHaveLength(1);
    expect(await auditOf(h, 'case.ingested')).toHaveLength(1);
  });

  it('[FR-ING-02] refuses an invalid payload with 422 and field-level errors, persisting nothing', async () => {
    const { h, analysis } = await openHarness(database, harnesses);
    const base = bundleOf();
    const res = await createCase(h, PERSONAS.engineer, {
      type: 'bundle',
      bundle: { ...base, case: { ...(base.case as object), severity: 'Z' }, events: [] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.data.code).toBe('validation_failed');
    const paths = res.data.errors.map((error: { path: string }) => error.path);
    expect(paths.some((path: string) => path.includes('severity'))).toBe(true);
    expect(paths.some((path: string) => path.includes('events'))).toBe(true);
    expect((await h.repos(CONTOSO).cases.list({ limit: 10 })).items).toEqual([]);
    expect(storedObjects(h)).toEqual([]);
    expect(analysis.started).toEqual([]);
    expect(await auditOf(h, 'case.ingested')).toEqual([]);
  });

  it('[FR-ING-02] refuses real data in a synthetic workspace with a clear 422', async () => {
    const { h } = await openHarness(database, harnesses);
    const res = await createCase(h, PERSONAS.engineer, {
      type: 'bundle',
      bundle: bundleOf({ synthetic: false }),
    });
    expect(res.statusCode).toBe(422);
    expect(res.data.detail).toContain('synthetic data only');
    expect(res.data.errors[0].path).toBe('synthetic');
    expect((await h.repos(CONTOSO).cases.list({ limit: 10 })).items).toEqual([]);
  });

  it('[NFR-SEC-02] needs case:ingest: 401 anonymous, 403 (audited) for roles without it', async () => {
    const { h } = await openHarness(database, harnesses);
    expect((await createCase(h, null, SAMPLE_SOURCE)).statusCode).toBe(401);
    for (const persona of [PERSONAS.manager, PERSONAS.reviewer, PERSONAS.curator]) {
      const res = await createCase(h, persona, SAMPLE_SOURCE);
      expect(res.statusCode, persona).toBe(403);
    }
    expect((await h.repos(CONTOSO).cases.list({ limit: 10 })).items).toEqual([]);
    const denied = await auditOf(h, 'access.denied');
    expect(denied.length).toBeGreaterThanOrEqual(3);
    expect(denied[0]).toMatchObject({ outcome: 'denied', details: { routeId: 'cases.create' } });
  });

  it('[NFR-SEC-01] isolates tenants: the same content is created independently in another workspace', async () => {
    const { h } = await openHarness(database, harnesses);
    const mine = await createCase(h, PERSONAS.engineer, SAMPLE_SOURCE);
    const theirs = await createCase(h, PERSONAS.otherTenantEngineer, SAMPLE_SOURCE);
    expect(theirs.statusCode).toBe(201);
    expect(theirs.data.created).toBe(true);
    expect(theirs.data.case.id).not.toBe(mine.data.case.id);
    expect((await h.repos(CONTOSO).cases.list({ limit: 10 })).items.map((item) => item.id)).toEqual(
      [mine.data.case.id],
    );
    expect(
      (await h.repos(FABRIKAM).cases.list({ limit: 10 })).items.map((item) => item.id),
    ).toEqual([theirs.data.case.id]);
    const preview = await previewCase(h, PERSONAS.otherTenantEngineer, SAMPLE_SOURCE);
    expect(preview.data.alreadyIngestedCaseId).toBe(theirs.data.case.id);
    expect(await auditOf(h, 'case.ingested', FABRIKAM)).toHaveLength(1);
    expect(await auditOf(h, 'case.ingested', CONTOSO)).toHaveLength(1);
  });
});

describe('analysis after ingestion', () => {
  it('keeps the case and reports no job when the analysis port answers 501', async () => {
    const { h } = await openHarness(database, harnesses, {
      services: {
        analysis: {
          analyzeCase: () => Promise.reject(new Error('unused')),
          startAnalysis: () =>
            Promise.reject(new NotImplementedError('AnalysisPort.startAnalysis')),
        },
      },
    });
    const res = await createCase(h, PERSONAS.engineer, SAMPLE_SOURCE);
    expect(res.statusCode).toBe(201);
    expect(res.data).toMatchObject({ created: true, analysisJob: null });
    expect((await h.repos(CONTOSO).cases.list({ limit: 10 })).items).toHaveLength(1);
    const warning = h.logs().find((line) => line.event === 'ingest.analysis_not_started');
    expect(warning).toMatchObject({
      code: 'not_implemented',
      status: 501,
      caseId: res.data.case.id,
    });
    expect(JSON.stringify(warning)).not.toContain('Teams');
  });

  it('keeps the case when the analysis port fails unexpectedly', async () => {
    const { h } = await openHarness(database, harnesses, {
      services: {
        analysis: {
          analyzeCase: () => Promise.reject(new Error('unused')),
          startAnalysis: () => Promise.reject(new Error('the engine fell over')),
        },
      },
    });
    const res = await createCase(h, PERSONAS.engineer, SAMPLE_SOURCE);
    expect(res.statusCode).toBe(201);
    expect(res.data.analysisJob).toBeNull();
    expect(
      h
        .logs()
        .some((line) => line.event === 'ingest.analysis_not_started' && line.level === 'error'),
    ).toBe(true);
  });
});
