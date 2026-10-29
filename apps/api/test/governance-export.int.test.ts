import {
  DEFAULT_EXPORT_CONTROLS,
  ExportResponseSchema,
  type AuditEvent,
  type CaseEvent,
} from '@caseguard/schemas';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/db';
import { AUDIT_GENESIS_HASH, computeAuditHash } from '../src/db/repositories/audit-repository';
import { TEST_DATABASE_STARTUP_TIMEOUT_MS, resetTestDatabase } from '../src/db/testing';
import { at, buildAuditInput, buildIngestInput, buildReviewDecision } from './builders';
import {
  CONTOSO,
  FABRIKAM,
  PERSONAS,
  createHarness,
  openSharedDatabase,
  type Harness,
} from './support/app-harness';

const API = '/api/v1';
const SECRET = 'Bearer abcdefghijklmnopqrstuvwxyz0123456789';
const NON_EXPORTERS = [
  PERSONAS.engineer,
  PERSONAS.reviewer,
  PERSONAS.manager,
  PERSONAS.curator,
  PERSONAS.otherTenantEngineer,
];

let database: Database;
let h: Harness;

beforeAll(async () => {
  database = await openSharedDatabase();
  h = await createHarness({ database });
}, TEST_DATABASE_STARTUP_TIMEOUT_MS);

afterAll(async () => {
  await h.close();
  await database.close();
});

beforeEach(async () => {
  await resetTestDatabase(database);
});

/** One case with 6 events, 3 participants, a resolution and 2 reviewer decisions (14 records), plus a case of the other tenant. */
async function seedCases(): Promise<void> {
  const contoso = h.repos(CONTOSO);
  await contoso.cases.ingest(
    buildIngestInput({ caseId: 'case_alpha', receivedSeed: 'a', withResolution: true }),
  );
  await contoso.reviews.record(
    buildReviewDecision({ id: 'rev_a1', caseId: 'case_alpha', decidedAt: at(100) }),
  );
  await contoso.reviews.record(
    buildReviewDecision({
      id: 'rev_a2',
      caseId: 'case_alpha',
      decidedAt: at(110),
      reason: `Pasted by mistake: ${SECRET}`,
    }),
  );
  await h.repos(FABRIKAM).cases.ingest(
    buildIngestInput({
      tenantId: FABRIKAM,
      caseId: 'case_fab',
      receivedSeed: 'f',
      title: 'FABRIKAM-ONLY-TITLE',
    }),
  );
}

function requestExport(body: Record<string, unknown>, persona: string | null = PERSONAS.admin) {
  return h.call(persona, { method: 'POST', url: `${API}/governance/export`, payload: body });
}

const exportCase = (caseId = 'case_alpha', persona: string | null = PERSONAS.admin) =>
  requestExport({ scope: 'case', caseId, reason: 'Legal hold request 2026-014' }, persona);

const exportAudit = (persona: string | null = PERSONAS.admin) =>
  requestExport({ scope: 'audit', reason: 'Annual audit review' }, persona);

function setControls(overrides: Partial<typeof DEFAULT_EXPORT_CONTROLS>) {
  return h.call(PERSONAS.admin, {
    method: 'PUT',
    url: `${API}/governance/settings/export_controls`,
    payload: {
      value: { ...DEFAULT_EXPORT_CONTROLS, ...overrides },
      expectedVersion: 1,
      changeNote: 'Export controls for the test',
    },
  });
}

async function events(tenantId: string = CONTOSO): Promise<AuditEvent[]> {
  return (await h.repos(tenantId).audit.list({ limit: 200 })).items;
}
const ofAction = (list: AuditEvent[], action: string): AuditEvent[] =>
  list.filter((event) => event.action === action);

/** Every `tenantId` value found anywhere in a JSON value. */
function tenantIdsIn(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((item) => tenantIdsIn(item, found));
  else if (typeof value === 'object' && value !== null) {
    for (const [key, member] of Object.entries(value)) {
      if (key === 'tenantId' && typeof member === 'string') found.add(member);
      else tenantIdsIn(member, found);
    }
  }
  return found;
}

