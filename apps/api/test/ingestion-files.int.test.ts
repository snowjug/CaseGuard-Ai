import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IngestResultSchema, IngestionPreviewSchema } from '@caseguard/schemas';
import type { Database } from '../src/db';
import { TEST_DATABASE_STARTUP_TIMEOUT_MS } from '../src/db/testing';
import { findExample } from '../src/samples';
import { bundleOf, secrets } from './ingestion-fixtures';
import {
  CONTRACT_FIELDS,
  CREATE_FILE_URL,
  PREVIEW_FILE_URL,
  auditOf,
  csvWith,
  leakSurface,
  openHarness,
  openWarmDatabase,
  resetDatabase,
  storedObjects,
  uploadFile,
} from './ingestion-support';
import { CONTOSO, PERSONAS, type Harness } from './support/app-harness';
import { multipartBody } from './support/fixtures';

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

const upload = uploadFile;
const PREVIEW_URL = PREVIEW_FILE_URL;
const CREATE_URL = CREATE_FILE_URL;

const csvExample = findExample('events-teams-signin-proxy')?.text ?? '';
const transcriptExample = findExample('transcript-teams-signin-proxy')?.text ?? '';
const bundleExample = findExample('minimal-case-bundle')?.text ?? '';

describe('ingestion.previewFile (FR-ING-01, FR-ING-03)', () => {
  it('[FR-ING-03] previews a CSV, a JSON bundle and a text transcript without persisting anything', async () => {
    const { h, analysis } = await openHarness(database, harnesses);
    const cases = [
      ['events.csv', csvExample, 'text/csv', 13],
      ['bundle.json', bundleExample, 'application/json', 3],
      ['transcript.txt', transcriptExample, 'text/plain', 15],
    ] as const;
    for (const [name, content, type, eventCount] of cases) {
      const res = await upload(h, PERSONAS.engineer, PREVIEW_URL, name, content, type);
      expect(res.statusCode, name).toBe(200);
      expect(IngestionPreviewSchema.safeParse(res.data).success, name).toBe(true);
      expect(res.data).toMatchObject({ ok: true, sourceKind: 'uploaded_file', synthetic: true });
      expect(res.data.summary.eventCount, name).toBe(eventCount);
      const note = res.data.issues.find((issue: { path: string }) => issue.path === 'file');
      expect(note.message).toContain('NOT scanned');
    }
    expect((await h.repos(CONTOSO).cases.list({ limit: 10 })).items).toEqual([]);
    expect(storedObjects(h)).toEqual([]);
    expect(analysis.started).toEqual([]);
  });

  it('[FR-ING-02] explains a JSON syntax error and a bad schema as a failed preview, not as a 4xx', async () => {
    const { h } = await openHarness(database, harnesses);
    const broken = await upload(
      h,
      PERSONAS.engineer,
      PREVIEW_URL,
      'bundle.json',
      '{"schemaVersion": ',
      'application/json',
    );
    expect(broken.statusCode).toBe(200);
    expect(broken.data.ok).toBe(false);
    expect(broken.data.issues[0].severity).toBe('error');

    const wrongShape = await upload(
      h,
      PERSONAS.engineer,
      PREVIEW_URL,
      'bundle.json',
      '{"events": []}',
      'application/json',
    );
    expect(wrongShape.statusCode).toBe(200);
    expect(wrongShape.data.ok).toBe(false);
    expect(wrongShape.data.issues.length).toBeGreaterThan(0);
  });

  it('[FR-ING-05] refuses prototype-pollution keys and over-deep JSON with field-level errors', async () => {
    const { h } = await openHarness(database, harnesses);
    const polluted = await upload(
      h,
      PERSONAS.engineer,
      PREVIEW_URL,
      'bundle.json',
      '{"__proto__": {"polluted": true}, "schemaVersion": "caseguard.case-bundle/1"}',
      'application/json',
    );
    expect(polluted.statusCode).toBe(200);
    expect(polluted.data.ok).toBe(false);
    expect(polluted.data.issues[0].message).toContain('not allowed');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    const deep = await upload(
      h,
      PERSONAS.engineer,
      PREVIEW_URL,
      'bundle.json',
      `${'['.repeat(100)}${']'.repeat(100)}`,
      'application/json',
    );
    expect(deep.statusCode).toBe(200);
    expect(deep.data.ok).toBe(false);
  });

  it('[NFR-SEC-02] needs case:ingest: 401 anonymous, 403 for a manager', async () => {
    const { h } = await openHarness(database, harnesses);
    expect(
      (await upload(h, null, PREVIEW_URL, 'events.csv', csvExample, 'text/csv')).statusCode,
    ).toBe(401);
    const denied = await upload(
      h,
      PERSONAS.manager,
      PREVIEW_URL,
      'events.csv',
      csvExample,
      'text/csv',
    );
    expect(denied.statusCode).toBe(403);
  });

  it('answers 422 without a file part or with the wrong field name, and 415 without multipart', async () => {
    const { h } = await openHarness(database, harnesses);
    const empty = multipartBody([]);
    const none = await h.call(PERSONAS.engineer, {
      method: 'POST',
      url: PREVIEW_URL,
      payload: empty.payload,
      headers: empty.headers,
    });
    expect(none.statusCode).toBe(422);
    const wrong = multipartBody([
      { name: 'document', filename: 'events.csv', type: 'text/csv', content: csvExample },
    ]);
    const misnamed = await h.call(PERSONAS.engineer, {
      method: 'POST',
      url: PREVIEW_URL,
      payload: wrong.payload,
      headers: wrong.headers,
    });
    expect(misnamed.statusCode).toBe(422);
    expect(misnamed.data.errors[0].message).toContain('Unexpected field name');
    const json = await h.call(PERSONAS.engineer, {
      method: 'POST',
      url: PREVIEW_URL,
      payload: { a: 1 },
    });
    expect(json.statusCode).toBe(415);
  });
});

