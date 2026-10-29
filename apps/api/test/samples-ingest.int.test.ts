import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CaseBundleSchema, ExampleInfoSchema, SampleBundleInfoSchema } from '@caseguard/schemas';
import { ROLE_PERMISSIONS, canonicalJson, sha256Hex } from '@caseguard/security';
import type { Database } from '../src/db';
import { TEST_DATABASE_STARTUP_TIMEOUT_MS } from '../src/db/testing';
import { buildRequestContext } from '../src/http/context-factory';
import { findExample, sampleByRole } from '../src/samples';
import {
  FOLLOWUP_SOURCE,
  SAMPLE_SOURCE,
  auditOf,
  createCase,
  openHarness,
  openWarmDatabase,
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

const SAMPLES = [
  { role: 'primary', source: SAMPLE_SOURCE, reference: 'CG-SYN-1001', events: 31, participants: 6 },
  {
    role: 'followup',
    source: FOLLOWUP_SOURCE,
    reference: 'CG-SYN-1002',
    events: 15,
    participants: 4,
  },
] as const;

describe('samples, examples and schemas routes (FR-ING-01, FR-ING-09)', () => {
  it('[FR-ING-01] samples.list describes the two built-in cases', async () => {
    const { h } = await openHarness(database, harnesses);
    const res = await h.call(PERSONAS.engineer, { method: 'GET', url: '/api/v1/samples' });
    expect(res.statusCode).toBe(200);
    expect(res.data.items).toHaveLength(2);
    for (const item of res.data.items)
      expect(SampleBundleInfoSchema.safeParse(item).success).toBe(true);
    expect(res.data.items.map((item: { role: string }) => item.role)).toEqual([
      'primary',
      'followup',
    ]);
    expect(res.data.items[0]).toMatchObject({ reference: 'CG-SYN-1001', eventCount: 31 });
  });

  it('[NFR-SEC-02] samples, examples and schemas need case:read: 401 anonymous, allowed for a manager', async () => {
    const { h } = await openHarness(database, harnesses);
    for (const url of [
      '/api/v1/samples',
      '/api/v1/examples',
      '/api/v1/examples/minimal-case-bundle',
      '/api/v1/schemas/case-bundle.schema.json',
      '/api/v1/schemas/knowledge-pack.schema.json',
    ]) {
      expect((await h.call(null, { method: 'GET', url })).statusCode, url).toBe(401);
      expect((await h.call(PERSONAS.manager, { method: 'GET', url })).statusCode, url).toBe(200);
    }
  });

  it('[FR-ING-09] examples.list and examples.get serve the synthetic files as attachments', async () => {
    const { h } = await openHarness(database, harnesses);
    const list = await h.call(PERSONAS.engineer, { method: 'GET', url: '/api/v1/examples' });
    expect(list.statusCode).toBe(200);
    expect(list.data.items.map((item: { kind: string }) => item.kind)).toEqual([
      'transcript',
      'csv',
      'case_bundle',
    ]);
    for (const item of list.data.items)
      expect(ExampleInfoSchema.safeParse(item).success).toBe(true);

    const expectations = [
      [
        'transcript-teams-signin-proxy',
        'text/plain; charset=utf-8',
        'transcript-teams-signin-proxy.txt',
      ],
      ['events-teams-signin-proxy', 'text/csv; charset=utf-8', 'events-teams-signin-proxy.csv'],
      ['minimal-case-bundle', 'application/json; charset=utf-8', 'minimal-case-bundle.json'],
    ] as const;
    for (const [id, type, fileName] of expectations) {
      const res = await h.call(PERSONAS.engineer, { method: 'GET', url: `/api/v1/examples/${id}` });
      expect(res.statusCode, id).toBe(200);
      expect(res.headers['content-type']).toBe(type);
      expect(res.headers['content-disposition']).toBe(`attachment; filename="${fileName}"`);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.body).toBe(findExample(id)?.text);
    }
  });

  it('answers 404 for an example that does not exist and 422 for a malformed id', async () => {
    const { h } = await openHarness(database, harnesses);
    const res = await h.call(PERSONAS.engineer, { method: 'GET', url: '/api/v1/examples/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.data.code).toBe('not_found');
    const bad = await h.call(PERSONAS.engineer, { method: 'GET', url: '/api/v1/examples/%20x' });
    expect(bad.statusCode).toBe(422);
  });

  it('[FR-ING-09] serves the case bundle and knowledge pack JSON Schemas as cacheable downloads', async () => {
    const { h } = await openHarness(database, harnesses);
    const bundle = await h.call(PERSONAS.engineer, {
      method: 'GET',
      url: '/api/v1/schemas/case-bundle.schema.json',
    });
    expect(bundle.statusCode).toBe(200);
    expect(bundle.data.properties.schemaVersion.const).toBe('caseguard.case-bundle/1');
    expect(bundle.headers['cache-control']).toBe('private, max-age=300');
    expect(bundle.headers['content-disposition']).toBe(
      'attachment; filename="case-bundle.schema.json"',
    );

    const pack = await h.call(PERSONAS.engineer, {
      method: 'GET',
      url: '/api/v1/schemas/knowledge-pack.schema.json',
    });
    expect(pack.statusCode).toBe(200);
    expect(pack.data.$id).toContain('knowledge-pack');
    expect(pack.headers['content-disposition']).toBe(
      'attachment; filename="knowledge-pack.schema.json"',
    );
  });
});

describe('the built-in samples go through the same pipeline as any other payload (FR-ING-01)', () => {
  it('[FR-ING-01] ingests both samples with exact counts, no redaction, no injection flags and an audit row each', async () => {
    const { h, analysis } = await openHarness(database, harnesses);
    const repos = h.repos(CONTOSO);

    for (const sample of SAMPLES) {
      const res = await createCase(h, PERSONAS.engineer, sample.source);
      expect(res.statusCode, sample.reference).toBe(201);
      expect(res.data).toMatchObject({
        created: true,
        eventCount: sample.events,
        case: { reference: sample.reference, synthetic: true, hasResolution: true },
        // Synthetic data is written with reserved addresses and domains, which are not redacted.
        preview: {
          redaction: { applied: false, totalReplacements: 0, findings: [] },
          injection: { detected: false, highestSeverity: 'none', findings: [] },
          issues: [],
        },
      });
      const caseId: string = res.data.case.id;

      const events = await repos.cases.getAllEvents(caseId);
      expect(events).toHaveLength(sample.events);
      expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index));
      expect(events.every((event) => event.immutable && !event.redaction.redacted)).toBe(true);
      const participants = await repos.cases.getParticipants(caseId);
      expect(participants).toHaveLength(sample.participants);
      expect(participants.reduce((sum, participant) => sum + participant.eventCount, 0)).toBe(
        sample.events,
      );
      expect(await repos.cases.getResolution(caseId)).not.toBeNull();

      // Redaction left the sample untouched: the stored payload is the canonical sample bundle.
      const bundle = CaseBundleSchema.parse(JSON.parse(sampleByRole(sample.role).json));
      const source = await repos.cases.getSource(caseId);
      expect(source?.storedSha256).toBe(sha256Hex(canonicalJson(bundle)));
      expect(source).toMatchObject({
        kind: 'builtin_sample',
        redactionApplied: false,
        synthetic: true,
      });
      expect(events[0]?.sourcePointer).toBe('/events/0');
    }
    expect(analysis.started).toHaveLength(2);

    const audit = await auditOf(h, 'case.ingested');
    expect(audit.map((event) => event.details.reference).sort()).toEqual([
      'CG-SYN-1001',
      'CG-SYN-1002',
    ]);
    for (const event of audit) {
      expect(event).toMatchObject({
        actorId: PERSONAS.engineer,
        outcome: 'success',
        details: {
          sourceKind: 'builtin_sample',
          redactionReplacements: 0,
          injectionHighestSeverity: 'none',
        },
      });
    }
    expect(storedObjects(h)).toHaveLength(2);
  });

  it('[FR-ING-08] a second ingest of either sample is an idempotent replay', async () => {
    const { h, analysis } = await openHarness(database, harnesses);
    const first = [];
    for (const sample of SAMPLES) first.push(await createCase(h, PERSONAS.engineer, sample.source));
    for (const [index, sample] of SAMPLES.entries()) {
      const again = await createCase(h, PERSONAS.engineer, sample.source);
      expect(again.statusCode).toBe(201);
      expect(again.data).toMatchObject({
        created: false,
        analysisJob: null,
        eventCount: sample.events,
      });
      expect(again.data.case.id).toBe(first[index]?.data.case.id);
    }
    expect((await h.repos(CONTOSO).cases.list({ limit: 10 })).items).toHaveLength(2);
    expect(storedObjects(h)).toHaveLength(2);
    expect(await auditOf(h, 'case.ingested')).toHaveLength(2);
    expect(analysis.started).toHaveLength(2);
  });

  it('[NFR-SEC-01] the other tenant sees none of it, and ingests its own copy independently', async () => {
    const { h } = await openHarness(database, harnesses);
    const ids: string[] = [];
    for (const sample of SAMPLES)
      ids.push((await createCase(h, PERSONAS.engineer, sample.source)).data.case.id);

    const theirList = await h.call(PERSONAS.otherTenantEngineer, {
      method: 'GET',
      url: '/api/v1/cases',
    });
    expect(theirList.data.items).toEqual([]);
    for (const id of ids) {
      const res = await h.call(PERSONAS.otherTenantEngineer, {
        method: 'GET',
        url: `/api/v1/cases/${id}`,
      });
      expect(res.statusCode).toBe(404);
    }
    expect(await auditOf(h, 'case.ingested', FABRIKAM)).toEqual([]);

    const theirs = await createCase(h, PERSONAS.otherTenantEngineer, SAMPLE_SOURCE);
    expect(theirs.data.created).toBe(true);
    expect(ids).not.toContain(theirs.data.case.id);
    expect((await h.repos(CONTOSO).cases.list({ limit: 10 })).items).toHaveLength(2);
    expect((await h.repos(FABRIKAM).cases.list({ limit: 10 })).items).toHaveLength(1);
  });

  it('[FR-ING-01] works without HTTP, the way the demo seeder uses the port (no analysis, system-style context)', async () => {
    const { h, analysis } = await openHarness(database, harnesses);
    const ctx = buildRequestContext(h.infra, {
      requestId: 'req_seed_0001',
      auth: {
        userId: PERSONAS.admin,
        tenantId: CONTOSO,
        displayName: 'Alex Admin',
        roles: ['administrator'],
        permissions: ROLE_PERMISSIONS.administrator,
        authMode: 'dev',
        synthetic: true,
        subject: PERSONAS.admin,
        email: null,
      },
      permission: null,
      signal: new AbortController().signal,
      logger: h.infra.logger,
    });
    const result = await h.infra.services.ingestion.ingest(ctx, {
      source: SAMPLE_SOURCE,
      analyze: false,
    });
    expect(result).toMatchObject({ created: true, analysisJob: null, eventCount: 31 });
    expect(analysis.started).toEqual([]);
    const [audit] = await auditOf(h, 'case.ingested');
    expect(audit).toMatchObject({ actorId: PERSONAS.admin, caseId: result.case.id });

    const preview = await h.infra.services.ingestion.preview(ctx, SAMPLE_SOURCE);
    expect(preview).toMatchObject({ ok: true, alreadyIngestedCaseId: result.case.id });
  });
});
