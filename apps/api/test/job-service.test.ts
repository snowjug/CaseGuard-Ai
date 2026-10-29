import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Job } from '@caseguard/schemas';
import { AuthorizationError, permissionsFor, type AuthContext } from '@caseguard/security';
import { ConflictError, NotFoundError, ValidationFailedError } from '../src/errors';
import type { Database } from '../src/db';
import { TEST_DATABASE_STARTUP_TIMEOUT_MS } from '../src/db/testing';
import { buildRequestContext } from '../src/http/context-factory';
import type { RequestContext } from '../src/http/request-context';
import { JobService } from '../src/services/job-service';
import type { JobSpec } from '../src/services/ports';
import {
  CONTOSO,
  FABRIKAM,
  PERSONAS,
  createHarness,
  openSharedDatabase,
  type Harness,
} from './support/app-harness';
import { contextFor } from './support/context';
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

/** A job some other process left behind: stored as running (or the given status), owned by nobody. */
function orphanJob(
  id: string,
  tenantId: string,
  caseId: string,
  overrides: Partial<Job> = {},
): Job {
  return {
    id,
    tenantId,
    kind: 'case_analysis',
    status: 'running',
    caseId,
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
    ...overrides,
  };
}

async function heartbeatOf(jobId: string): Promise<string | null> {
  const { rows } = await database.query<{ heartbeat_at: Date | string | null }>(
    'SELECT heartbeat_at FROM jobs WHERE id = $1',
    [jobId],
  );
  const value = rows[0]?.heartbeat_at ?? null;
  return value instanceof Date ? value.toISOString() : value;
}

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
  await h
    .repos(FABRIKAM)
    .cases.ingest(buildIngestInput({ tenantId: FABRIKAM, caseId: 'case_jobs_fabrikam' }));
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
    // The running job is only asked to stop: the reply is the job as it was, and the work ends later.
    expect(reply.status).toBe('running');
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

  it('fails jobs a previous process left running when the server restarts, and only in the tenants it is told about', async () => {
    const jobs = new JobService(h.infra);
    const ctx = context();
    const otherTenant = contextFor(h, PERSONAS.otherTenantEngineer);
    await ctx.repos.jobs.create(orphanJob('job_orphan_from_last_run', CONTOSO, 'case_jobs'));
    await ctx.repos.jobs.create(
      orphanJob('job_orphan_queued', CONTOSO, 'case_jobs', { status: 'queued' }),
    );
    await otherTenant.repos.jobs.create(
      orphanJob('job_orphan_other_tenant', FABRIKAM, 'case_jobs_fabrikam'),
    );

    expect(await jobs.recoverOrphans([CONTOSO])).toBe(2);
    const recovered = await ctx.repos.jobs.get('job_orphan_from_last_run');
    expect(recovered?.status).toBe('failed');
    expect(recovered?.error).toMatchObject({ code: 'orphaned' });
    expect(recovered?.error?.message).toMatch(/restarted/);
    expect((await ctx.repos.jobs.get('job_orphan_queued'))?.status).toBe('failed');
    expect((await otherTenant.repos.jobs.get('job_orphan_other_tenant'))?.status).toBe('running');
    // Nothing left to recover.
    expect(await jobs.recoverOrphans([CONTOSO])).toBe(0);
  });

  it('rejects a job with no stages as a programming error', async () => {
    const jobs = new JobService(h.infra);
    await expect(
      jobs.start(context(), spec({ stages: [] }), async () => ({ resultRef: null })),
    ).rejects.toThrow(/at least one stage/);
  });
});

