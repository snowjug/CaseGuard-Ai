import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_REDACTION_CONFIG } from '@caseguard/schemas';
import type { Database } from '../src/db';
import { TEST_DATABASE_STARTUP_TIMEOUT_MS, withFaultInjection } from '../src/db/testing';
import { INJECTION_TEXT, bundleOf, secrets, transcriptOf } from './ingestion-fixtures';
import {
  SAMPLE_SOURCE,
  auditOf,
  createCase,
  leakSurface,
  openHarness,
  openWarmDatabase,
  post,
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

describe('secrets never leave the pipeline (FR-ING-04)', () => {
  it('[FR-ING-04] redacts secrets in pasted text, a pasted title and a bundle, and keeps them out of everything', async () => {
    const { h } = await openHarness(database, harnesses);
    const token = secrets.githubToken(31);
    const password = secrets.password(32);
    const bearer = secrets.bearerToken(33);
    const jwt = secrets.jwt(34);
    const all = [token, password, bearer, jwt];

    const pasted = await createCase(h, PERSONAS.engineer, {
      type: 'paste',
      text: transcriptOf([
        `Teams fails. The token is ${token} for the portal.`,
        `Authorization: Bearer ${bearer} was in the trace, see ${jwt}`,
      ]),
      title: `Sign-in failures after rotating ${token}`,
      workload: 'teams-authentication',
    });
    expect(pasted.statusCode).toBe(201);
    expect(pasted.data.case.title).not.toContain(token);
    expect(pasted.data.preview.redaction.totalReplacements).toBeGreaterThanOrEqual(4);

    const bundle = await createCase(h, PERSONAS.engineer, {
      type: 'bundle',
      bundle: bundleOf({
        reference: 'CG-SEC-1001',
        body: `The service account password: ${password} is in the ticket`,
        structured: { password, note: 'kept' },
      }),
    });
    expect(bundle.statusCode).toBe(201);
    expect(bundle.data.preview.redaction.applied).toBe(true);

    for (const response of [pasted, bundle]) {
      for (const secret of all) expect(response.body).not.toContain(secret);
    }
    const surface = await leakSurface(h);
    for (const secret of all) expect(surface).not.toContain(secret);

    const events = await h.repos(CONTOSO).cases.getAllEvents(bundle.data.case.id);
    expect(events[0]?.structured).toEqual({
      password: '[REDACTED:password_assignment]',
      note: 'kept',
    });
    expect(events[0]?.redaction.categories).toContain('password_assignment');
    const [audit] = await auditOf(h, 'case.ingested');
    expect(audit?.details.redactionReplacements).toBeGreaterThanOrEqual(2);
  });

  it('[FR-ING-04] a preview also redacts, and the preview of a failing payload does not echo the secret either', async () => {
    const { h } = await openHarness(database, harnesses);
    const token = secrets.githubToken(41);
    const preview = await previewCase(h, PERSONAS.engineer, {
      type: 'bundle',
      bundle: bundleOf({ body: `Key ${token} was pasted` }),
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.data.redaction.totalReplacements).toBe(1);
    expect(preview.body).not.toContain(token);
    expect(preview.data.eventsPreview[0].bodyExcerpt).toBe(
      'Key [REDACTED:github_token] was pasted',
    );

    const base = bundleOf();
    const failing = { ...base, case: { ...(base.case as object), severity: token } };
    const failed = await previewCase(h, PERSONAS.engineer, { type: 'bundle', bundle: failing });
    expect(failed.statusCode).toBe(200);
    expect(failed.data.ok).toBe(false);
    expect(failed.body).not.toContain(token);
    const refused = await createCase(h, PERSONAS.engineer, { type: 'bundle', bundle: failing });
    expect(refused.statusCode).toBe(422);
    expect(refused.body).not.toContain(token);
    expect(await leakSurface(h)).not.toContain(token);
  });

  it('[FR-ING-04] applies the tenant redaction settings: custom patterns on, personal data off, secrets always on', async () => {
    const { h } = await openHarness(database, harnesses);
    const repos = h.repos(CONTOSO);
    await repos.governance.getSettings();
    await repos.governance.updateSection(
      'redaction',
      {
        ...DEFAULT_REDACTION_CONFIG,
        enabledCategories: [],
        customPatterns: [{ name: 'ticket', pattern: 'TKT-[0-9]{6}' }],
      },
      { expectedVersion: 1, changeNote: 'test configuration', by: PERSONAS.admin },
    );
    const token = secrets.githubToken(51);
    const res = await createCase(h, PERSONAS.engineer, {
      type: 'bundle',
      bundle: bundleOf({
        body: `Ticket TKT-123456 from jane.doe@real-company.com with ${token}`,
      }),
    });
    expect(res.statusCode).toBe(201);
    const [event] = await repos.cases.getAllEvents(res.data.case.id);
    expect(event?.body).toBe(
      'Ticket [REDACTED:custom] from jane.doe@real-company.com with [REDACTED:github_token]',
    );
    expect(
      res.data.preview.redaction.findings.map((finding: { category: string }) => finding.category),
    ).toEqual(['github_token', 'custom']);
  });

  it('[FR-ING-04] a tenant pattern for ticket ids does not stop the built-in sample (review L2)', async () => {
    const { h } = await openHarness(database, harnesses);
    const repos = h.repos(CONTOSO);
    await repos.governance.getSettings();
    await repos.governance.updateSection(
      'redaction',
      {
        ...DEFAULT_REDACTION_CONFIG,
        customPatterns: [{ name: 'support ticket ids', pattern: 'CG-[A-Z]+-[0-9]{4}' }],
      },
      { expectedVersion: 1, changeNote: 'test configuration', by: PERSONAS.admin },
    );
    const preview = await previewCase(h, PERSONAS.engineer, SAMPLE_SOURCE);
    expect(preview.data).toMatchObject({ ok: true, summary: { reference: 'CG-SYN-1001' } });
    const res = await createCase(h, PERSONAS.engineer, SAMPLE_SOURCE);
    expect(res.statusCode).toBe(201);
    expect(res.data.case.reference).toBe('CG-SYN-1001');
  });
});

describe('prompt injection (NFR-SEC-05)', () => {
  it('flags instructions in pasted text, stores the text unchanged and counts the flag', async () => {
    const { h } = await openHarness(database, harnesses);
    const res = await createCase(h, PERSONAS.engineer, {
      type: 'paste',
      text: transcriptOf([
        `The customer wrote: ${INJECTION_TEXT}`,
        'Please send two failed sign-in times.',
      ]),
      workload: 'teams-authentication',
    });
    expect(res.statusCode).toBe(201);
    expect(res.data.case.injectionDetected).toBe(true);
    expect(res.data.preview.injection.highestSeverity).toBe('high');
    const events = await h.repos(CONTOSO).cases.getAllEvents(res.data.case.id);
    expect(events.some((event) => event.body.includes('Ignore all previous instructions'))).toBe(
      true,
    );
    const metrics = h.infra.metricsRegistry.renderPrometheus();
    expect(metrics).toMatch(
      /caseguard_prompt_injection_flags_total\{[^}]*source="ingestion"[^}]*\} 1/,
    );
    // Excerpts leave the pipeline already redacted and short.
    for (const finding of res.data.preview.injection.findings) {
      expect(finding.excerpt.length).toBeLessThanOrEqual(240);
    }
  });
});

