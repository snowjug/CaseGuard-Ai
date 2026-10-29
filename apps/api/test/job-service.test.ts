import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Job } from '@caseguard/schemas';
import { permissionsFor, type AuthContext } from '@caseguard/security';
import { ConflictError, NotFoundError, ValidationFailedError } from '../src/errors';
import type { Database } from '../src/db';
import { TEST_DATABASE_STARTUP_TIMEOUT_MS } from '../src/db/testing';
import { buildRequestContext } from '../src/http/context-factory';
import type { RequestContext } from '../src/http/request-context';
import { JobService } from '../src/services/job-service';
import type { JobSpec } from '../src/services/ports';
import {
  CONTOSO,
  PERSONAS,
  createHarness,
  openSharedDatabase,
  type Harness,
} from './support/app-harness';
import { buildIngestInput } from './builders';

let database: Database;
let h: Harness;

const auth: AuthContext = {
  userId: PERSONAS.engineer,
  tenantId: CONTOSO,
  displayName: 'Ava Engineer (synthetic)',
  roles: ['engineer'],
  permissions: permissionsFor(['engineer']),
  authMode: 'dev',
  synthetic: true,
  subject: PERSONAS.engineer,
  email: null,
};

function context(): RequestContext {
  return buildRequestContext(h.infra, {
    requestId: 'req_jobs_test',
    auth,
    permission: null,
    signal: new AbortController().signal,
    logger: h.infra.logger,
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const spec = (overrides: Partial<JobSpec> = {}): JobSpec => ({
  kind: 'case_analysis',
  caseId: 'case_jobs',
  stages: [
    { id: 'load', label: 'Load case' },
    { id: 'analyse', label: 'Analyse' },
    { id: 'save', label: 'Save results' },
  ],
  ...overrides,
});

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Condition was not reached in time');
}

beforeAll(async () => {
  database = await openSharedDatabase();
  h = await createHarness({ database });
  // Jobs reference their case by foreign key, so the case must really exist.
  await h.repos(CONTOSO).cases.ingest(buildIngestInput({ tenantId: CONTOSO, caseId: 'case_jobs' }));
}, TEST_DATABASE_STARTUP_TIMEOUT_MS);

afterAll(async () => {
  await h.close();
  await database.close();
});

describe('JobService', () => {
  it('runs the work and records every stage, the result and 100 percent', async () => {
    const jobs = new JobService(h.infra);
    const ctx = context();
    const job = await jobs.runToCompletion(ctx, spec(), async (handle) => {
      await handle.stage('load');
      await handle.stage('analyse', 'Scoring hypotheses');
      await handle.stage('save');
      return { resultRef: { type: 'analysis_run', id: 'run_1' } };
    });
    expect(job.status).toBe('succeeded');
    expect(job.progress.percent).toBe(100);
    expect(job.progress.stages.map((stage) => stage.status)).toEqual(['done', 'done', 'done']);
    expect(job.progress.stages[1]?.detail).toBe('Scoring hypotheses');
    expect(job.resultRef).toEqual({ type: 'analysis_run', id: 'run_1' });
    expect(job.createdBy).toBe(PERSONAS.engineer);
    expect(job.startedAt).not.toBeNull();
    expect(job.completedAt).not.toBeNull();
    expect(await ctx.repos.jobs.get(job.id)).toMatchObject({ status: 'succeeded' });
  });

  it('persists progress while the work is still running', async () => {
    const jobs = new JobService(h.infra);
    const ctx = context();
    const gate = deferred();
    const created = await jobs.start(ctx, spec(), async (handle) => {
      await handle.stage('load');
      await handle.stage('analyse');
      await gate.promise;
      return { resultRef: null };
    });
    const mid = await waitFor(
      () => ctx.repos.jobs.get(created.id),
      (job) => job?.progress.stage === 'analyse',
    );
    expect(mid?.status).toBe('running');
    expect(mid?.progress.stages.map((stage) => stage.status)).toEqual([
      'done',
      'running',
      'pending',
    ]);
    expect(mid?.progress.percent).toBeGreaterThan(0);
    expect(mid?.progress.percent).toBeLessThan(100);
    gate.resolve();
    await jobs.idle();
    expect((await ctx.repos.jobs.get(created.id))?.status).toBe('succeeded');
  });

  it('marks stages the work never reached as skipped on success', async () => {
    const jobs = new JobService(h.infra);
    const job = await jobs.runToCompletion(context(), spec(), async (handle) => {
      await handle.stage('load');
      await handle.skip('analyse', 'Analysis already existed');
      return { resultRef: null };
    });
    expect(job.progress.stages.map((stage) => stage.status)).toEqual([
      'done',
      'skipped',
      'skipped',
    ]);
    expect(job.progress.stages[1]?.detail).toBe('Analysis already existed');
  });

  it('shows an expected failure to the user and hides an unexpected one', async () => {
    const jobs = new JobService(h.infra);
    const expected = await jobs.runToCompletion(context(), spec(), async (handle) => {
      await handle.stage('load');
      throw new ValidationFailedError('The case has no events to analyse');
    });
    expect(expected.status).toBe('failed');
    expect(expected.error).toEqual({
      code: 'validation_failed',
      message: 'The case has no events to analyse',
    });
    expect(expected.progress.stages[0]?.status).toBe('failed');

    const unexpected = await jobs.runToCompletion(context(), spec(), async () => {
      throw new Error('relation "secret_table" does not exist');
    });
    expect(unexpected.status).toBe('failed');
    expect(unexpected.error?.code).toBe('internal');
    expect(JSON.stringify(unexpected.error)).not.toContain('secret_table');
  });

  it('cancels a running job at its next checkpoint', async () => {
    const jobs = new JobService(h.infra);
    const ctx = context();
    const gate = deferred();
    let reachedAfterCancel = false;
    const created = await jobs.start(ctx, spec(), async (handle) => {
      await handle.stage('load');
      await gate.promise;
      handle.throwIfCancelled();
      reachedAfterCancel = true;
      return { resultRef: null };
    });
    await waitFor(
      () => ctx.repos.jobs.get(created.id),
      (job) => job?.status === 'running' && job.progress.stage === 'load',
    );
    const reply = await jobs.cancel(ctx, created.id);
    expect(['running', 'cancelled']).toContain(reply.status);
    gate.resolve();
    await jobs.idle();
    const final = await ctx.repos.jobs.get(created.id);
    expect(final?.status).toBe('cancelled');
    expect(final?.cancellable).toBe(false);
    expect(reachedAfterCancel).toBe(false);
  });

  it('queues jobs beyond the concurrency limit and lets a queued job be cancelled before it starts', async () => {
    const jobs = new JobService(h.infra, 1);
    const ctx = context();
    const gate = deferred();
    let secondStarted = false;
    const first = await jobs.start(ctx, spec(), async (handle) => {
      await handle.stage('load');
      await gate.promise;
      return { resultRef: null };
    });
    const second = await jobs.start(ctx, spec(), async () => {
      secondStarted = true;
      return { resultRef: null };
    });
    await waitFor(
      () => ctx.repos.jobs.get(first.id),
      (job) => job?.status === 'running',
    );
    expect((await ctx.repos.jobs.get(second.id))?.status).toBe('queued');

    const cancelled = await jobs.cancel(ctx, second.id);
    expect(cancelled.status).toBe('cancelled');
    gate.resolve();
    await jobs.idle();
    expect(secondStarted).toBe(false);
    expect((await ctx.repos.jobs.get(first.id))?.status).toBe('succeeded');
  });

  it('runs queued jobs in order once a slot frees up', async () => {
    const jobs = new JobService(h.infra, 1);
    const ctx = context();
    const order: number[] = [];
    const gate = deferred();
    await jobs.start(ctx, spec(), async () => {
      await gate.promise;
      order.push(1);
      return { resultRef: null };
    });
    await jobs.start(ctx, spec(), async () => {
      order.push(2);
      return { resultRef: null };
    });
    await jobs.start(ctx, spec(), async () => {
      order.push(3);
      return { resultRef: null };
    });
    gate.resolve();
    await jobs.idle();
    expect(order).toEqual([1, 2, 3]);
  });

  it('returns the existing job for a repeated idempotency key', async () => {
    const jobs = new JobService(h.infra);
    const ctx = context();
    let runs = 0;
    const work = async () => {
      runs += 1;
      return { resultRef: null };
    };
    const first = await jobs.runToCompletion(
      ctx,
      spec({ idempotencyKey: 'analysis:case_jobs:abc123' }),
      work,
    );
    const second = await jobs.start(
      ctx,
      spec({ idempotencyKey: 'analysis:case_jobs:abc123' }),
      work,
    );
    await jobs.idle();
    expect(second.id).toBe(first.id);
    expect(runs).toBe(1);
  });

  it('refuses to cancel a finished or unknown job', async () => {
    const jobs = new JobService(h.infra);
    const ctx = context();
    const done = await jobs.runToCompletion(ctx, spec(), async () => ({ resultRef: null }));
    await expect(jobs.cancel(ctx, done.id)).rejects.toBeInstanceOf(ConflictError);
    await expect(jobs.cancel(ctx, 'job_does_not_exist')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses to cancel a job that was created as not cancellable', async () => {
    const jobs = new JobService(h.infra);
    const ctx = context();
    const gate = deferred();
    const created = await jobs.start(ctx, spec({ cancellable: false }), async () => {
      await gate.promise;
      return { resultRef: null };
    });
    await expect(jobs.cancel(ctx, created.id)).rejects.toBeInstanceOf(ConflictError);
    gate.resolve();
    await jobs.idle();
  });

  it('fails jobs a previous process left running when the server restarts', async () => {
    const jobs = new JobService(h.infra);
    const ctx = context();
    const orphan: Job = {
      id: 'job_orphan_from_last_run',
      tenantId: CONTOSO,
      kind: 'case_analysis',
      status: 'running',
      caseId: 'case_jobs',
      targetId: null,
      progress: {
        percent: 40,
        stage: 'analyse',
        stages: [
          {
            id: 'analyse',
            label: 'Analyse',
            status: 'running',
            startedAt: null,
            completedAt: null,
            detail: null,
          },
        ],
      },
      error: null,
      resultRef: null,
      idempotencyKey: null,
      createdAt: '2026-01-15T08:00:00.000Z',
      startedAt: '2026-01-15T08:00:01.000Z',
      completedAt: null,
      createdBy: PERSONAS.engineer,
      cancellable: true,
    };
    await ctx.repos.jobs.create(orphan);
    expect(await jobs.recoverOrphans([CONTOSO])).toBeGreaterThanOrEqual(1);
    const recovered = await ctx.repos.jobs.get(orphan.id);
    expect(recovered?.status).toBe('failed');
    expect(recovered?.error?.message).toMatch(/restarted/);
  });

  it('rejects a job with no stages as a programming error', async () => {
    const jobs = new JobService(h.infra);
    await expect(
      jobs.start(context(), spec({ stages: [] }), async () => ({ resultRef: null })),
    ).rejects.toThrow(/at least one stage/);
  });
});