describe('cases.createFromFile (FR-ING-01, FR-ING-07, FR-ING-08)', () => {
  it('[FR-ING-01] ingests a CSV: immutable source with the sanitised name, audit, analysis job, replay', async () => {
    const { h, analysis } = await openHarness(database, harnesses);
    const res = await upload(
      h,
      PERSONAS.engineer,
      CREATE_URL,
      'My Export (1).csv',
      csvExample,
      'text/csv',
    );
    expect(res.statusCode).toBe(201);
    expect(IngestResultSchema.safeParse(res.data).success).toBe(true);
    expect(res.data).toMatchObject({ created: true, eventCount: 13 });
    expect(res.data.analysisJob).toMatchObject({ caseId: res.data.case.id });
    const caseId: string = res.data.case.id;

    const repos = h.repos(CONTOSO);
    const source = await repos.cases.getSource(caseId);
    expect(source?.fileName).toMatch(/^[A-Za-z0-9._-]+\.csv$/);
    expect(source).toMatchObject({ kind: 'uploaded_file', immutable: true });
    expect(await repos.cases.getAllEvents(caseId)).toHaveLength(13);
    expect(storedObjects(h)).toHaveLength(1);

    const [audit] = await auditOf(h, 'case.ingested');
    expect(audit).toMatchObject({
      caseId,
      details: { sourceKind: 'uploaded_file', eventCount: 13 },
    });
    expect(JSON.stringify(audit?.details)).not.toContain('My Export');

    const again = await upload(
      h,
      PERSONAS.engineer,
      CREATE_URL,
      'renamed.csv',
      csvExample,
      'text/csv',
    );
    expect(again.statusCode).toBe(201);
    expect(again.data).toMatchObject({ created: false, analysisJob: null });
    expect(again.data.case.id).toBe(caseId);
    expect(analysis.started).toEqual([caseId]);
    expect(storedObjects(h)).toHaveLength(1);
  });

  it('[FR-ING-08] replays by Idempotency-Key on uploads', async () => {
    const { h } = await openHarness(database, harnesses);
    const headers = { 'idempotency-key': 'upload-key-0001' };
    const first = await upload(
      h,
      PERSONAS.engineer,
      CREATE_URL,
      'events.csv',
      csvExample,
      'text/csv',
      headers,
    );
    const replay = await upload(
      h,
      PERSONAS.engineer,
      CREATE_URL,
      'events.csv',
      csvExample,
      'text/csv',
      headers,
    );
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.data).toEqual(first.data);
  });

  it('[FR-ING-02] refuses a bundle file that declares real data in a synthetic workspace with 422', async () => {
    const { h } = await openHarness(database, harnesses);
    const res = await upload(
      h,
      PERSONAS.engineer,
      CREATE_URL,
      'bundle.json',
      JSON.stringify(bundleOf({ synthetic: false })),
      'application/json',
    );
    expect(res.statusCode).toBe(422);
    expect(res.data.errors[0].path).toBe('synthetic');
    expect(storedObjects(h)).toEqual([]);
  });

  it('[FR-ING-02] refuses a file the parser cannot read with 422 and its field-level errors', async () => {
    const { h } = await openHarness(database, harnesses);
    const res = await upload(
      h,
      PERSONAS.engineer,
      CREATE_URL,
      'events.csv',
      'just,one,line',
      'text/csv',
    );
    expect(res.statusCode).toBe(422);
    expect(res.data.code).toBe('validation_failed');
    expect(res.data.errors.length).toBeGreaterThan(0);
    expect((await h.repos(CONTOSO).cases.list({ limit: 10 })).items).toEqual([]);
  });

  it('[NFR-SEC-02] needs case:ingest: 401 anonymous, 403 for a manager', async () => {
    const { h } = await openHarness(database, harnesses);
    expect(
      (await upload(h, null, CREATE_URL, 'events.csv', csvExample, 'text/csv')).statusCode,
    ).toBe(401);
    expect(
      (await upload(h, PERSONAS.manager, CREATE_URL, 'events.csv', csvExample, 'text/csv'))
        .statusCode,
    ).toBe(403);
  });

  it('[FR-ING-04] redacts a secret in a CSV cell and never lets it into the response, audit, logs or storage', async () => {
    const { h } = await openHarness(database, harnesses);
    const token = secrets.githubToken();
    const password = secrets.password();
    const message = `Our token is ${token} and the password: ${password} was shared`;
    const res = await upload(
      h,
      PERSONAS.engineer,
      CREATE_URL,
      'events.csv',
      csvWith(message),
      'text/csv',
    );
    expect(res.statusCode).toBe(201);
    expect(res.data.preview.redaction.applied).toBe(true);
    expect(
      res.data.preview.redaction.findings.map((finding: { category: string }) => finding.category),
    ).toEqual(expect.arrayContaining(['github_token']));
    expect(res.body).not.toContain(token);
    expect(res.body).not.toContain(password);

    const events = await h.repos(CONTOSO).cases.getAllEvents(res.data.case.id);
    expect(events[0]?.body).toContain('[REDACTED:github_token]');
    expect(events[0]?.redaction).toMatchObject({ redacted: true });
    const surface = await leakSurface(h);
    expect(surface).not.toContain(token);
    expect(surface).not.toContain(password);
    const object = await h.infra.objects.get(
      (await h.repos(CONTOSO).cases.getSource(res.data.case.id))?.storageRef ?? '',
    );
    expect(Buffer.from(object?.bytes ?? []).toString('utf8')).not.toContain(token);
  });

  it('neutralises spreadsheet formulas in CSV cells and says so', async () => {
    const { h } = await openHarness(database, harnesses);
    const csv = csvWith('=HYPERLINK(""https://example.invalid/x"")');
    const res = await upload(h, PERSONAS.engineer, PREVIEW_URL, 'events.csv', csv, 'text/csv');
    expect(res.statusCode).toBe(200);
    expect(res.data.ok).toBe(true);
    expect(res.data.eventsPreview[0].bodyExcerpt.startsWith('=')).toBe(false);
    expect(
      res.data.issues.some((issue: { message: string }) => /formula/i.test(issue.message)),
    ).toBe(true);
  });
});

