import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError, ValidationFailedError } from '../src/errors';
import { TenantViolationError } from '../src/db/errors';
import { createRepositories } from '../src/db/repositories';
import {
  CONTOSO_SCOPE,
  TEST_DATABASE_STARTUP_TIMEOUT_MS,
  createTestRepositories,
  withFaultInjection,
  type TestHarness,
} from '../src/db/testing';
import { MAX_EVENTS_PER_CASE } from '../src/db/repositories/case-repository';
import { TENANT_B, at, buildIngestInput } from './builders';

let h: TestHarness;

async function count(table: string): Promise<number> {
  const result = await h.database.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
  return result.rows[0]?.n ?? -1;
}

beforeAll(async () => {
  h = await createTestRepositories();
}, TEST_DATABASE_STARTUP_TIMEOUT_MS);
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.reset();
});

describe('[FR-ING-08] ingestion is atomic and idempotent', () => {
  it('stores the case, source, participants, events and resolution together', async () => {
    const repos = h.contoso();
    const input = buildIngestInput({ withResolution: true });
    const result = await repos.cases.ingest(input);
    expect(result.created).toBe(true);
    expect(result.case).toEqual(input.case);

    expect(await repos.cases.get('case_alpha')).toEqual(input.case);
    expect(await repos.cases.getSource('case_alpha')).toEqual(input.source);
    expect(await repos.cases.getParticipants('case_alpha')).toHaveLength(3);
    expect(await repos.cases.getAllEvents('case_alpha')).toEqual(input.events);
    expect(await repos.cases.getResolution('case_alpha')).toEqual(input.resolution);
    expect(await count('case_events')).toBe(6);
  });

  it('[FR-ING-08] a repeat of the same received content returns the existing case and stores nothing', async () => {
    const repos = h.contoso();
    const first = await repos.cases.ingest(
      buildIngestInput({ caseId: 'case_one', receivedSeed: 'same' }),
    );
    const second = await repos.cases.ingest(
      buildIngestInput({ caseId: 'case_two', receivedSeed: 'same', reference: 'CG-2002' }),
    );
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.case.id).toBe('case_one');
    expect(await count('cases')).toBe(1);
    expect(await count('case_events')).toBe(6);
  });

  it('[FR-ING-08] concurrent ingests of the same content create exactly one case', async () => {
    const repos = h.contoso();
    const results = await Promise.all([
      repos.cases.ingest(buildIngestInput({ caseId: 'case_a', receivedSeed: 'race' })),
      repos.cases.ingest(buildIngestInput({ caseId: 'case_b', receivedSeed: 'race' })),
      repos.cases.ingest(buildIngestInput({ caseId: 'case_c', receivedSeed: 'race' })),
    ]);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.case.id)).size).toBe(1);
    expect(await count('cases')).toBe(1);
  });

  it('[FR-ING-08] the same content in different tenants is stored once per tenant', async () => {
    const a = await h.contoso().cases.ingest(buildIngestInput({ receivedSeed: 'shared' }));
    const b = await h
      .fabrikam()
      .cases.ingest(buildIngestInput({ tenantId: TENANT_B, receivedSeed: 'shared' }));
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(await count('cases')).toBe(2);
  });

  it('[FR-ING-08] a failure in the middle of ingest persists nothing (atomic rollback)', async () => {
    const faulty = withFaultInjection(h.database);
    const repos = createRepositories(faulty, { now: h.clock.now, newId: h.newId }).forTenant(
      CONTOSO_SCOPE,
    );
    faulty.arm({ match: /INSERT INTO case_events/ });
    await expect(repos.cases.ingest(buildIngestInput({ withResolution: true }))).rejects.toThrow(
      'injected failure',
    );
    faulty.disarm();
    for (const table of [
      'cases',
      'case_sources',
      'case_participants',
      'case_events',
      'case_resolutions',
    ]) {
      expect(await count(table)).toBe(0);
    }
    // The failed attempt left no idempotency residue: the same content ingests normally afterwards.
    const retry = await repos.cases.ingest(buildIngestInput({ withResolution: true }));
    expect(retry.created).toBe(true);
  });

  it('[FR-ING-08] a failure after ingest inside a bound transaction rolls the ingest back', async () => {
    const repos = h.contoso();
    await expect(
      repos.transaction(async (bound) => {
        await bound.cases.ingest(buildIngestInput());
        expect(await bound.cases.get('case_alpha')).not.toBeNull();
        throw new Error('later step failed');
      }),
    ).rejects.toThrow('later step failed');
    expect(await count('cases')).toBe(0);
    expect(await count('case_events')).toBe(0);
  });

  it('[FR-ING-08] rejects inconsistent input before writing anything', async () => {
    const repos = h.contoso();
    const good = buildIngestInput();

    await expect(
      repos.cases.ingest({ ...good, case: { ...good.case, eventCount: 99 } }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(
      repos.cases.ingest({ ...good, storedPayload: `${good.storedPayload} ` }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      repos.cases.ingest({
        ...good,
        resolution: null,
        case: { ...good.case, hasResolution: true },
      }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    const gap = good.events.map((event, index) =>
      index === 3 ? { ...event, sequence: 9 } : event,
    );
    await expect(repos.cases.ingest({ ...good, events: gap })).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
    const unknownParticipant = good.events.map((event, index) =>
      index === 0 ? { ...event, participantId: 'p_ghost' } : event,
    );
    await expect(
      repos.cases.ingest({ ...good, events: unknownParticipant }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    const outOfOrder = good.events.map((event, index) =>
      index === 5 ? { ...event, timestamp: at(-100) } : event,
    );
    await expect(repos.cases.ingest({ ...good, events: outOfOrder })).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
    expect(await count('cases')).toBe(0);
  });

  it('[NFR-SEC-01] refuses to ingest a record that belongs to another tenant', async () => {
    const foreign = buildIngestInput({ tenantId: TENANT_B });
    await expect(h.contoso().cases.ingest(foreign)).rejects.toBeInstanceOf(TenantViolationError);
    expect(await count('cases')).toBe(0);
  });

  it('[NFR-REL-01] enforces the hard cap of 2000 events per case', async () => {
    const repos = h.contoso();
    const tooMany = buildIngestInput({ eventCount: MAX_EVENTS_PER_CASE + 1 });
    await expect(repos.cases.ingest(tooMany)).rejects.toMatchObject({
      code: 'validation_failed',
      message: expect.stringContaining('2000') as string,
    });
    expect(await count('cases')).toBe(0);

    const atCap = await repos.cases.ingest(buildIngestInput({ eventCount: MAX_EVENTS_PER_CASE }));
    expect(atCap.created).toBe(true);
    expect(await count('case_events')).toBe(MAX_EVENTS_PER_CASE);
    expect((await repos.cases.getAllEvents('case_alpha')).length).toBe(MAX_EVENTS_PER_CASE);
  });

  it('[NFR-REL-01] the database itself rejects a 2001st event (check constraint backstop)', async () => {
    await h.contoso().cases.ingest(buildIngestInput());
    await expect(
      h.database.query(
        `UPDATE cases SET event_count = 2001 WHERE tenant_id = 'tenant_contoso_support'`,
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});

describe('case and event reads', () => {
  it('[NFR-REL-01] keyset pagination of cases has no duplicates or skips, even with identical sort keys', async () => {
    const repos = h.contoso();
    // Seven cases opened at the same instant: only the id tie-break orders them.
    for (let i = 1; i <= 7; i += 1) {
      await repos.cases.ingest(
        buildIngestInput({
          caseId: `case_${i}`,
          receivedSeed: `seed-${i}`,
          reference: `CG-${1000 + i}`,
          eventCount: 1,
        }),
      );
    }
    const everything = await repos.cases.list({ limit: 200 });
    expect(everything.items).toHaveLength(7);
    expect(everything.nextCursor).toBeNull();

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await repos.cases.list({ limit: 3, cursor });
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? undefined;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual(everything.items.map((item) => item.id));
    expect(new Set(seen).size).toBe(7);
  });

  it('filters cases by status, workload, analysis state and text', async () => {
    const repos = h.contoso();
    await repos.cases.ingest(
      buildIngestInput({
        caseId: 'case_open',
        receivedSeed: '1',
        reference: 'CG-2001',
        title: 'Proxy outage investigation',
      }),
    );
    await repos.cases.ingest(
      buildIngestInput({
        caseId: 'case_done',
        receivedSeed: '2',
        reference: 'CG-2002',
        withResolution: true,
        workload: 'exchange-mailflow',
        title: 'Mail delivery delay',
      }),
    );
    await repos.cases.setAnalysisState('case_done', 'analyzed', {
      runId: 'run_x',
      analyzedAt: at(500),
    });

    expect((await repos.cases.list({ limit: 10, status: 'open' })).items.map((c) => c.id)).toEqual([
      'case_open',
    ]);
    expect(
      (await repos.cases.list({ limit: 10, status: 'resolved' })).items.map((c) => c.id),
    ).toEqual(['case_done']);
    expect(
      (await repos.cases.list({ limit: 10, workload: 'exchange-mailflow' })).items.map((c) => c.id),
    ).toEqual(['case_done']);
    expect(
      (await repos.cases.list({ limit: 10, analysisState: 'analyzed' })).items.map((c) => c.id),
    ).toEqual(['case_done']);
    expect((await repos.cases.list({ limit: 10, q: 'PROXY' })).items.map((c) => c.id)).toEqual([
      'case_open',
    ]);
    expect((await repos.cases.list({ limit: 10, q: 'cg-2002' })).items.map((c) => c.id)).toEqual([
      'case_done',
    ]);
    // LIKE wildcards in user input are plain characters, not patterns.
    expect((await repos.cases.list({ limit: 10, q: '%' })).items).toHaveLength(0);
  });

  it('paginates events by (timestamp, sequence) and honours asOf, from and to', async () => {
    const repos = h.contoso();
    await repos.cases.ingest(buildIngestInput({ eventCount: 6 }));

    const first = await repos.cases.listEvents('case_alpha', { limit: 4 });
    expect(first.items.map((e) => e.sequence)).toEqual([0, 1, 2, 3]);
    const second = await repos.cases.listEvents('case_alpha', {
      limit: 4,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.items.map((e) => e.sequence)).toEqual([4, 5]);
    expect(second.nextCursor).toBeNull();

    // asOf is inclusive: the event at exactly T is available, later ones are not.
    const asOf = await repos.cases.listEvents('case_alpha', { limit: 50, asOf: at(20) });
    expect(asOf.items.map((e) => e.sequence)).toEqual([0, 1, 2]);
    expect(
      (await repos.cases.getAllEvents('case_alpha', { asOf: at(20) })).map((e) => e.sequence),
    ).toEqual([0, 1, 2]);
    expect(await repos.cases.countEventsAfter('case_alpha', at(20))).toBe(3);
    expect(await repos.cases.countEventsAfter('case_alpha', at(1000))).toBe(0);

    const window = await repos.cases.listEvents('case_alpha', {
      limit: 50,
      from: at(10),
      to: at(30),
      asOf: at(25),
    });
    expect(window.items.map((e) => e.sequence)).toEqual([1, 2]);

    expect((await repos.cases.getEvent('case_alpha', 'evt_03'))?.sequence).toBe(2);
    expect(await repos.cases.getEvent('case_alpha', 'evt_99')).toBeNull();
  });

  it('[NFR-REL-01] event ids only need to be unique inside one case', async () => {
    const repos = h.contoso();
    await repos.cases.ingest(buildIngestInput({ caseId: 'case_one', receivedSeed: 'a' }));
    await repos.cases.ingest(buildIngestInput({ caseId: 'case_two', receivedSeed: 'b' }));
    expect((await repos.cases.getEvent('case_one', 'evt_01'))?.caseId).toBe('case_one');
    expect((await repos.cases.getEvent('case_two', 'evt_01'))?.caseId).toBe('case_two');
  });

  it('finds a case by its content hash and lists cases for indexing', async () => {
    const repos = h.contoso();
    const input = buildIngestInput({ receivedSeed: 'find-me' });
    await repos.cases.ingest(input);
    expect((await repos.cases.findByContentHash(input.case.contentHash))?.id).toBe('case_alpha');
    expect(await repos.cases.findByContentHash('0'.repeat(64))).toBeNull();
    const indexed = await repos.cases.listForIndexing(10);
    expect(indexed).toEqual([
      {
        id: 'case_alpha',
        reference: 'CG-1001',
        title: input.case.title,
        product: input.case.product,
        workload: input.case.workload,
      },
    ]);
  });

  it('updates analysis state and rejects unknown cases', async () => {
    const repos = h.contoso();
    await repos.cases.ingest(buildIngestInput());
    await repos.cases.setAnalysisState('case_alpha', 'running');
    expect((await repos.cases.get('case_alpha'))?.analysisState).toBe('running');
    await repos.cases.setAnalysisState('case_alpha', 'analyzed', {
      runId: 'run_1',
      analyzedAt: at(60),
    });
    const analyzed = await repos.cases.get('case_alpha');
    expect(analyzed).toMatchObject({
      analysisState: 'analyzed',
      lastAnalysisRunId: 'run_1',
      analyzedAt: at(60),
      version: 3,
    });
    await expect(repos.cases.setAnalysisState('missing', 'failed')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