describe('[FR-GV-01] governance.export (case scope)', () => {
  it('exports the redacted case record and audits the export with ids and counters only', async () => {
    await seedCases();
    const res = await exportCase();
    expect(res.statusCode).toBe(200);
    const body = ExportResponseSchema.parse(res.data);
    expect(body).toMatchObject({
      scope: 'case',
      recordCount: 14,
      exportedAt: '2026-01-15T09:00:00.000Z',
    });
    expect(body.notice).toContain('recorded in the audit log');
    expect(body.notice).toContain('synthetic');

    const data = body.data as {
      format: string;
      case: { id: string; tenantId: string };
      source: Record<string, unknown>;
      participants: unknown[];
      events: CaseEvent[];
      resolution: { caseId: string } | null;
      reviews: { id: string; reason: string }[];
      integrity: { valuesMaskedOnExport: number };
    };
    expect(data.format).toBe('caseguard.case-export');
    expect(data.case).toMatchObject({ id: 'case_alpha', tenantId: CONTOSO });
    expect(data.events.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(data.participants).toHaveLength(3);
    expect(data.resolution?.caseId).toBe('case_alpha');
    expect(data.reviews.map((review) => review.id).sort()).toEqual(['rev_a1', 'rev_a2']);
    // The source attestation is exported unchanged; the object-store key and the payload are not.
    const storedSource = await h.repos(CONTOSO).cases.getSource('case_alpha');
    expect(data.source.storedSha256).toBe(storedSource?.storedSha256);
    expect(data.source.receivedSha256).toBe(storedSource?.receivedSha256);
    expect(data.source).not.toHaveProperty('storageRef');
    expect(JSON.stringify(data)).not.toContain('storedPayload');

    const written = ofAction(await events(), 'export.created');
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      outcome: 'success',
      actorId: PERSONAS.admin,
      actorRole: 'administrator',
      targetType: 'case',
      targetId: 'case_alpha',
      caseId: 'case_alpha',
      details: { scope: 'case', caseId: 'case_alpha', recordCount: 14 },
    });
    expect(Object.keys(written[0]?.details ?? {}).sort()).toEqual([
      'caseId',
      'recordCount',
      'scope',
    ]);
    expect(JSON.stringify(written[0])).not.toContain('Legal hold');
    expect(ofAction(await events(), 'api.governance.export')).toHaveLength(0);
  });

  it('[NFR-SEC-05] masks credentials on the way out without changing the immutable record', async () => {
    await seedCases();
    const res = await exportCase();
    const text = JSON.stringify(res.data);
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(res.data.data.integrity.valuesMaskedOnExport).toBe(1);
    const masked = (res.data.data.reviews as { id: string; reason: string }[]).find(
      (r) => r.id === 'rev_a2',
    );
    expect(masked?.reason).toContain('Pasted by mistake');
    expect(masked?.reason).toContain('REDACTED');
  });

  it('[NFR-PRIV-01] masks a credential that is still in a stored event body, leaving the record intact', async () => {
    const input = buildIngestInput({ caseId: 'case_alpha', receivedSeed: 'a' });
    const dirty = input.events.map((event, index) =>
      index === 1 ? { ...event, body: `Please use this: ${SECRET}` } : event,
    );
    await h.repos(CONTOSO).cases.ingest({ ...input, events: dirty });

    const res = await exportCase();
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.data)).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    const exported = (res.data.data.events as CaseEvent[])[1];
    expect(exported?.body).toContain('Please use this');
    expect(exported?.body).toContain('REDACTED');
    expect(res.data.data.integrity.valuesMaskedOnExport).toBe(1);

    const stored = await h.repos(CONTOSO).cases.getAllEvents('case_alpha');
    expect(stored[1]?.body).toContain('abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('[NFR-SEC-01] never contains another tenant’s data and answers 404 across tenants', async () => {
    await seedCases();
    await h.repos(FABRIKAM).governance.updateUserRoles('user_fabi_engineer', ['administrator'], 1);

    const mine = await exportCase('case_alpha');
    expect(mine.statusCode).toBe(200);
    expect(JSON.stringify(mine.data)).not.toContain('FABRIKAM-ONLY-TITLE');
    expect([...tenantIdsIn(mine.data)]).toEqual([CONTOSO]);

    const intoOther = await exportCase('case_fab');
    expect(intoOther.statusCode).toBe(404);
    expect(intoOther.data.code).toBe('not_found');
    expect(JSON.stringify(intoOther.data)).not.toContain('FABRIKAM-ONLY-TITLE');

    const fromOther = await exportCase('case_alpha', PERSONAS.otherTenantEngineer);
    expect(fromOther.statusCode).toBe(404);

    const theirs = await exportCase('case_fab', PERSONAS.otherTenantEngineer);
    expect(theirs.statusCode).toBe(200);
    expect([...tenantIdsIn(theirs.data)]).toEqual([FABRIKAM]);

    // The attempts on a case that does not exist for the caller export nothing and are recorded as
    // refused in the caller's own trail only.
    const outcomes = async (tenantId: string) =>
      ofAction(await events(tenantId), 'export.created')
        .map((event) => `${event.outcome}:${event.caseId}`)
        .sort();
    expect(await outcomes(CONTOSO)).toEqual(['denied:case_fab', 'success:case_alpha']);
    expect(await outcomes(FABRIKAM)).toEqual(['denied:case_alpha', 'success:case_fab']);
  });

  it('answers 404 for an unknown case and records the refused attempt', async () => {
    const res = await exportCase('case_missing');
    expect(res.statusCode).toBe(404);
    const written = ofAction(await events(), 'export.created');
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      outcome: 'denied',
      actorId: PERSONAS.admin,
      targetType: 'case',
      targetId: 'case_missing',
      details: {
        scope: 'case',
        caseId: 'case_missing',
        recordCount: 0,
        denialReason: 'case_not_found',
      },
    });
  });
});

