import { describe, expect, it, vi } from 'vitest';
import { linkedCaseId } from '../src/http/idempotency';
import { IDEMPOTENCY_PURGE_INTERVAL_MS, purgeExpiredIdempotency } from '../src/maintenance';

describe('[NFR-PRIV-03] the case an idempotent response is linked to', () => {
  it.each([
    ['the caseId path parameter', { caseId: 'case_a' }, { job: { caseId: 'case_b' } }, 'case_a'],
    ['the case of an ingest result', {}, { case: { id: 'case_c' }, analysisJob: null }, 'case_c'],
    ['the case of a job response', {}, { job: { caseId: 'case_d' } }, 'case_d'],
    ['a top-level caseId', undefined, { caseId: 'case_e' }, 'case_e'],
    [
      'the case of an ingest result before its job',
      {},
      { case: { id: 'a' }, job: { caseId: 'b' } },
      'a',
    ],
  ])('is %s', (_name, params, body, expected) => {
    expect(linkedCaseId(params, body)).toBe(expected);
  });

  it.each([
    ['a job without a case', {}, { job: { caseId: null } }],
    ['no body', {}, undefined],
    ['a null body', {}, null],
    ['a text body', {}, 'case_a'],
    ['an array body', {}, [{ caseId: 'case_a' }]],
    ['an id with a space', { caseId: 'case a' }, {}],
    ['an id that is too long', {}, { caseId: 'c'.repeat(121) }],
    ['a numeric id', { caseId: 42 }, {}],
    ['an empty id', {}, { case: { id: '' } }],
  ])('is nothing for %s', (_name, params, body) => {
    expect(linkedCaseId(params, body)).toBeNull();
  });
});

function fakeInfra(purge: (tenantId: string) => Promise<number>) {
  const logger = { error: vi.fn() };
  const calls: string[] = [];
  const repos = {
    forTenant: ({ tenantId, actorId }: { tenantId: string; actorId: string }) => {
      calls.push(`${tenantId}:${actorId}`);
      return {
        idempotency: { purgeExpired: vi.fn((limit?: number) => purge(`${tenantId}:${limit}`)) },
      };
    },
  };
  return { infra: { repos, logger } as never, logger, calls };
}

describe('[NFR-PRIV-03] expired idempotency keys are purged for every tenant', () => {
  it('sums what every tenant lost and acts as the maintenance identity', async () => {
    const { infra, calls } = fakeInfra(async (key) => (key.startsWith('t1') ? 3 : 4));
    await expect(purgeExpiredIdempotency(infra, ['t1', 't2'])).resolves.toBe(7);
    expect(calls).toEqual(['t1:system:maintenance', 't2:system:maintenance']);
  });

  it('keeps going while a tenant still has a full batch and stops at a partial one', async () => {
    const answers = [1000, 1000, 17];
    const { infra } = fakeInfra(async () => answers.shift() ?? 0);
    await expect(purgeExpiredIdempotency(infra, ['t1'])).resolves.toBe(2017);
    expect(answers).toEqual([]);
  });

  it('gives one tenant a bounded number of batches per sweep', async () => {
    const purge = vi.fn(async () => 1000);
    const { infra } = fakeInfra(purge);
    await expect(purgeExpiredIdempotency(infra, ['t1'])).resolves.toBe(10_000);
    expect(purge).toHaveBeenCalledTimes(10);
  });

  it('logs a failing tenant and still purges the others', async () => {
    const { infra, logger } = fakeInfra(async (key) => {
      if (key.startsWith('t1')) throw new Error('database unavailable');
      return 2;
    });
    await expect(purgeExpiredIdempotency(infra, ['t1', 't2'])).resolves.toBe(2);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0]?.[1]).toBe('could not purge expired idempotency keys');
  });

  it('does nothing without tenants', async () => {
    const { infra, calls } = fakeInfra(async () => 5);
    await expect(purgeExpiredIdempotency(infra, [])).resolves.toBe(0);
    expect(calls).toEqual([]);
  });

  it('runs often enough to matter and never more often than once a minute', () => {
    expect(IDEMPOTENCY_PURGE_INTERVAL_MS).toBeGreaterThanOrEqual(60_000);
    expect(IDEMPOTENCY_PURGE_INTERVAL_MS).toBeLessThanOrEqual(60 * 60_000);
  });
});
