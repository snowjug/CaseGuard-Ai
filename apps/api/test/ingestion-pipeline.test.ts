import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_REDACTION_CONFIG } from '@caseguard/schemas';
import { canonicalJson, sha256Hex } from '@caseguard/security';
import { normalizeBundle } from '@caseguard/domain';
import { sampleByRole } from '../src/samples';
import { runPipeline } from '../src/services/ingestion/pipeline';
import { redactionOptionsFor } from '../src/services/ingestion/redact';
import type { PipelineEnv } from '../src/services/ingestion/types';
import { INJECTION_TEXT, bundleOf, pipelineEnv, secrets } from './ingestion-fixtures';

const env = pipelineEnv;

const PRIMARY = sampleByRole('primary');
const run = (bundle: unknown, overrides: Partial<PipelineEnv> = {}) =>
  runPipeline({ type: 'bundle', bundle }, env(overrides));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('built-in samples through the pipeline', () => {
  it('[FR-ING-01] accepts the primary sample with an exact summary and no redaction or injection', async () => {
    const outcome = await runPipeline({ type: 'sample', sampleId: PRIMARY.id }, env());
    expect(outcome.preview).toMatchObject({
      ok: true,
      sourceKind: 'builtin_sample',
      synthetic: true,
      alreadyIngestedCaseId: null,
      issues: [],
      redaction: { applied: false, totalReplacements: 0, findings: [] },
      injection: { detected: false, highestSeverity: 'none', findings: [] },
      summary: {
        reference: 'CG-SYN-1001',
        eventCount: 31,
        participantCount: 6,
        hasResolution: true,
      },
    });
    expect(outcome.preview.eventsPreview).toHaveLength(25);
    expect(outcome.preview.sizeBytes).toBe(Buffer.byteLength(PRIMARY.json, 'utf8'));
    expect(outcome.prepared?.fileName).toBe(PRIMARY.fileName);
  });

  it('[FR-ING-08] the content hash is the SHA-256 of the canonical redacted payload and is stable', async () => {
    const first = await runPipeline({ type: 'sample', sampleId: PRIMARY.id }, env());
    const second = await runPipeline({ type: 'sample', sampleId: PRIMARY.id }, env());
    expect(first.preview.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(second.preview.contentHash).toBe(first.preview.contentHash);
    expect(first.prepared?.contentHash).toBe(first.preview.contentHash);
    expect(sha256Hex(first.prepared?.storedPayload ?? '')).toBe(first.preview.contentHash);
    expect(first.prepared?.storedPayload).toBe(canonicalJson(first.prepared?.bundle));
  });

  it('answers 404 for a sample that does not exist', async () => {
    await expect(
      runPipeline({ type: 'sample', sampleId: 'no-such-sample' }, env()),
    ).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('redaction (FR-ING-04)', () => {
  const token = (seed: number): string => secrets.githubToken(seed);
  const mail = (name: string): string => `${name}@real-company.com`;

  function plantedBundle(): { bundle: Record<string, unknown>; planted: string[] } {
    const base = bundleOf();
    const events = base.events as Record<string, unknown>[];
    const password = secrets.password();
    const planted = [
      ...Array.from({ length: 11 }, (_, index) => token(index + 1)),
      mail('jane.doe'),
      mail('john.roe'),
      password,
    ];
    const bundle = {
      ...base,
      case: {
        ...(base.case as object),
        title: `Fix for ${token(1)} in the portal`,
        customerAlias: `Contoso ${mail('jane.doe')}`,
        tags: ['synthetic', token(2)],
      },
      participants: [
        { id: 'p-cust', role: 'customer_admin', alias: `Admin ${mail('john.roe')}` },
        { id: 'p-eng', role: 'support_engineer', alias: 'Support Engineer 1' },
      ],
      events: [
        {
          ...events[0],
          title: `Title ${token(3)}`,
          body: `Body ${token(4)}`,
          action: { label: `Action ${token(5)}`, customerEffort: 'none', destructive: false },
          structured: { password, note: 'plain' },
        },
        { ...events[1], correlationIds: [`corr-${token(6)}`] },
        events[2],
      ],
      resolution: {
        resolvedAt: '2026-05-05T11:00:00Z',
        summary: `Summary ${token(7)}`,
        rootCause: `Cause ${token(8)}`,
        workaround: `Workaround ${token(9)}`,
        permanentFix: `Fix ${token(10)}`,
        validation: {
          validatedAt: '2026-05-05T11:30:00Z',
          method: `Method ${token(11)}`,
          outcome: 'confirmed',
          evidenceEventIds: [],
        },
      },
    };
    return { bundle, planted };
  }

  it('[FR-ING-04] redacts every free-text field and never lets a secret out of the pipeline', async () => {
    const { bundle, planted } = plantedBundle();
    const outcome = await run(bundle);
    expect(outcome.preview.issues).toEqual([]);
    expect(outcome.preview.ok).toBe(true);

    const everything = JSON.stringify(outcome);
    for (const secret of planted) expect(everything).not.toContain(secret);

    expect(outcome.preview.redaction).toEqual({
      applied: true,
      totalReplacements: 14,
      findings: [
        {
          category: 'password_assignment',
          count: 1,
          placeholder: '[REDACTED:password_assignment]',
        },
        { category: 'github_token', count: 11, placeholder: '[REDACTED:github_token]' },
        { category: 'email_address', count: 2, placeholder: '[REDACTED:email_address]' },
      ],
    });
    const byEvent = outcome.prepared?.redactionByEventId ?? {};
    expect(Object.keys(byEvent).sort()).toEqual(['e01', 'e02']);
    expect(byEvent.e01).toEqual({
      redacted: true,
      categories: ['password_assignment', 'github_token'],
    });
    expect(byEvent.e02).toEqual({ redacted: true, categories: ['github_token'] });
    expect(outcome.prepared?.bundle.events[0]?.structured).toEqual({
      password: '[REDACTED:password_assignment]',
      note: 'plain',
    });
    expect(outcome.preview.eventsPreview[0]?.bodyExcerpt).toBe('Body [REDACTED:github_token]');
  });

  it('[FR-ING-04] two payloads that differ only in a secret collapse to one content hash', async () => {
    const a = await run(bundleOf({ body: `Key ${secrets.githubToken(11)} was rotated` }));
    const b = await run(bundleOf({ body: `Key ${secrets.githubToken(12)} was rotated` }));
    expect(a.preview.contentHash).toBe(b.preview.contentHash);
  });

  it('[FR-ING-08] the hash does not depend on the order of keys in the JSON', async () => {
    const original = bundleOf();
    const reversed = Object.fromEntries(Object.entries(original).reverse());
    expect((await run(reversed)).preview.contentHash).toBe(
      (await run(original)).preview.contentHash,
    );
  });

  it('[FR-ING-04] governance can switch personal-data categories off but never the secret ones', async () => {
    const body = `Contact ${mail('jane.doe')} about ${secrets.githubToken()}`;
    const outcome = await run(bundleOf({ body }), {
      redaction: { ...DEFAULT_REDACTION_CONFIG, enabledCategories: [] },
    });
    const stored = outcome.prepared?.bundle.events[0]?.body ?? '';
    expect(stored).toContain(mail('jane.doe'));
    expect(stored).toContain('[REDACTED:github_token]');
    expect(
      redactionOptionsFor({ ...DEFAULT_REDACTION_CONFIG, enabledCategories: [] }, true)
        .enabledCategories,
    ).toContain('jwt');
  });

  it('[FR-ING-04] reserved test values stay readable in synthetic data and are redacted in real data', async () => {
    const body =
      'The resolver 10.20.1.11 and the mailbox ops@contoso.example.invalid are fictional.';
    const synthetic = await run(bundleOf({ body }));
    expect(synthetic.preview.redaction.totalReplacements).toBe(0);
    expect(synthetic.prepared?.bundle.events[0]?.body).toBe(body);

    const real = await run(bundleOf({ body, synthetic: false }), { tenantSynthetic: false });
    expect(real.preview.ok).toBe(true);
    expect(real.preview.redaction.findings.map((finding) => finding.category)).toEqual([
      'email_address',
      'ipv4_address',
    ]);
    expect(real.prepared?.bundle.events[0]?.body).not.toContain('10.20.1.11');
  });

  it('refuses a reference or workload that looks like a credential instead of storing it', async () => {
    const bundle = bundleOf({ reference: secrets.awsAccessKeyId() });
    const outcome = await run(bundle);
    expect(outcome.preview.ok).toBe(false);
    expect(outcome.prepared).toBeNull();
    expect(outcome.preview.issues[0]).toMatchObject({ severity: 'error', path: 'case.reference' });
  });

  describe('a tenant pattern that matches ticket ids (review L2)', () => {
    const redaction = {
      ...DEFAULT_REDACTION_CONFIG,
      customPatterns: [{ name: 'support ticket ids', pattern: 'CG-[A-Z]+-[0-9]{4}' }],
    };

    it('still ingests the built-in sample, whose reference is exactly such an id', async () => {
      const outcome = await runPipeline(
        { type: 'sample', sampleId: PRIMARY.id },
        env({ redaction }),
      );
      expect(outcome.preview.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
      expect(outcome.preview.ok).toBe(true);
      expect(outcome.prepared?.bundle.case.reference).toBe('CG-SYN-1001');
    });

    it('stores a reference that matches the pattern as given, even when the same id is in the text', async () => {
      const bundle = bundleOf({
        reference: 'CG-ABC-1234',
        body: 'Please look at CG-ABC-1234 again.',
      });
      const outcome = await run(bundle, { redaction });
      expect(outcome.preview.ok).toBe(true);
      expect(outcome.prepared?.bundle.case.reference).toBe('CG-ABC-1234');
    });

    it('leaves the built-in credential rules on the reference and the workload in force', async () => {
      const credential = await run(bundleOf({ reference: secrets.awsAccessKeyId() }), {
        redaction,
      });
      expect(credential.preview.ok).toBe(false);
      expect(credential.preview.issues[0]).toMatchObject({
        severity: 'error',
        path: 'case.reference',
      });
    });
  });
});

describe('prompt injection screening (NFR-SEC-05)', () => {
  it('flags instructions in event text, keeps the text and reports only a summary', async () => {
    const outcome = await run(bundleOf({ body: INJECTION_TEXT }));
    expect(outcome.preview.ok).toBe(true);
    expect(outcome.preview.injection.detected).toBe(true);
    expect(outcome.preview.injection.highestSeverity).toBe('high');
    expect(outcome.preview.injection.findings[0]).toMatchObject({
      eventId: 'e01',
      severity: 'high',
    });
    expect(outcome.prepared?.bundle.events[0]?.body).toBe(INJECTION_TEXT);
  });

  it('does not flag ordinary support language', async () => {
    const outcome = await run(
      bundleOf({ body: 'Please ignore the previous error message; it was a typo.' }),
    );
    expect(outcome.preview.injection.detected).toBe(false);
  });

  it('scans the resolution and case labels too', async () => {
    const base = bundleOf();
    const bundle = {
      ...base,
      resolution: {
        resolvedAt: '2026-05-05T11:00:00Z',
        summary: INJECTION_TEXT,
        rootCause: 'A DNS policy change.',
      },
    };
    const outcome = await run(bundle);
    expect(outcome.preview.injection.detected).toBe(true);
    expect(outcome.preview.injection.findings[0]?.eventId).toBeNull();
  });
});

describe('semantic validation and bad bundles (FR-ING-02)', () => {
  it('refuses a reply that points at a later event, with the same path ingestion would report', async () => {
    const base = bundleOf();
    const events = base.events as Record<string, unknown>[];
    const outcome = await run({
      ...base,
      events: [{ ...events[0], inResponseTo: 'e02' }, events[1], events[2]],
    });
    expect(outcome.preview.ok).toBe(false);
    expect(outcome.preview.issues[0]).toMatchObject({
      path: 'events[0].inResponseTo',
      severity: 'error',
    });
  });

  it('reports schema problems per field and never echoes a secret pasted into a wrong field', async () => {
    const secret = secrets.githubToken();
    const base = bundleOf();
    const outcome = await run({ ...base, case: { ...(base.case as object), severity: secret } });
    expect(outcome.preview.ok).toBe(false);
    expect(outcome.preview.issues.some((issue) => issue.path.includes('severity'))).toBe(true);
    expect(JSON.stringify(outcome)).not.toContain(secret);
  });
});

describe('large inputs', () => {
  it('yields to the event loop between phases for a large payload more than for a small one', async () => {
    const spy = vi.spyOn(globalThis, 'setImmediate');
    const callsDuring = async (bundle: unknown): Promise<number> => {
      const before = spy.mock.calls.length;
      const outcome = await run(bundle);
      expect(outcome.preview.ok).toBe(true);
      return spy.mock.calls.length - before;
    };

    const small = await callsDuring(bundleOf());
    const large = bundleOf({ eventCount: 150 });
    for (const event of large.events as { body: string }[]) event.body = 'x'.repeat(900);
    const big = await callsDuring(large);
    expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(100_000);
    expect(big - small).toBeGreaterThanOrEqual(5);
  });
});

describe('identifiers that are called like members of Object.prototype', () => {
  it('keeps the per-event redaction metadata right for event ids such as "constructor" and "toString"', async () => {
    const base = bundleOf({ eventCount: 3 });
    const ids = ['constructor', 'toString', 'hasOwnProperty'];
    const events = (base.events as { id: string; body: string }[]).map((event, index) => ({
      ...event,
      id: ids[index] ?? event.id,
      ...(index === 1 ? { body: `Token ${secrets.githubToken()} was pasted` } : {}),
    }));
    const outcome = await run({ ...base, events });
    expect(outcome.preview.ok).toBe(true);
    const prepared = outcome.prepared;
    if (prepared === null) throw new Error('the bundle was expected to be accepted');

    const normalized = normalizeBundle(prepared.bundle, {
      tenantId: 'tenant_test',
      caseId: 'case_test',
      sourceId: 'src_test',
      createdBy: 'user_test',
      now: '2026-06-01T09:00:00.000Z',
      sourceKind: 'json_bundle',
      storedPayload: prepared.storedPayload,
      redactionReplacements: outcome.preview.redaction.totalReplacements,
      redactionByEventId: prepared.redactionByEventId,
    });
    const redactionOf = (id: string) =>
      normalized.events.find((event) => event.id === id)?.redaction;
    expect(redactionOf('constructor')).toEqual({ redacted: false, categories: [] });
    expect(redactionOf('toString')).toEqual({ redacted: true, categories: ['github_token'] });
    expect(redactionOf('hasOwnProperty')).toEqual({ redacted: false, categories: [] });
  });
});
