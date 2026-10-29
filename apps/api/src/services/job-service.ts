import type { Job, JobStage } from '@caseguard/schemas';
import { AppError, ConflictError, NotFoundError } from '../errors';
import { withSignal, type RequestContext } from '../http/request-context';
import type { Infrastructure } from '../infrastructure';
import type { JobHandle, JobPort, JobResult, JobSpec, JobWork } from './ports';

/** Jobs run on the API's event loop, so only a few run at once; the rest wait their turn. */
const DEFAULT_CONCURRENCY = 2;

const GENERIC_FAILURE = 'The job failed unexpectedly. Quote the job id when you contact support.';

class JobCancelledError extends Error {
  constructor() {
    super('The job was cancelled');
    this.name = 'JobCancelledError';
  }
}

interface Tracked {
  readonly controller: AbortController;
  readonly settled: Promise<void>;
  readonly resolveSettled: () => void;
  readonly execute: () => Promise<void>;
  state: 'queued' | 'running';
  cancelled: boolean;
}

type JobProgress = Job['progress'];

function initialStages(spec: JobSpec): JobStage[] {
  if (spec.stages.length === 0) throw new Error('A job needs at least one stage');
  return spec.stages.map((stage) => ({
    id: stage.id,
    label: stage.label,
    status: 'pending',
    startedAt: null,
    completedAt: null,
    detail: null,
  }));
}

function percentOf(stages: readonly JobStage[]): number {
  const finished = stages.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  const running = stages.some((s) => s.status === 'running') ? 0.5 : 0;
  return Math.min(99, Math.round((100 * (finished + running)) / stages.length));
}

function progressOf(stages: JobStage[], current: string): JobProgress {
  return { percent: percentOf(stages), stage: current, stages };
}

/**
 * Runs long operations in the background and persists their progress, so the UI can show real stages
 * (not a spinner) and a restarted server can tell which jobs it lost. The work function is cooperative:
 * it observes `handle.signal` / `throwIfCancelled()` between expensive steps.
 *
 * This is deliberately in-process: it is the simplest thing that is honest at demo scale. A durable
 * queue with separate workers is the documented next step (see docs/KNOWN_LIMITATIONS.md).
 */
export class JobService implements JobPort {
  private readonly tracked = new Map<string, Tracked>();
  private queue: string[] = [];
  private running = 0;

  constructor(
    private readonly infra: Pick<Infrastructure, 'repos' | 'now'>,
    private readonly concurrency = DEFAULT_CONCURRENCY,
  ) {}

  async start(ctx: RequestContext, spec: JobSpec, work: JobWork): Promise<Job> {
    if (spec.idempotencyKey) {
      const existing = await ctx.repos.jobs.findByIdempotencyKey(spec.kind, spec.idempotencyKey);
      if (existing) return existing;
    }
    const job = await this.createJob(ctx, spec);
    this.enqueue(ctx, job, work);
    return job;
  }

  async runToCompletion(ctx: RequestContext, spec: JobSpec, work: JobWork): Promise<Job> {
    const job = await this.start(ctx, spec, work);
    await this.tracked.get(job.id)?.settled;
    return (await ctx.repos.jobs.get(job.id)) ?? job;
  }

  async cancel(ctx: RequestContext, jobId: string): Promise<Job> {
    const job = await ctx.repos.jobs.get(jobId);
    if (job === null) throw new NotFoundError('Job', jobId);
    if (job.status !== 'queued' && job.status !== 'running') {
      throw new ConflictError('The job has already finished');
    }
    if (!job.cancellable) throw new ConflictError('This job cannot be cancelled');

    const tracked = this.tracked.get(jobId);
    const completedAt = ctx.now().toISOString();
    if (tracked === undefined) {
      // No live worker: left over from an earlier process. Close it so the UI stops waiting.
      return ctx.repos.jobs.update(jobId, { status: 'cancelled', completedAt, cancellable: false });
    }
    tracked.cancelled = true;
    tracked.controller.abort();
    if (tracked.state === 'queued') {
      this.queue = this.queue.filter((id) => id !== jobId);
      this.tracked.delete(jobId);
      tracked.resolveSettled();
      return ctx.repos.jobs.update(jobId, { status: 'cancelled', completedAt, cancellable: false });
    }
    return job;
  }

  async idle(): Promise<void> {
    while (this.tracked.size > 0) {
      await Promise.allSettled([...this.tracked.values()].map((entry) => entry.settled));
    }
  }

  async recoverOrphans(tenantIds: readonly string[]): Promise<number> {
    let recovered = 0;
    for (const tenantId of tenantIds) {
      const repos = this.infra.repos.forTenant({ tenantId, actorId: 'system:jobs' });
      recovered += await repos.jobs.failOrphaned('The server restarted while this job was running');
    }
    return recovered;
  }

  // ------------------------------------------------------------ internals

  private async createJob(ctx: RequestContext, spec: JobSpec): Promise<Job> {
    const stages = initialStages(spec);
    const job: Job = {
      id: ctx.newId('job'),
      tenantId: ctx.scope.tenantId,
      kind: spec.kind,
      status: 'queued',
      caseId: spec.caseId,
      targetId: spec.targetId ?? null,
      progress: progressOf(stages, stages[0]?.id ?? ''),
      error: null,
      resultRef: null,
      idempotencyKey: spec.idempotencyKey ?? null,
      createdAt: ctx.now().toISOString(),
      startedAt: null,
      completedAt: null,
      createdBy: ctx.auth.userId,
      cancellable: spec.cancellable ?? true,
    };
    await ctx.repos.jobs.create(job);
    return job;
  }