describe('the workload of an uploaded file (FR-ING-01)', () => {
  const NONE = {};
  const csv = (
    h: Harness,
    url: string,
    fields: Readonly<Record<string, string>>,
    headers: Record<string, string> = {},
  ) => upload(h, PERSONAS.engineer, url, 'events.csv', csvExample, 'text/csv', headers, fields);

  it('refuses a CSV file that states no workload, in the preview and on create, and stores nothing', async () => {
    const { h } = await openHarness(database, harnesses);

    const preview = await csv(h, PREVIEW_URL, NONE);
    expect(preview.statusCode).toBe(200);
    expect(preview.data.ok).toBe(false);
    const issue = preview.data.issues.find(
      (item: { path: string }) => item.path === 'case.workload',
    );
    expect(issue).toMatchObject({ severity: 'error' });
    expect(issue.message).toContain('Choose the workload for this file');

    const create = await csv(h, CREATE_URL, NONE);
    expect(create.statusCode).toBe(422);
    expect(create.data.errors.map((error: { path: string }) => error.path)).toContain(
      'case.workload',
    );
    expect(storedObjects(h)).toEqual([]);
    expect((await h.repos(CONTOSO).cases.list({ limit: 10 })).items).toEqual([]);

    // Blank is the same as absent: there is no silent default for it.
    const blank = await csv(h, CREATE_URL, { workload: '   ' });
    expect(blank.statusCode).toBe(422);
  });

  it('accepts the workload before or after the file part, and ignores any other text field', async () => {
    const { h } = await openHarness(database, harnesses);
    const sent = (parts: Parameters<typeof multipartBody>[0]) => {
      const body = multipartBody(parts);
      return h.call(PERSONAS.engineer, {
        method: 'POST',
        url: CREATE_URL,
        payload: body.payload,
        headers: body.headers,
      });
    };
    const file = { name: 'file', filename: 'events.csv', type: 'text/csv', content: csvExample };

    const before = await sent([{ name: 'workload', content: 'teams-authentication' }, file]);
    expect(before.statusCode).toBe(201);
    expect(before.data.case.workload).toBe('teams-authentication');

    await resetDatabase(database);
    const after = await sent([file, { name: 'workload', content: 'teams-authentication' }]);
    expect(after.statusCode).toBe(201);
    expect(after.data.case.workload).toBe('teams-authentication');

    await resetDatabase(database);
    const other = await sent([
      { name: 'note', content: 'ignored' },
      { name: 'workload', content: ' teams-authentication ' },
      file,
    ]);
    expect(other.statusCode).toBe(201);
  });

  it('refuses an unsupported workload by name, and a workload that is not a short plain key', async () => {
    const { h } = await openHarness(database, harnesses);

    const unsupported = await csv(h, CREATE_URL, { workload: 'quantum-routing' });
    expect(unsupported.statusCode).toBe(422);
    expect(unsupported.data.errors[0]).toMatchObject({ path: 'case.workload' });
    expect(unsupported.data.errors[0].message).toContain('"quantum-routing"');

    for (const workload of ['x'.repeat(81), 'teams-authentication\u0007']) {
      const res = await csv(h, CREATE_URL, { workload });
      expect(res.statusCode, JSON.stringify(workload)).toBe(422);
      expect(res.data.errors[0].path).toBe('workload');
    }
    expect(storedObjects(h)).toEqual([]);
  });

  it('counts the workload as part of what an Idempotency-Key covers', async () => {
    const { h } = await openHarness(database, harnesses);
    const headers = { 'idempotency-key': 'upload-workload-0001' };

    const first = await csv(h, CREATE_URL, CONTRACT_FIELDS, headers);
    expect(first.statusCode).toBe(201);
    const replay = await csv(h, CREATE_URL, CONTRACT_FIELDS, headers);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.data).toEqual(first.data);

    const changed = await csv(h, CREATE_URL, { workload: 'quantum-routing' }, headers);
    expect(changed.statusCode).toBe(422);
    expect(changed.data.code ?? changed.data.type).toMatch(/idempotency/);
  });

  it('refuses a different workload for a JSON bundle file, which states its own', async () => {
    const { h } = await openHarness(database, harnesses);
    const bundle = JSON.stringify(bundleOf());
    const send = (fields: Readonly<Record<string, string>>) =>
      upload(
        h,
        PERSONAS.engineer,
        CREATE_URL,
        'bundle.json',
        bundle,
        'application/json',
        {},
        fields,
      );

    const own = await send(NONE);
    expect(own.statusCode).toBe(201);

    await resetDatabase(database);
    const other = await send({ workload: 'quantum-routing' });
    expect(other.statusCode).toBe(422);
    expect(other.data.errors[0]).toMatchObject({ path: 'case.workload' });
    expect(other.data.errors[0].message).toContain('"quantum-routing" was chosen');
    expect((await h.repos(CONTOSO).cases.list({ limit: 10 })).items).toEqual([]);
  });
});