describe('[FR-GV-01] governance.export (audit scope)', () => {
  it('exports this tenant’s chain with a verification an auditor can repeat independently', async () => {
    await seedCases();
    for (let index = 1; index <= 4; index += 1) {
      await h.repos(CONTOSO).audit.append(buildAuditInput({ details: { n: index } }));
    }
    await h.repos(FABRIKAM).audit.append(
      buildAuditInput({
        action: 'fabrikam.only.action',
        actorId: 'user_fabi_engineer',
        caseId: null,
        targetId: null,
      }),
    );

    const res = await exportAudit();
    expect(res.statusCode).toBe(200);
    const body = ExportResponseSchema.parse(res.data);
    const data = body.data as {
      format: string;
      events: AuditEvent[];
      verification: { valid: boolean; eventsChecked: number };
      chain: {
        genesisHash: string;
        hashRecipe: string;
        head: { sequence: number; hash: string } | null;
      };
      integrity: { eventsWithMaskedDetails: number };
    };
    expect(data.format).toBe('caseguard.audit-export');
    expect(body.recordCount).toBe(data.events.length);
    expect(data.events.map((event) => event.sequence)).toEqual(data.events.map((_, i) => i + 1));
    expect(data.verification).toMatchObject({ valid: true, eventsChecked: data.events.length });
    expect(data.chain.genesisHash).toBe(AUDIT_GENESIS_HASH);
    expect(data.chain.hashRecipe).toContain('sha256');
    const last = data.events.at(-1);
    expect(data.chain.head).toEqual({ sequence: last?.sequence, hash: last?.hash });
    expect(data.integrity.eventsWithMaskedDetails).toBe(0);

    // Independent re-verification from the exported data alone.
    let previous = data.chain.genesisHash;
    for (const event of data.events) {
      const { hash, ...unsigned } = event;
      expect(event.prevHash).toBe(previous);
      expect(computeAuditHash(previous, unsigned)).toBe(hash);
      previous = hash;
    }

    expect(data.events.every((event) => event.tenantId === CONTOSO)).toBe(true);
    expect(JSON.stringify(res.data)).not.toContain('fabrikam.only.action');

    // The export is recorded after the snapshot, so it is not part of it.
    const written = ofAction(await events(), 'export.created');
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      outcome: 'success',
      targetType: 'audit_log',
      caseId: null,
      details: { scope: 'audit', caseId: null, recordCount: data.events.length },
    });
    expect(data.events.some((event) => event.action === 'export.created')).toBe(false);
  });

  it('includes a failed verification instead of hiding it', async () => {
    for (let index = 1; index <= 4; index += 1) {
      await h.repos(CONTOSO).audit.append(buildAuditInput({ details: { n: index } }));
    }
    await database.transaction(async (tx) => {
      await tx.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_immutable');
      await tx.query(
        `UPDATE audit_events SET details = '{"n": 999}'::jsonb WHERE tenant_id = '${CONTOSO}' AND sequence = 2`,
      );
      await tx.query('ALTER TABLE audit_events ENABLE ALWAYS TRIGGER audit_events_immutable');
    });
    const res = await exportAudit();
    expect(res.statusCode).toBe(200);
    expect(res.data.data.verification).toMatchObject({ valid: false, firstInvalidSequence: 2 });
  });

  it('[NFR-SEC-05] masks credentials found in stored details and says how many events it touched', async () => {
    await h.repos(CONTOSO).audit.append(
      buildAuditInput({
        action: 'test.leaky',
        // secretscan:allow-next-line synthetic credential that proves the audit export masks secrets
        details: { apiKey: 'sk-live-should-not-be-here-0123456789' },
      }),
    );
    const res = await exportAudit();
    expect(JSON.stringify(res.data)).not.toContain('sk-live');
    expect(res.data.data.integrity.eventsWithMaskedDetails).toBe(1);
  });
});