  private enqueue(ctx: RequestContext, job: Job, work: JobWork): void {
    const controller = new AbortController();
    let resolveSettled: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const tracked: Tracked = {
      controller,
      settled,
      resolveSettled,
      state: 'queued',
      cancelled: false,
      execute: () => this.execute(withSignal(ctx, controller.signal), job, work, tracked),
    };
    this.tracked.set(job.id, tracked);
    this.queue.push(job.id);
    // Let the HTTP response that created the job go out before the work starts.
    setImmediate(() => this.pump());
  }

  private pump(): void {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const id = this.queue.shift();
      const tracked = id === undefined ? undefined : this.tracked.get(id);
      if (id === undefined || tracked === undefined || tracked.cancelled) continue;
      this.running += 1;
      tracked.state = 'running';
      void tracked.execute().finally(() => {
        this.running -= 1;
        this.tracked.delete(id);
        tracked.resolveSettled();
        this.pump();
      });
    }
  }

  /** Never rejects: every outcome is written to the job row. */
  private async execute(
    ctx: RequestContext,
    job: Job,
    work: JobWork,
    tracked: Tracked,
  ): Promise<void> {
    const { repos } = ctx;
    const stages = job.progress.stages.map((stage) => ({ ...stage }));
    const tracker = ctx.metrics.startJob(job.kind);
    const log = ctx.logger.child({ jobId: job.id, jobKind: job.kind });
    const stamp = (): string => ctx.now().toISOString();
    let current = stages[0]?.id ?? '';

    const persist = async (): Promise<void> => {
      await repos.jobs.update(job.id, { progress: progressOf(stages, current) });
    };
    const throwIfCancelled = (): void => {
      if (tracked.cancelled || ctx.signal.aborted) throw new JobCancelledError();
    };
    const find = (stageId: string): JobStage => {
      const stage = stages.find((s) => s.id === stageId);
      if (stage === undefined) throw new Error(`Job stage "${stageId}" is not part of this job`);
      return stage;
    };

    const handle: JobHandle = {
      jobId: job.id,
      signal: ctx.signal,
      throwIfCancelled,
      async stage(stageId, detail) {
        throwIfCancelled();
        const target = find(stageId);
        const at = stamp();
        for (const stage of stages) {
          if (stage === target) break;
          if (stage.status === 'pending' || stage.status === 'running') {
            stage.status = stage.status === 'pending' ? 'skipped' : 'done';
            stage.completedAt = at;
          }
        }
        target.status = 'running';
        target.startedAt = at;
        target.detail = detail === undefined ? null : detail.slice(0, 300);
        current = stageId;
        await persist();
      },
      async skip(stageId, detail) {
        const target = find(stageId);
        target.status = 'skipped';
        target.completedAt = stamp();
        target.detail = detail.slice(0, 300);
        await persist();
      },
    };

    try {
      throwIfCancelled();
      await repos.jobs.update(job.id, { status: 'running', startedAt: stamp() });
      const result: JobResult = await work(handle, ctx);
      const at = stamp();
      for (const stage of stages) {
        if (stage.status === 'running') {
          stage.status = 'done';
          stage.completedAt = at;
        } else if (stage.status === 'pending') {
          stage.status = 'skipped';
          stage.detail = stage.detail ?? 'Not needed for this run';
          stage.completedAt = at;
        }
      }
      await repos.jobs.update(job.id, {
        status: 'succeeded',
        progress: { percent: 100, stage: stages[stages.length - 1]?.id ?? current, stages },
        resultRef: result.resultRef,
        completedAt: at,
        cancellable: false,
      });
      tracker.finish('succeeded');
    } catch (error) {
      const at = stamp();
      const running = stages.find((stage) => stage.status === 'running');
      if (error instanceof JobCancelledError) {
        if (running) {
          running.status = 'skipped';
          running.detail = 'Cancelled';
          running.completedAt = at;
        }
        await repos.jobs
          .update(job.id, {
            status: 'cancelled',
            progress: progressOf(stages, current),
            completedAt: at,
            cancellable: false,
          })
          .catch((updateError: unknown) =>
            log.error({ err: updateError }, 'could not record cancellation'),
          );
        tracker.finish('cancelled');
        return;
      }
      if (running) {
        running.status = 'failed';
        running.completedAt = at;
      }
      const appError = error instanceof AppError ? error : null;
      const expected = appError !== null && appError.status < 500;
      if (expected) log.warn({ err: error }, 'job failed');
      else log.error({ err: error }, 'job failed');
      await repos.jobs
        .update(job.id, {
          status: 'failed',
          progress: progressOf(stages, current),
          error: {
            code: appError?.code ?? 'internal',
            message:
              expected && appError !== null ? appError.message.slice(0, 400) : GENERIC_FAILURE,
          },
          completedAt: at,
          cancellable: false,
        })
        .catch((updateError: unknown) =>
          log.error({ err: updateError }, 'could not record failure'),
        );
      tracker.finish('failed', appError?.code ?? 'internal');
    }
  }
}
