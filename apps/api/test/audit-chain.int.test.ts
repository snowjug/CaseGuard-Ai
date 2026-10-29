import { AuditEventSchema, type AuditEvent } from '@caseguard/schemas';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ValidationFailedError } from '../src/errors';
import { AUDIT_GENESIS_HASH, computeAuditHash } from '../src/db/repositories/audit-repository';
import {
  CONTOSO_SCOPE,
  TEST_DATABASE_STARTUP_TIMEOUT_MS,
  createTestRepositories,
  type TestHarness,
} from '../src/db/testing';
import { buildAuditInput, at } from './builders';

let h: TestHarness;

beforeAll(async () => {
  h = await createTestRepositories({ clockStepMs: 1000 });
}, TEST_DATABASE_STARTUP_TIMEOUT_MS);
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.reset();
});

async function appendMany(count: number): Promise<AuditEvent[]> {
  const events: AuditEvent[] = [];
  for (let i = 1; i <= count; i += 1) {
    events.push(
      await h.contoso().audit.append(buildAuditInput({ details: { n: i }, action: `step.${i}` })),
    );
  }
  return events;
}

/** What a database administrator would do: switch the guard trigger off, edit, switch it back on. */
async function tamper(sql: string): Promise<void> {
  await h.database.transaction(async (tx) => {
    await tx.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_immutable');
    await tx.query(sql);
    await tx.query('ALTER TABLE audit_events ENABLE ALWAYS TRIGGER audit_events_immutable');
  });
}