describe('hostile request bodies (FR-ING-05)', () => {
  it('rejects JSON with prototype-pollution keys before any handler runs', async () => {
    const { h } = await openHarness(database, harnesses);
    for (const payload of [
      '{"source":{"type":"bundle","bundle":{"__proto__":{"polluted":true}}}}',
      '{"source":{"type":"bundle","bundle":{"constructor":{"prototype":{"polluted":true}}}}}',
    ]) {
      const res = await h.call(PERSONAS.engineer, {
        method: 'POST',
        url: '/api/v1/cases',
        payload,
        headers: { 'content-type': 'application/json' },
      });
      expect([400, 422]).toContain(res.statusCode);
      expect(res.data.code).toBe('validation_failed');
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(storedObjects(h)).toEqual([]);
    expect((await h.repos(CONTOSO).cases.list({ limit: 10 })).items).toEqual([]);
  });

  it('rejects a body over BODY_LIMIT_BYTES with 413 and pasted text over 200,000 characters with 422', async () => {
    const { h } = await openHarness(database, harnesses, { env: { BODY_LIMIT_BYTES: '4096' } });
    const big = await createCase(h, PERSONAS.engineer, {
      type: 'bundle',
      bundle: bundleOf({ body: 'x'.repeat(10_000) }),
    });
    expect(big.statusCode).toBe(413);
    expect(big.data.code).toBe('payload_too_large');

    const { h: normal } = await openHarness(database, harnesses);
    const text = await post(normal, PERSONAS.engineer, '/api/v1/ingestion/preview', {
      source: { type: 'paste', text: 'x'.repeat(200_001) },
    });
    expect(text.statusCode).toBe(422);
  });

  it('refuses more than 2,000 events with a field-level error and ingests exactly 2,000', async () => {
    const { h } = await openHarness(database, harnesses);
    const over = await previewCase(h, PERSONAS.engineer, {
      type: 'bundle',
      bundle: bundleOf({ eventCount: 2001 }),
    });
    expect(over.statusCode).toBe(200);
    expect(over.data.ok).toBe(false);
    expect(over.data.issues[0].path).toContain('events');

    const exact = await createCase(h, PERSONAS.engineer, {
      type: 'bundle',
      bundle: bundleOf({ eventCount: 2000 }),
    });
    expect(exact.statusCode).toBe(201);
    expect(exact.data.eventCount).toBe(2000);
  }, 60_000);

  it('answers 404 for a built-in sample that does not exist', async () => {
    const { h } = await openHarness(database, harnesses);
    const res = await createCase(h, PERSONAS.engineer, {
      type: 'sample',
      sampleId: 'no-such-sample',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('no orphans, no duplicates', () => {
  it('[FR-ING-07] a failed transaction leaves no stored object and no case, and a retry succeeds', async () => {
    const faulty = withFaultInjection(database);
    const { h } = await openHarness(faulty, harnesses);
    faulty.arm({ match: /INSERT INTO case_events/i });
    const failed = await createCase(h, PERSONAS.engineer, { type: 'bundle', bundle: bundleOf() });
    faulty.disarm();
    expect(failed.statusCode).toBe(500);
    expect(failed.data.code).toBe('internal');
    expect(storedObjects(h)).toEqual([]);
    expect((await h.repos(CONTOSO).cases.list({ limit: 10 })).items).toEqual([]);
    expect(await auditOf(h, 'case.ingested')).toEqual([]);
    expect(await auditOf(h, 'api.cases.create')).toEqual([
      expect.objectContaining({
        outcome: 'failure',
        details: expect.objectContaining({ status: 500 }),
      }),
    ]);

    const retry = await createCase(h, PERSONAS.engineer, { type: 'bundle', bundle: bundleOf() });
    expect(retry.statusCode).toBe(201);
    expect(retry.data.created).toBe(true);
    expect(storedObjects(h)).toHaveLength(1);
  });

  it('[FR-ING-08] two identical concurrent requests create one case, one object and one audit event', async () => {
    const { h, analysis } = await openHarness(database, harnesses);
    const source = { type: 'bundle', bundle: bundleOf({ reference: 'CG-RACE-1001' }) };
    const [a, b] = await Promise.all([
      createCase(h, PERSONAS.engineer, source),
      createCase(h, PERSONAS.engineer, source),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect([a.data.created, b.data.created].sort()).toEqual([false, true]);
    expect(a.data.case.id).toBe(b.data.case.id);
    expect(storedObjects(h)).toHaveLength(1);
    expect((await h.repos(CONTOSO).cases.list({ limit: 10 })).items).toHaveLength(1);
    expect(await auditOf(h, 'case.ingested')).toHaveLength(1);
    expect(analysis.started).toHaveLength(1);
  });
});

describe('workspaces that are not marked synthetic', () => {
  it('[FR-ING-02] accept real data after redaction (reserved values too), flagged synthetic=false, and say so', async () => {
    const { h } = await openHarness(database, harnesses);
    await database.query(
      "UPDATE tenants SET synthetic = false, data = jsonb_set(data, '{synthetic}', 'false') WHERE id = $1",
      [FABRIKAM],
    );
    const body = 'The resolver 10.20.1.11 and ops@contoso.example.invalid were involved.';
    const bundle = await createCase(h, PERSONAS.otherTenantEngineer, {
      type: 'bundle',
      bundle: bundleOf({ synthetic: false, body }),
    });
    expect(bundle.statusCode).toBe(201);
    expect(bundle.data.case.synthetic).toBe(false);
    expect(
      bundle.data.preview.redaction.findings.map(
        (finding: { category: string }) => finding.category,
      ),
    ).toEqual(['email_address', 'ipv4_address']);
    expect(bundle.data.preview.issues[0]).toMatchObject({ path: 'synthetic', severity: 'warning' });
    const [event] = await h.repos(FABRIKAM).cases.getAllEvents(bundle.data.case.id);
    expect(event?.body).not.toContain('10.20.1.11');
    const [audit] = await auditOf(h, 'case.ingested', FABRIKAM);
    expect(audit?.details.synthetic).toBe(false);

    const pasted = await createCase(h, PERSONAS.otherTenantEngineer, {
      type: 'paste',
      text: transcriptOf(['Teams fails.', 'Please send two times.']),
      workload: 'teams-authentication',
    });
    expect(pasted.statusCode).toBe(201);
    expect(pasted.data.case.synthetic).toBe(false);

    // The synthetic workspace still refuses the same payload.
    const refused = await createCase(h, PERSONAS.engineer, {
      type: 'bundle',
      bundle: bundleOf({ synthetic: false, body }),
    });
    expect(refused.statusCode).toBe(422);
  });
});

describe('prompt-injection text is stored and flagged, never executed or dropped', () => {
  it('[NFR-SEC-05] flags it in the preview, the case record and the audit event', async () => {
    const { h } = await openHarness(database, harnesses);
    const source = { type: 'bundle', bundle: bundleOf({ body: INJECTION_TEXT }) };
    const preview = await previewCase(h, PERSONAS.engineer, source);
    expect(preview.data.injection).toMatchObject({ detected: true, highestSeverity: 'high' });
    expect(preview.data.injection.findings[0]).toMatchObject({ eventId: 'e01', severity: 'high' });

    const res = await createCase(h, PERSONAS.engineer, source);
    expect(res.statusCode).toBe(201);
    expect(res.data.case.injectionDetected).toBe(true);
    expect(res.data.preview.injection.highestSeverity).toBe('high');
    const events = await h.repos(CONTOSO).cases.getAllEvents(res.data.case.id);
    expect(events[0]?.body).toBe(INJECTION_TEXT);
    const [audit] = await auditOf(h, 'case.ingested');
    expect(audit?.details.injectionHighestSeverity).toBe('high');
    expect(JSON.stringify(audit?.details)).not.toContain('Ignore all previous');
  });
});

describe('request format', () => {
  it('rejects a body that is not JSON on the JSON routes with 415', async () => {
    const { h } = await openHarness(database, harnesses);
    const res = await h.call(PERSONAS.engineer, {
      method: 'POST',
      url: '/api/v1/ingestion/preview',
      payload: 'source=sample',
      headers: { 'content-type': 'application/xml' },
    });
    expect(res.statusCode).toBe(415);
    expect(res.data.code).toBe('unsupported_media_type');
  });
});