describe('JobService with several replicas', () => {
  it('records a heartbeat for the jobs it owns and none for finished ones', async () => {
    const jobs = new JobService(h.infra, 2, { heartbeatIntervalMs: 0 });
    const ctx = context();
    const gate = deferred();
    const created = await jobs.start(ctx, spec(), async (handle) => {
      await handle.stage('load');
      await gate.promise;
      return { resultRef: null };
    });
    await waitFor(
      () => ctx.repos.jobs.get(created.id),
      (job) => job?.status === 'running',
    );
    expect(await heartbeatOf(created.id)).toBeNull();

    h.clock.advance(5_000);
    await jobs.beat();
    expect(await heartbeatOf(created.id)).toBe(h.clock.now().toISOString());

    gate.resolve();
    await jobs.idle();
    const last = await heartbeatOf(created.id);
    h.clock.advance(5_000);
    await jobs.beat();
    expect(await heartbeatOf(created.id)).toBe(last);
  });

  it('beats on its own timer while it has jobs', async () => {
    const jobs = new JobService(h.infra, 2, { heartbeatIntervalMs: 20 });
    const ctx = context();
    const gate = deferred();
    const created = await jobs.start(ctx, spec(), async (handle) => {
      await handle.stage('load');
      await gate.promise;
      return { resultRef: null };
    });
    h.clock.advance(1_000);
    await waitFor(
      () => heartbeatOf(created.id),
      (value) => value === h.clock.now().toISOString(),
    );
    gate.resolve();
    await jobs.idle();
  });

  it('fails only jobs whose owner went silent and leaves a live replica alone', async () => {
    const jobs = new JobService(h.infra);
    const ctx = context();
    const otherTenant = contextFor(h, PERSONAS.otherTenantEngineer);
    await ctx.repos.jobs.create(orphanJob('job_live_elsewhere', CONTOSO, 'case_jobs'));
    await ctx.repos.jobs.create(orphanJob('job_gone_silent', CONTOSO, 'case_jobs'));
    await otherTenant.repos.jobs.create(
      orphanJob('job_silent_other_tenant', FABRIKAM, 'case_jobs_fabrikam'),
    );
    h.clock.advance(10 * 60_000);
    // Another replica is still running the first one and says so.
    expect(await ctx.repos.jobs.heartbeat('job_live_elsewhere')).toBe('running');

    expect(await jobs.recoverOrphans([CONTOSO], { staleAfterMs: 60_000 })).toBe(1);
    expect((await ctx.repos.jobs.get('job_gone_silent'))?.status).toBe('failed');
    expect((await ctx.repos.jobs.get('job_live_elsewhere'))?.status).toBe('running');
    expect((await otherTenant.repos.jobs.get('job_silent_other_tenant'))?.status).toBe('running');

    // Once its heartbeats stop as well, it is orphaned too.
    h.clock.advance(90_000);
    expect(await jobs.recoverOrphans([CONTOSO], { staleAfterMs: 60_000 })).toBe(1);
    expect((await ctx.repos.jobs.get('job_live_elsewhere'))?.status).toBe('failed');
  });

  it('reports the status the database has when it beats, and null for a job that is not there', async () => {
    const ctx = context();
    await ctx.repos.jobs.create(orphanJob('job_beat_status', CONTOSO, 'case_jobs'));
    expect(await ctx.repos.jobs.heartbeat('job_beat_status')).toBe('running');
    await ctx.repos.jobs.update('job_beat_status', { status: 'cancelled' });
    const frozen = await heartbeatOf('job_beat_status');
    h.clock.advance(1_000);
    expect(await ctx.repos.jobs.heartbeat('job_beat_status')).toBe('cancelled');
    expect(await heartbeatOf('job_beat_status')).toBe(frozen);
    expect(await ctx.repos.jobs.heartbeat('job_never_existed')).toBeNull();
  });

  it('stops the work when another replica cancelled the job', async () => {
    const owner = new JobService(h.infra, 2, { heartbeatIntervalMs: 0 });
    const other = new JobService(h.infra, 2, { heartbeatIntervalMs: 0 });
    const ctx = context();
    const gate = deferred();
    let sawAbort = false;
    let reachedAfterCancel = false;
    const created = await owner.start(ctx, spec(), async (handle) => {
      await handle.stage('load');
      await gate.promise;
      sawAbort = handle.signal.aborted;
      handle.throwIfCancelled();
      reachedAfterCancel = true;
      return { resultRef: null };
    });
    await waitFor(
      () => ctx.repos.jobs.get(created.id),
      (job) => job?.status === 'running',
    );

    // The request landed on a replica that does not run the job, so it can only update the row.
    expect((await other.cancel(ctx, created.id)).status).toBe('cancelled');
    await owner.beat();
    gate.resolve();
    await owner.idle();
    expect(sawAbort).toBe(true);
    expect(reachedAfterCancel).toBe(false);
    expect((await ctx.repos.jobs.get(created.id))?.status).toBe('cancelled');
  });

  it('drops a queued job that another replica cancelled', async () => {
    const owner = new JobService(h.infra, 1, { heartbeatIntervalMs: 0 });
    const other = new JobService(h.infra, 1, { heartbeatIntervalMs: 0 });
    const ctx = context();
    const gate = deferred();
    let secondStarted = false;
    await owner.start(ctx, spec(), async (handle) => {
      await handle.stage('load');
      await gate.promise;
      return { resultRef: null };
    });
    const second = await owner.start(ctx, spec(), async () => {
      secondStarted = true;
      return { resultRef: null };
    });
    await other.cancel(ctx, second.id);
    await owner.beat();
    gate.resolve();
    await owner.idle();
    expect(secondStarted).toBe(false);
    expect((await ctx.repos.jobs.get(second.id))?.status).toBe('cancelled');
  });
});