describe('[NFR-SEC-07] the audit log is an append-only hash chain', () => {
  it('assigns increasing sequences and links each event to the previous hash', async () => {
    const events = await appendMany(4);
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3, 4]);
    expect(events[0]?.prevHash).toBe(AUDIT_GENESIS_HASH);
    for (let i = 1; i < events.length; i += 1) {
      expect(events[i]?.prevHash).toBe(events[i - 1]?.hash);
    }
    // The recipe is public and independently reproducible: sha256(prevHash + "\n" + canonical JSON).
    for (const event of events) {
      const { hash, ...unsigned } = event;
      expect(computeAuditHash(event.prevHash, unsigned)).toBe(hash);
      AuditEventSchema.parse(event);
    }
    expect(new Set(events.map((e) => e.id)).size).toBe(4);
  });

  it('verifies an intact chain, an empty chain and a chain larger than one verification batch', async () => {
    expect(await h.contoso().audit.verify()).toMatchObject({
      valid: true,
      eventsChecked: 0,
      firstInvalidSequence: null,
    });
    await appendMany(3);
    expect(await h.contoso().audit.verify()).toMatchObject({
      valid: true,
      eventsChecked: 3,
      firstInvalidSequence: null,
    });

    // 515 events cross the 500-row verification batch boundary.
    for (let i = 0; i < 512; i += 1)
      await h.contoso().audit.append(buildAuditInput({ details: { bulk: i } }));
    const verification = await h.contoso().audit.verify();
    expect(verification).toMatchObject({ valid: true, eventsChecked: 515 });
  });

  it('serialises concurrent appends: no duplicate or skipped sequence', async () => {
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        h.contoso().audit.append(buildAuditInput({ details: { i } })),
      ),
    );
    expect(results.map((e) => e.sequence).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 25 }, (_, i) => i + 1),
    );
    expect(await h.contoso().audit.verify()).toMatchObject({ valid: true, eventsChecked: 25 });
  });

  it('flags a modified event at the first invalid sequence (tampered with a superuser connection)', async () => {
    await appendMany(5);
    await tamper(
      `UPDATE audit_events SET details = '{"n": 999}'::jsonb WHERE tenant_id = 'tenant_contoso_support' AND sequence = 3`,
    );
    const verification = await h.contoso().audit.verify();
    expect(verification.valid).toBe(false);
    expect(verification.firstInvalidSequence).toBe(3);
    expect(verification.eventsChecked).toBe(2);
    expect(verification.detail).toContain('3');
  });

  it.each([
    ['the actor', `UPDATE audit_events SET actor_id = 'someone.else' WHERE sequence = 2`, 2],
    ['the outcome', `UPDATE audit_events SET outcome = 'failure' WHERE sequence = 4`, 4],
    [
      'the timestamp',
      `UPDATE audit_events SET occurred_at = occurred_at + interval '1 minute' WHERE sequence = 1`,
      1,
    ],
    ['the stored hash', `UPDATE audit_events SET hash = repeat('a', 64) WHERE sequence = 5`, 5],
    [
      'the previous-hash link',
      `UPDATE audit_events SET prev_hash = repeat('b', 64) WHERE sequence = 2`,
      2,
    ],
  ])('flags tampering with %s', async (_label, sql, expectedSequence) => {
    await appendMany(5);
    await tamper(sql);
    const verification = await h.contoso().audit.verify();
    expect(verification).toMatchObject({ valid: false, firstInvalidSequence: expectedSequence });
  });

  it('flags a deleted event as a sequence gap', async () => {
    await appendMany(5);
    await tamper('DELETE FROM audit_events WHERE sequence = 3');
    const verification = await h.contoso().audit.verify();
    expect(verification).toMatchObject({ valid: false, firstInvalidSequence: 3, eventsChecked: 2 });
    expect(verification.detail).toMatch(/expected 3, found 4/);
  });

  it('flags a re-hashed event whose successor no longer links to it', async () => {
    const events = await appendMany(4);
    const target = events[1];
    expect(target).toBeDefined();
    if (!target) return;
    const forged = { ...target, details: { n: 'forged' } };
    const { hash: _unused, ...unsigned } = forged;
    const newHash = computeAuditHash(forged.prevHash, unsigned);
    await tamper(
      `UPDATE audit_events SET details = '{"n":"forged"}'::jsonb, hash = '${newHash}' WHERE sequence = 2`,
    );
    const verification = await h.contoso().audit.verify();
    expect(verification).toMatchObject({ valid: false, firstInvalidSequence: 3 });
  });

  it('the application role cannot rewrite, remove or re-order audit events', async () => {
    await appendMany(3);
    for (const sql of [
      `UPDATE audit_events SET details = '{}'::jsonb`,
      `UPDATE audit_events SET hash = repeat('c', 64) WHERE sequence = 3`,
      'DELETE FROM audit_events WHERE sequence = 2',
      'DELETE FROM audit_events',
      'TRUNCATE audit_events',
    ]) {
      await expect(
        h.database.withTenant(CONTOSO_SCOPE, (tx) => tx.query(sql)),
        sql,
      ).rejects.toBeDefined();
    }
    expect(await h.contoso().audit.verify()).toMatchObject({ valid: true, eventsChecked: 3 });
  });

  it("is unaffected by another tenant's events and detects tampering per tenant only", async () => {
    await appendMany(3);
    await h.fabrikam().audit.append(buildAuditInput());
    await tamper(
      `UPDATE audit_events SET details = '{"n": 0}'::jsonb WHERE tenant_id = 'tenant_fabrikam_lab'`,
    );
    expect((await h.contoso().audit.verify()).valid).toBe(true);
    expect((await h.fabrikam().audit.verify()).valid).toBe(false);
  });

  it('lists newest first with filters and a stable keyset cursor', async () => {
    const repos = h.contoso();
    await repos.audit.append(
      buildAuditInput({
        action: 'case.ingested',
        caseId: 'case_a',
        actorId: 'user_ava_engineer',
        occurredAt: at(1),
      }),
    );
    await repos.audit.append(
      buildAuditInput({
        action: 'claim.reclassified',
        caseId: 'case_a',
        actorId: 'user_riley_reviewer',
        actorRole: 'reviewer',
        occurredAt: at(2),
      }),
    );
    await repos.audit.append(
      buildAuditInput({
        action: 'case.ingested',
        caseId: 'case_b',
        outcome: 'denied',
        occurredAt: at(3),
      }),
    );
    await repos.audit.append(
      buildAuditInput({
        action: 'skill.published',
        caseId: null,
        targetType: 'skill',
        targetId: 'skill_x',
        occurredAt: at(4),
      }),
    );

    const all = await repos.audit.list({ limit: 50 });
    expect(all.items.map((e) => e.sequence)).toEqual([4, 3, 2, 1]);
    expect(
      (await repos.audit.list({ limit: 50, action: 'case.ingested' })).items.map((e) => e.sequence),
    ).toEqual([3, 1]);
    expect(
      (await repos.audit.list({ limit: 50, caseId: 'case_a' })).items.map((e) => e.sequence),
    ).toEqual([2, 1]);
    expect(
      (await repos.audit.list({ limit: 50, actorId: 'user_riley_reviewer' })).items.map(
        (e) => e.sequence,
      ),
    ).toEqual([2]);
    expect(
      (await repos.audit.list({ limit: 50, outcome: 'denied' })).items.map((e) => e.sequence),
    ).toEqual([3]);
    expect(
      (await repos.audit.list({ limit: 50, from: at(2), to: at(3) })).items.map((e) => e.sequence),
    ).toEqual([3, 2]);

    const first = await repos.audit.list({ limit: 3 });
    const second = await repos.audit.list({ limit: 3, cursor: first.nextCursor ?? undefined });
    expect([...first.items, ...second.items].map((e) => e.sequence)).toEqual([4, 3, 2, 1]);
    expect(second.nextCursor).toBeNull();
  });

  it('exports a bounded, ascending slice of the chain', async () => {
    await appendMany(6);
    const exported = await h.contoso().audit.listForExport(4);
    expect(exported.map((e) => e.sequence)).toEqual([1, 2, 3, 4]);
    await expect(h.contoso().audit.listForExport(0)).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(h.contoso().audit.listForExport(100_001)).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
  });

  it('hashes exactly what is stored: key order and undefined values do not matter', async () => {
    const a = await h
      .contoso()
      .audit.append(
        buildAuditInput({ details: { z: 1, a: { y: 2, x: [3, { q: 1, p: undefined }] } } }),
      );
    expect(a.details).toEqual({ z: 1, a: { y: 2, x: [3, { q: 1 }] } });
    expect(await h.contoso().audit.verify()).toMatchObject({ valid: true });
  });

  it('normalises occurredAt to millisecond precision and rejects malformed events', async () => {
    const event = await h
      .contoso()
      .audit.append(buildAuditInput({ occurredAt: '2026-01-15T09:00:00.123456Z' }));
    expect(event.occurredAt).toBe('2026-01-15T09:00:00.123Z');
    await expect(
      h.contoso().audit.append(buildAuditInput({ actorRole: 'superuser' as never })),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(h.contoso().audit.append(buildAuditInput({ action: '' }))).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
    await expect(
      h.contoso().audit.append(buildAuditInput({ details: { big: BigInt(1) } })),
    ).rejects.toBeInstanceOf(TypeError);
    expect(await h.contoso().audit.verify()).toMatchObject({ valid: true, eventsChecked: 1 });
  });
});
