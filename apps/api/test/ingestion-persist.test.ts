import { describe, expect, it, vi } from 'vitest';
import type { Case } from '@caseguard/schemas';
import { ConflictError } from '../src/errors';
import type { RequestContext } from '../src/http/request-context';
import { persistCase, type AcceptedPayload } from '../src/services/ingestion/persist';
import { runPipeline } from '../src/services/ingestion/pipeline';
import { referenceInUseMessage } from '../src/services/ingestion/reference';
import type { ObjectStore } from '../src/storage';
import { buildCase } from './builders';
import { bundleOf, pipelineEnv } from './ingestion-fixtures';

/*
 * Two creates can pass the reference check together; the unique index then lets one insert win and
 * reports a duplicate to the other. persistCase answers the loser as the check would have. The
 * repository's own error for it is `ConflictError` with `details.reason: 'duplicate'` (see
 * case-reference.int.test.ts); the database is replaced by fakes here so each outcome can be forced.
 */

const REFERENCE = 'CG-RACE-2001';

const duplicate = (): ConflictError =>
  new ConflictError('A case with this reference already exists in this workspace', {
    reason: 'duplicate',
  });

async function acceptedPayload(): Promise<AcceptedPayload> {
  const outcome = await runPipeline(
    { type: 'bundle', bundle: bundleOf({ reference: REFERENCE }) },
    pipelineEnv(),
  );
  if (outcome.prepared === null) throw new Error('the payload was expected to be accepted');
  return { prepared: outcome.prepared, preview: outcome.preview };
}

interface Scenario {
  /** What the transaction does when it is run. */
  readonly transaction: () => Promise<{ case: Case; created: boolean }>;
  /** Answers of `findByContentHash`, in order: the first is the check before anything is written. */
  readonly byContentHash?: readonly (Case | null)[];
  /** Answer of `findByReference`. */
  readonly byReference?: Case | null;
}

function contextFor(scenario: Scenario) {
  const puts: string[] = [];
  const deletes: string[] = [];
  const objects: ObjectStore = {
    kind: 'local',
    put: (key, bytes) => {
      puts.push(key);
      return Promise.resolve({ key, sizeBytes: bytes.byteLength, sha256: 'x', created: true });
    },
    get: () => Promise.resolve(null),
    delete: (key) => {
      deletes.push(key);
      return Promise.resolve(true);
    },
    exists: () => Promise.resolve(false),
    health: () => Promise.resolve({ ok: true, detail: 'fake', latencyMs: 0 }),
  };
  const hashAnswers = [...(scenario.byContentHash ?? [])];
  const findByContentHash = vi.fn(() => Promise.resolve(hashAnswers.shift() ?? null));
  const findByReference = vi.fn(() => Promise.resolve(scenario.byReference ?? null));
  const ctx = {
    scope: { tenantId: 'tenant_test', actorId: 'user_test' },
    auth: { userId: 'user_test' },
    now: () => new Date('2026-06-01T09:00:00.000Z'),
    newId: (prefix: string) => `${prefix}_00000000000000000000000001`,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { recordInjectionFlag: vi.fn() },
    services: { objects },
    repos: {
      cases: { findByContentHash, findByReference },
      analysis: { summarize: () => Promise.resolve([]) },
      transaction: scenario.transaction,
    },
  } as unknown as RequestContext;
  return { ctx, puts, deletes, findByContentHash, findByReference };
}

const persist = async (scenario: Scenario) => {
  const world = contextFor(scenario);
  const accepted = await acceptedPayload();
  return { ...world, run: () => persistCase(world.ctx, accepted, { analyze: false }) };
};

describe('persistCase settles a duplicate reported by the database', () => {
  it('as the reference conflict when another case holds the reference, and removes its stored payload', async () => {
    const holder = buildCase({ id: 'case_holder', reference: REFERENCE });
    const world = await persist({
      transaction: () => Promise.reject(duplicate()),
      byReference: holder,
    });
    await expect(world.run()).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
      message: referenceInUseMessage(REFERENCE),
      details: { reason: 'reference_in_use' },
    });
    expect(world.findByReference).toHaveBeenCalledWith(REFERENCE);
    expect(world.puts).toHaveLength(1);
    expect(world.deletes).toEqual(world.puts);
  });

  it('as a repeat when the same content is stored by now, not as a reference conflict', async () => {
    const winner = buildCase({ id: 'case_winner', reference: REFERENCE });
    const world = await persist({
      transaction: () => Promise.reject(duplicate()),
      byContentHash: [null, winner],
    });
    await expect(world.run()).resolves.toMatchObject({
      created: false,
      analysisJob: null,
      case: { id: 'case_winner' },
    });
    expect(world.findByReference).not.toHaveBeenCalled();
    expect(world.deletes).toEqual(world.puts);
  });

  it('as itself when neither the content nor the reference is found: it is not the caller who is at fault', async () => {
    const error = duplicate();
    const world = await persist({ transaction: () => Promise.reject(error) });
    await expect(world.run()).rejects.toBe(error);
    expect(world.deletes).toEqual(world.puts);
  });
});

describe('persistCase leaves every other failure alone', () => {
  it.each([
    ['an unexpected error', () => new Error('the connection dropped')],
    [
      'a conflict that is not a duplicate',
      () => new ConflictError('retry', { reason: 'concurrency', retryable: true }),
    ],
  ])('%s passes through unchanged and nothing is looked up', async (_name, make) => {
    const error = make();
    const world = await persist({ transaction: () => Promise.reject(error) });
    await expect(world.run()).rejects.toBe(error);
    expect(world.findByContentHash).toHaveBeenCalledTimes(1);
    expect(world.findByReference).not.toHaveBeenCalled();
    expect(world.deletes).toEqual(world.puts);
  });

  it('keeps the stored payload when the case was created', async () => {
    const created = buildCase({ id: 'case_created', reference: REFERENCE });
    const world = await persist({
      transaction: () => Promise.resolve({ case: created, created: true }),
    });
    await expect(world.run()).resolves.toMatchObject({
      created: true,
      case: { id: 'case_created' },
    });
    expect(world.puts).toHaveLength(1);
    expect(world.deletes).toEqual([]);
  });
});