describe('JobService failure handling', () => {
  it('retries the write that records the result', async () => {
    const jobs = new JobService(h.infra, 2, { retryDelayMs: 1, heartbeatIntervalMs: 0 });
    const ctx = context();
    const update = ctx.repos.jobs.update.bind(ctx.repos.jobs);
    let blips = 0;
    vi.spyOn(ctx.repos.jobs, 'update').mockImplementation((jobId, patch) => {
      if (patch.status === 'succeeded' && blips < 2) {
        blips += 1;
        return Promise.reject(new Error('connection lost'));
      }
      return update(jobId, patch);
    });
    const job = await jobs.runToCompletion(ctx, spec(), async () => ({ resultRef: null }));
    expect(blips).toBe(2);
    expect(job.status).toBe('succeeded');
  });

  it('leaves a job whose outcome could not be recorded to the orphan sweep', async () => {
    const jobs = new JobService(h.infra, 2, { retryDelayMs: 1, heartbeatIntervalMs: 0 });
    const ctx = context();
    const update = ctx.repos.jobs.update.bind(ctx.repos.jobs);
    vi.spyOn(ctx.repos.jobs, 'update').mockImplementation((jobId, patch) =>
      patch.status === 'succeeded'
        ? Promise.reject(new Error('connection lost'))
        : update(jobId, patch),
    );
    const job = await jobs.runToCompletion(ctx, spec(), async () => ({ resultRef: null }));
    expect(job.status).toBe('running');
    expect(h.logs().some((line) => line.event === 'job.outcome_not_recorded')).toBe(true);

    h.clock.advance(2 * 60_000);
    expect(await jobs.recoverOrphans([CONTOSO], { staleAfterMs: 60_000 })).toBeGreaterThanOrEqual(
      1,
    );
    expect((await ctx.repos.jobs.get(job.id))?.status).toBe('failed');
  });

  it('stops work that exceeds its time limit and frees the slot for the next job', async () => {
    const jobs = new JobService(h.infra, 1, { heartbeatIntervalMs: 0 });
    const ctx = context();
    const gate = deferred();
    let abortedWhenResumed = false;
    const hung = await jobs.start(ctx, spec({ timeoutMs: 50 }), async (handle) => {
      await handle.stage('load');
      await gate.promise;
      abortedWhenResumed = handle.signal.aborted;
      return { resultRef: null };
    });
    const next = await jobs.start(ctx, spec(), async () => ({ resultRef: null }));
    await jobs.idle();

    const timedOut = await ctx.repos.jobs.get(hung.id);
    expect(timedOut?.status).toBe('failed');
    expect(timedOut?.error?.code).toBe('timeout');
    expect(timedOut?.progress.stages.find((stage) => stage.id === 'load')).toMatchObject({
      status: 'failed',
      detail: 'Timed out',
    });
    expect((await ctx.repos.jobs.get(next.id))?.status).toBe('succeeded');

    // The abandoned work wakes up later, sees it was told to stop, and changes nothing.
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(abortedWhenResumed).toBe(true);
    expect((await ctx.repos.jobs.get(hung.id))?.status).toBe('failed');
  });

  it('reports how many jobs wait for a slot', async () => {
    const depth = vi.spyOn(h.infra.metrics, 'setQueueDepth');
    try {
      const jobs = new JobService(h.infra, 1, { heartbeatIntervalMs: 0 });
      const ctx = context();
      const gate = deferred();
      const blocked = async () => {
        await gate.promise;
        return { resultRef: null };
      };
      await jobs.start(ctx, spec(), blocked);
      await jobs.start(ctx, spec(), blocked);
      await jobs.start(ctx, spec(), blocked);
      // The first job takes the only slot, so at most two wait.
      expect(depth).toHaveBeenCalledWith('jobs', 2);
      gate.resolve();
      await jobs.idle();
      expect(depth).toHaveBeenLastCalledWith('jobs', 0);
    } finally {
      depth.mockRestore();
    }
  });
});

describe('cancelling a job', () => {
  it('needs the permission that starts that kind of job', async () => {
    const jobs = new JobService(h.infra, 2, { heartbeatIntervalMs: 0 });
    const engineer = contextFor(h, PERSONAS.engineer);
    const curator = contextFor(h, PERSONAS.curator);
    const manager = contextFor(h, PERSONAS.manager);
    const gate = deferred();
    const blocked = async () => {
      await gate.promise;
      return { resultRef: null };
    };
    const analysis = await jobs.start(engineer, spec(), blocked);
    const mutation = await jobs.start(curator, spec({ kind: 'skill_mutation' }), blocked);

    await expect(jobs.cancel(manager, analysis.id)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(jobs.cancel(curator, analysis.id)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(jobs.cancel(engineer, mutation.id)).rejects.toBeInstanceOf(AuthorizationError);

    await jobs.cancel(engineer, analysis.id);
    await jobs.cancel(curator, mutation.id);
    gate.resolve();
    await jobs.idle();
    expect((await engineer.repos.jobs.get(analysis.id))?.status).toBe('cancelled');
    expect((await engineer.repos.jobs.get(mutation.id))?.status).toBe('cancelled');
  });

  it('is open to any signed-in user at the route, and refused by the service for the wrong role', async () => {
    const ctx = context();
    await ctx.repos.jobs.create(orphanJob('job_http_refused', CONTOSO, 'case_jobs'));
    await ctx.repos.jobs.create(orphanJob('job_http_allowed', CONTOSO, 'case_jobs'));
    const refused = await h.call(PERSONAS.manager, {
      method: 'POST',
      url: '/api/v1/jobs/job_http_refused/cancel',
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.data.code).toBe('forbidden');
    expect((await ctx.repos.jobs.get('job_http_refused'))?.status).toBe('running');

    const allowed = await h.call(PERSONAS.engineer, {
      method: 'POST',
      url: '/api/v1/jobs/job_http_allowed/cancel',
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.data.status).toBe('cancelled');
  });
});