describe('[FR-GV-01] export controls', () => {
  it('refuses a kind of export that the controls switch off (403) and records the denial', async () => {
    await seedCases();
    expect((await setControls({ allowCaseExport: false })).statusCode).toBe(200);

    const res = await exportCase();
    expect(res.statusCode).toBe(403);
    expect(res.data.code).toBe('forbidden');
    expect(res.data.detail).toContain('disabled');
    expect(JSON.stringify(res.data)).not.toContain('case_alpha');

    const trail = await events();
    const denied = ofAction(trail, 'export.created');
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({
      outcome: 'denied',
      caseId: 'case_alpha',
      details: {
        scope: 'case',
        caseId: 'case_alpha',
        recordCount: 0,
        denialReason: 'case_export_disabled',
      },
    });
    expect(ofAction(trail, 'access.denied')).toHaveLength(1);

    // The other kind stays available, and switching it off works the same way.
    expect((await exportAudit()).statusCode).toBe(200);
  });

  it('refuses an audit export when audit export is disabled', async () => {
    expect((await setControls({ allowAuditExport: false })).statusCode).toBe(200);
    const res = await exportAudit();
    expect(res.statusCode).toBe(403);
    const denied = ofAction(await events(), 'export.created');
    expect(denied[0]).toMatchObject({
      outcome: 'denied',
      details: { scope: 'audit', denialReason: 'audit_export_disabled' },
    });
  });

  it('refuses a case export above the record cap (409) before and after reading it', async () => {
    await seedCases();
    expect((await setControls({ maxRecordsPerExport: 5 })).statusCode).toBe(200);
    const early = await exportCase();
    expect(early.statusCode).toBe(409);
    expect(early.data.code).toBe('conflict');
    expect(early.data.detail).toContain('at most 5');
    const first = ofAction(await events(), 'export.created')[0];
    expect(first).toMatchObject({
      outcome: 'denied',
      details: { scope: 'case', recordCount: 8, denialReason: 'record_cap_exceeded' },
    });
  });

  it('counts reviewer decisions against the cap and allows exactly the cap', async () => {
    await seedCases();
    expect((await setControls({ maxRecordsPerExport: 13 })).statusCode).toBe(200);
    const over = await exportCase();
    expect(over.statusCode).toBe(409);
    expect(over.data.detail).toContain('14 records');

    // The settings change is its own audited step; raise the cap by one version.
    const raised = await h.call(PERSONAS.admin, {
      method: 'PUT',
      url: `${API}/governance/settings/export_controls`,
      payload: {
        value: { ...DEFAULT_EXPORT_CONTROLS, maxRecordsPerExport: 14 },
        expectedVersion: 2,
        changeNote: 'Raise the cap to the exact size',
      },
    });
    expect(raised.statusCode).toBe(200);
    const exact = await exportCase();
    expect(exact.statusCode).toBe(200);
    expect(exact.data.recordCount).toBe(14);
  });

  it('refuses an oversized audit chain without loading it', async () => {
    for (let index = 1; index <= 5; index += 1) {
      await h.repos(CONTOSO).audit.append(buildAuditInput({ details: { n: index } }));
    }
    expect((await setControls({ maxRecordsPerExport: 3 })).statusCode).toBe(200);
    const res = await exportAudit();
    expect(res.statusCode).toBe(409);
    expect(res.data.code).toBe('conflict');
    const denied = ofAction(await events(), 'export.created');
    expect(denied).toHaveLength(1);
    expect(denied[0]?.outcome).toBe('denied');
    expect(denied[0]?.details).toMatchObject({
      scope: 'audit',
      denialReason: 'record_cap_exceeded',
    });
    expect(Number(denied[0]?.details.recordCount)).toBeGreaterThan(3);
  });
});

