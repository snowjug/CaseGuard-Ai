import {
  AuditEventSchema,
  AuditVerificationSchema,
  ReviewDecisionSchema,
  type AuditEvent,
} from '@caseguard/schemas';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/db';
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
const REVIEW_READERS = [PERSONAS.reviewer, PERSONAS.admin];
const NO_AUDIT_ACCESS = [
  PERSONAS.engineer,
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

async function seedAudit(count: number, tenantId: string = CONTOSO): Promise<AuditEvent[]> {
  const repos = h.repos(tenantId);
  const written: AuditEvent[] = [];
  for (let index = 1; index <= count; index += 1) {
    written.push(
      await repos.audit.append(
        buildAuditInput({
          action: index % 2 === 0 ? 'case.viewed' : 'case.ingested',
          caseId: index <= 2 ? 'case_alpha' : null,
          targetId: index <= 2 ? 'case_alpha' : null,
          outcome: index === 3 ? 'denied' : 'success',
          actorId: index === 4 ? 'user_riley_reviewer' : 'user_ava_engineer',
          details: { n: index },
          occurredAt: at(index * 10),
        }),
      ),
    );
  }
  return written;
}

describe('[NFR-SEC-07] governance.audit', () => {
  it('lists the tenant’s events newest first and pages with an opaque cursor', async () => {
    await seedAudit(5);
    const first = await h.call(PERSONAS.admin, { method: 'GET', url: `${API}/audit?limit=2` });
    expect(first.statusCode).toBe(200);
    const page = first.data as { items: AuditEvent[]; nextCursor: string | null };
    page.items.forEach((event) => AuditEventSchema.parse(event));
    expect(page.items.map((event) => event.sequence)).toEqual([5, 4]);
    expect(page.nextCursor).not.toBeNull();

    const second = await h.call(PERSONAS.admin, {
      method: 'GET',
      url: `${API}/audit?limit=3&cursor=${encodeURIComponent(page.nextCursor ?? '')}`,
    });
    expect(second.statusCode).toBe(200);
    expect(second.data.items.map((event: AuditEvent) => event.sequence)).toEqual([3, 2, 1]);
    expect(second.data.nextCursor).toBeNull();
  });

  it('filters by action, actor, case, outcome and time window', async () => {
    await seedAudit(5);
    const get = async (query: string) =>
      (await h.call(PERSONAS.admin, { method: 'GET', url: `${API}/audit?${query}` })).data
        .items as AuditEvent[];

    expect((await get('action=case.viewed')).map((e) => e.sequence)).toEqual([4, 2]);
    expect((await get('actorId=user_riley_reviewer')).map((e) => e.sequence)).toEqual([4]);
    expect((await get('caseId=case_alpha')).map((e) => e.sequence)).toEqual([2, 1]);
    expect((await get('outcome=denied')).map((e) => e.sequence)).toEqual([3]);
    const window = await get(
      `from=${encodeURIComponent(at(20))}&to=${encodeURIComponent(at(40))}&limit=50`,
    );
    expect(window.filter((e) => e.action.startsWith('case.')).map((e) => e.sequence)).toEqual([
      4, 3, 2,
    ]);
  });

  it('rejects a reversed time window and malformed filters with 422', async () => {
    const reversed = await h.call(PERSONAS.admin, {
      method: 'GET',
      url: `${API}/audit?from=${encodeURIComponent(at(40))}&to=${encodeURIComponent(at(20))}`,
    });
    expect(reversed.statusCode).toBe(422);
    expect(reversed.data.errors[0].path).toBe('query.from');
    expect(
      (await h.call(PERSONAS.admin, { method: 'GET', url: `${API}/audit?outcome=maybe` }))
        .statusCode,
    ).toBe(422);
    expect(
      (await h.call(PERSONAS.admin, { method: 'GET', url: `${API}/audit?limit=0` })).statusCode,
    ).toBe(422);
    expect(
      (await h.call(PERSONAS.admin, { method: 'GET', url: `${API}/audit?cursor=not-a-cursor` }))
        .statusCode,
    ).toBe(422);
  });

  it('[NFR-SEC-02] is readable by reviewers and administrators only', async () => {
    for (const persona of REVIEW_READERS) {
      expect((await h.call(persona, { method: 'GET', url: `${API}/audit` })).statusCode).toBe(200);
    }
    for (const persona of NO_AUDIT_ACCESS) {
      const res = await h.call(persona, { method: 'GET', url: `${API}/audit` });
      expect(res.statusCode).toBe(403);
    }
    expect((await h.call(null, { method: 'GET', url: `${API}/audit` })).statusCode).toBe(401);
  });

  it('[NFR-SEC-01] never shows another tenant’s events, in either direction', async () => {
    await seedAudit(3);
    await h.repos(FABRIKAM).audit.append(
      buildAuditInput({
        action: 'fabrikam.only.action',
        actorId: 'user_fabi_engineer',
        caseId: null,
        targetId: null,
      }),
    );
    await h.repos(FABRIKAM).governance.updateUserRoles('user_fabi_engineer', ['administrator'], 1);

    const mine = await h.call(PERSONAS.admin, { method: 'GET', url: `${API}/audit?limit=200` });
    const mineEvents = mine.data.items as AuditEvent[];
    expect(mineEvents.every((event) => event.tenantId === CONTOSO)).toBe(true);
    expect(JSON.stringify(mine.data)).not.toContain('fabrikam.only.action');

    const theirs = await h.call(PERSONAS.otherTenantEngineer, {
      method: 'GET',
      url: `${API}/audit?limit=200`,
    });
    expect(theirs.statusCode).toBe(200);
    const theirEvents = theirs.data.items as AuditEvent[];
    expect(theirEvents.every((event) => event.tenantId === FABRIKAM)).toBe(true);
    expect(theirEvents.some((event) => event.action === 'fabrikam.only.action')).toBe(true);
    expect(theirEvents.some((event) => event.action === 'case.ingested')).toBe(false);

    // A tenant filter cannot be widened through a case id from the other tenant either.
    const probe = await h.call(PERSONAS.otherTenantEngineer, {
      method: 'GET',
      url: `${API}/audit?caseId=case_alpha`,
    });
    expect(probe.data.items).toEqual([]);
  });

  it('[NFR-SEC-05] masks credentials in details that should never have been stored', async () => {
    await h.repos(CONTOSO).audit.append(
      buildAuditInput({
        action: 'test.leaky',
        details: {
          // secretscan:allow-next-line synthetic credential that proves the audit export masks secrets
          apiKey: 'sk-live-should-not-be-here-0123456789',
          note: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789',
          section: 'export_controls',
          inputHash: 'c'.repeat(64),
        },
      }),
    );
    const res = await h.call(PERSONAS.admin, {
      method: 'GET',
      url: `${API}/audit?action=test.leaky`,
    });
    const [event] = res.data.items as AuditEvent[];
    expect(event?.details.section).toBe('export_controls');
    expect(event?.details.inputHash).toBe('c'.repeat(64));
    const text = JSON.stringify(res.data);
    expect(text).not.toContain('sk-live');
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('records the read of the audit log itself', async () => {
    await h.call(PERSONAS.admin, { method: 'GET', url: `${API}/audit` });
    const trail = (await h.repos(CONTOSO).audit.list({ limit: 50, action: 'api.governance.audit' }))
      .items;
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({ actorId: PERSONAS.admin, outcome: 'success' });
  });
});

describe('[NFR-SEC-07] governance.auditVerify', () => {
  it('verifies an intact chain and an empty one', async () => {
    const empty = await h.call(PERSONAS.admin, { method: 'GET', url: `${API}/audit/verify` });
    expect(empty.statusCode).toBe(200);
    expect(AuditVerificationSchema.parse(empty.data)).toMatchObject({
      valid: true,
      eventsChecked: 0,
      firstInvalidSequence: null,
    });

    await seedAudit(4);
    const res = await h.call(PERSONAS.reviewer, { method: 'GET', url: `${API}/audit/verify` });
    expect(AuditVerificationSchema.parse(res.data)).toMatchObject({
      valid: true,
      eventsChecked: 4,
      firstInvalidSequence: null,
    });
  });

  it('reports the first invalid sequence after tampering, for this tenant only', async () => {
    await seedAudit(5);
    await h.repos(FABRIKAM).audit.append(buildAuditInput({ actorId: 'user_fabi_engineer' }));
    await h.repos(FABRIKAM).governance.updateUserRoles('user_fabi_engineer', ['administrator'], 1);
    await database.transaction(async (tx) => {
      await tx.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_immutable');
      await tx.query(
        `UPDATE audit_events SET details = '{"n": 999}'::jsonb WHERE tenant_id = '${CONTOSO}' AND sequence = 3`,
      );
      await tx.query('ALTER TABLE audit_events ENABLE ALWAYS TRIGGER audit_events_immutable');
    });

    const broken = await h.call(PERSONAS.admin, { method: 'GET', url: `${API}/audit/verify` });
    expect(AuditVerificationSchema.parse(broken.data)).toMatchObject({
      valid: false,
      firstInvalidSequence: 3,
      eventsChecked: 2,
    });
    expect(broken.data.detail).toContain('modified');

    const theirs = await h.call(PERSONAS.otherTenantEngineer, {
      method: 'GET',
      url: `${API}/audit/verify`,
    });
    expect(AuditVerificationSchema.parse(theirs.data)).toMatchObject({
      valid: true,
      eventsChecked: 1,
    });
  });

  it('is limited to audit:read holders', async () => {
    for (const persona of NO_AUDIT_ACCESS) {
      expect(
        (await h.call(persona, { method: 'GET', url: `${API}/audit/verify` })).statusCode,
      ).toBe(403);
    }
    expect((await h.call(null, { method: 'GET', url: `${API}/audit/verify` })).statusCode).toBe(
      401,
    );
  });
});

describe('[FR-EV-03] governance.reviews', () => {
  async function seedReviews(): Promise<void> {
    await h
      .repos(CONTOSO)
      .cases.ingest(buildIngestInput({ caseId: 'case_alpha', receivedSeed: 'a' }));
    await h
      .repos(CONTOSO)
      .cases.ingest(
        buildIngestInput({ caseId: 'case_beta', receivedSeed: 'b', reference: 'CG-1002' }),
      );
    const repos = h.repos(CONTOSO);
    await repos.reviews.record(
      buildReviewDecision({ id: 'rev_a1', caseId: 'case_alpha', decidedAt: at(100) }),
    );
    await repos.reviews.record(
      buildReviewDecision({
        id: 'rev_a2',
        caseId: 'case_alpha',
        decidedAt: at(110),
        reason: 'Pasted a token by mistake: Bearer abcdefghijklmnopqrstuvwxyz0123456789',
      }),
    );
    await repos.reviews.record(
      buildReviewDecision({ id: 'rev_b1', caseId: 'case_beta', decidedAt: at(120) }),
    );
    await h
      .repos(FABRIKAM)
      .cases.ingest(
        buildIngestInput({ tenantId: FABRIKAM, caseId: 'case_fab', receivedSeed: 'f' }),
      );
    await h.repos(FABRIKAM).reviews.record(
      buildReviewDecision({
        tenantId: FABRIKAM,
        id: 'rev_f1',
        caseId: 'case_fab',
        reviewerId: 'user_fabi_engineer',
        reason: 'FABRIKAM-ONLY-REASON',
      }),
    );
  }

  it('lists decisions newest first, filtered by case and paged', async () => {
    await seedReviews();
    const all = await h.call(PERSONAS.reviewer, {
      method: 'GET',
      url: `${API}/governance/reviews`,
    });
    expect(all.statusCode).toBe(200);
    (all.data.items as unknown[]).forEach((item) => ReviewDecisionSchema.parse(item));
    expect(all.data.items.map((item: { id: string }) => item.id)).toEqual([
      'rev_b1',
      'rev_a2',
      'rev_a1',
    ]);

    const filtered = await h.call(PERSONAS.admin, {
      method: 'GET',
      url: `${API}/governance/reviews?caseId=case_alpha`,
    });
    expect(filtered.data.items.map((item: { id: string }) => item.id)).toEqual([
      'rev_a2',
      'rev_a1',
    ]);

    const page1 = await h.call(PERSONAS.reviewer, {
      method: 'GET',
      url: `${API}/governance/reviews?limit=2`,
    });
    expect(page1.data.items).toHaveLength(2);
    expect(page1.data.nextCursor).not.toBeNull();
    const page2 = await h.call(PERSONAS.reviewer, {
      method: 'GET',
      url: `${API}/governance/reviews?limit=2&cursor=${encodeURIComponent(page1.data.nextCursor)}`,
    });
    expect(page2.data.items.map((item: { id: string }) => item.id)).toEqual(['rev_a1']);
    expect(page2.data.nextCursor).toBeNull();
  });

  it('[NFR-SEC-01] never lists another tenant’s decisions', async () => {
    await seedReviews();
    const res = await h.call(PERSONAS.admin, {
      method: 'GET',
      url: `${API}/governance/reviews?limit=200`,
    });
    expect(JSON.stringify(res.data)).not.toContain('FABRIKAM-ONLY-REASON');
    expect(
      (res.data.items as { tenantId: string }[]).every((item) => item.tenantId === CONTOSO),
    ).toBe(true);
    const probe = await h.call(PERSONAS.admin, {
      method: 'GET',
      url: `${API}/governance/reviews?caseId=case_fab`,
    });
    expect(probe.data.items).toEqual([]);
  });

  it('[NFR-SEC-05] masks credentials that a reviewer pasted into a reason', async () => {
    await seedReviews();
    const res = await h.call(PERSONAS.reviewer, {
      method: 'GET',
      url: `${API}/governance/reviews`,
    });
    expect(JSON.stringify(res.data)).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    const masked = (res.data.items as { id: string; reason: string }[]).find(
      (item) => item.id === 'rev_a2',
    );
    expect(masked?.reason).toContain('REDACTED');
    expect(masked?.reason).toContain('Pasted a token by mistake');
  });

  it('is limited to audit:read holders', async () => {
    for (const persona of NO_AUDIT_ACCESS) {
      expect(
        (await h.call(persona, { method: 'GET', url: `${API}/governance/reviews` })).statusCode,
      ).toBe(403);
    }
    expect(
      (await h.call(null, { method: 'GET', url: `${API}/governance/reviews` })).statusCode,
    ).toBe(401);
  });
});