describe('[NFR-SEC-02] export validation and permissions', () => {
  it('requires a reason, and a case id exactly for the case scope (422 with paths)', async () => {
    await seedCases();
    const noCase = await requestExport({ scope: 'case', reason: 'Legal hold request' });
    expect(noCase.statusCode).toBe(422);
    expect(noCase.data.errors.map((issue: { path: string }) => issue.path)).toEqual([
      'body.caseId',
    ]);

    const extraCase = await requestExport({
      scope: 'audit',
      caseId: 'case_alpha',
      reason: 'Legal hold request',
    });
    expect(extraCase.statusCode).toBe(422);
    expect(extraCase.data.errors[0].path).toBe('body.caseId');

    const blank = await requestExport({ scope: 'audit', reason: '        ' });
    expect(blank.statusCode).toBe(422);
    expect(blank.data.errors[0].path).toBe('body.reason');

    const short = await requestExport({ scope: 'audit', reason: 'abc' });
    expect(short.statusCode).toBe(422);
    expect(short.data.errors[0].path).toBe('body.reason');

    expect((await requestExport({ scope: 'zip', reason: 'Legal hold request' })).statusCode).toBe(
      422,
    );
    expect(ofAction(await events(), 'export.created')).toHaveLength(0);
  });

  it('is limited to export:data holders: administrators only', async () => {
    await seedCases();
    for (const persona of NON_EXPORTERS) {
      const res = await exportCase('case_alpha', persona);
      expect(res.statusCode).toBe(403);
      expect(JSON.stringify(res.data)).not.toContain('case_alpha');
    }
    expect((await exportCase('case_alpha', null)).statusCode).toBe(401);
    expect(ofAction(await events(), 'export.created')).toHaveLength(0);
    // The binder records each refusal in the tenant of the caller; Fabrikam's lands in its own log.
    expect(ofAction(await events(), 'access.denied')).toHaveLength(NON_EXPORTERS.length - 1);
    expect(ofAction(await events(FABRIKAM), 'access.denied')).toHaveLength(1);
  });
});
