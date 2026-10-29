import { setTimeout as sleep } from 'node:timers/promises';
import type { Job, JobKind, JobStage, Permission } from '@caseguard/schemas';
import { AuthorizationError } from '@caseguard/security';
import { AppError, ConflictError, NotFoundError } from '../errors';
import { withSignal, type RequestContext } from '../http/request-context';
import type { Infrastructure } from '../infrastructure';
import type { JobHandle, JobPort, JobResult, JobSpec, JobWork } from './ports';

/** Jobs run on the API's event loop, so only a few run at once; the rest wait their turn. */
const DEFAULT_CONCURRENCY = 2;
/** A job still running after this long is stopped and recorded as failed: a hung step must not hold a slot forever. */
export const DEFAULT_JOB_TIMEOUT_MS = 10 * 60_000;
/** How often the process that owns jobs tells the database it is alive (and hears of a cancel requested elsewhere). */
export const JOB_HEARTBEAT_INTERVAL_MS = 10_000;
/** A job whose owner has been silent this long (six missed heartbeats) has no live owner. */
export const JOB_STALE_AFTER_MS = 60_000;
/** Writes that record how a job ended are retried this many times before the failure is logged. */
const OUTCOME_WRITE_ATTEMPTS = 3;

const GENERIC_FAILURE = 'The job failed unexpectedly. Quote the job id when you contact support.';
const ORPHANED_REASON = 'The server running this job restarted or stopped responding';

/** Who may cancel which job: the permission that lets a user start that kind of job. */
const CANCEL_PERMISSION: Readonly<Record<JobKind, Permission>> = {
  case_analysis: 'case:analyze',
  counterfactual: 'counterfactual:run',
  skill_extraction: 'skill:extract',
  skill_mutation: 'skill:mutate',
  demo_seed: 'demo:manage',
};

class JobCancelledError extends Error {
  constructor() {
    super('The job was cancelled');
    this.name = 'JobCancelledError';
  }
}

class JobTimeoutError extends Error {
  constructor(readonly limitMs: number) {
    super(`The job did not finish within ${limitMs} ms`);
    this.name = 'JobTimeoutError';
  }
}

interface Tracked {
  readonly ctx: RequestContext;
  readonly controller: AbortController;
  readonly settled: Promise<void>;
  readonly resolveSettled: () => void;
  readonly execute: () => Promise<void>;
  state: 'queued' | 'running';
  cancelled: boolean;
}

type JobProgress = Job['progress'];
type JobPatch = Parameters<RequestContext['repos']['jobs']['update']>[1];

/** Timing knobs; tests shorten them. */
export interface JobTuning {
  /** 0 turns the heartbeat off. */
  readonly heartbeatIntervalMs: number;
  readonly defaultTimeoutMs: number;
  /** Pause before the first retry of a write that records an outcome; it grows with each attempt. */
  readonly retryDelayMs: number;
}

const DEFAULT_TUNING: JobTuning = {
  heartbeatIntervalMs: JOB_HEARTBEAT_INTERVAL_MS,
  defaultTimeoutMs: DEFAULT_JOB_TIMEOUT_MS,
  retryDelayMs: 250,
};

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

/** Rejects with `JobTimeoutError` after `limitMs`, calling `onTimeout` first so cooperative work stops. */
function withDeadline<T>(work: Promise<T>, limitMs: number, onTimeout: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new JobTimeoutError(limitMs));
    }, limitMs);
    timer.unref();
  });
  // `race` keeps a late failure of the abandoned work from surfacing as an unhandled rejection.
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Runs long operations in the background and persists their progress, so the UI can show real stages
 * (not a spinner) and a restarted server can tell which jobs it lost. The work function is cooperative:
 * it observes `handle.signal` / `throwIfCancelled()` between expensive steps.
 *
 * Jobs run in the process that accepted them. With several replicas (or an old and a new revision
 * during a rollout) that process says it is alive every few seconds; a job whose owner has been silent
 * for `JOB_STALE_AFTER_MS` is failed as orphaned by whichever process sweeps next, and a cancel that
 * reaches another replica is noticed by the owner at its next heartbeat. A durable queue with separate
 * workers is the documented next step (see docs/KNOWN_LIMITATIONS.md).
 */
export class JobService implements JobPort {
  private readonly tracked = new Map<string, Tracked>();
  private readonly tuning: JobTuning;
  private queue: string[] = [];
  private running = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly infra: Pick<Infrastructure, 'repos' | 'now' | 'metrics'>,
    private readonly concurrency = DEFAULT_CONCURRENCY,
    tuning: Partial<JobTuning> = {},
  ) {
    this.tuning = { ...DEFAULT_TUNING, ...tuning };
  }

  async start(ctx: RequestContext, spec: JobSpec, work: JobWork): Promise<Job> {
    if (spec.idempotencyKey) {
      const existing = await ctx.repos.jobs.findByIdempotencyKey(spec.kind, spec.idempotencyKey);
      if (existing) return existing;
    }
    const job = await this.createJob(ctx, spec);
    this.enqueue(ctx, job, work, spec.timeoutMs ?? this.tuning.defaultTimeoutMs);
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
    const required = CANCEL_PERMISSION[job.kind];
    if (!ctx.auth.permissions.includes(required)) throw new AuthorizationError(undefined, required);
    if (job.status !== 'queued' && job.status !== 'running') {
      throw new ConflictError('The job has already finished');
    }
    if (!job.cancellable) throw new ConflictError('This job cannot be cancelled');

    const completedAt = ctx.now().toISOString();
    const cancelled = { status: 'cancelled', completedAt, cancellable: false } as const;
    const tracked = this.tracked.get(jobId);
    if (tracked === undefined) {
      // Not run by this process: left over from an earlier one, or owned by another replica, which
      // sees the new status at its next heartbeat and stops the work.
      return ctx.repos.jobs.update(jobId, cancelled);
    }
    this.stop(jobId, tracked);
    if (tracked.state === 'queued') return ctx.repos.jobs.update(jobId, cancelled);
    return job;
  }

  async idle(): Promise<void> {
    while (this.tracked.size > 0) {
      await Promise.allSettled([...this.tracked.values()].map((entry) => entry.settled));
    }
  }

  async recoverOrphans(
    tenantIds: readonly string[],
    options: { readonly staleAfterMs?: number } = {},
  ): Promise<number> {
    const staleBefore =
      options.staleAfterMs === undefined
        ? {}
        : {
            staleBefore: new Date(this.infra.now().getTime() - options.staleAfterMs).toISOString(),
          };
    let recovered = 0;
    for (const tenantId of tenantIds) {
      const repos = this.infra.repos.forTenant({ tenantId, actorId: 'system:jobs' });
      recovered += await repos.jobs.failOrphaned(ORPHANED_REASON, staleBefore);
    }
    return recovered;
  }

  /**
   * Tells the database that every job this process owns is alive, and stops any job whose outcome was
   * decided elsewhere (cancelled on another replica, failed as orphaned while this process was stalled).
   * Runs on a timer while jobs exist; exposed for tests.
   */
  async beat(): Promise<void> {
    await Promise.all([...this.tracked].map(([jobId, tracked]) => this.beatOne(jobId, tracked)));
  }

  // ------------------------------------------------------------ internals

  private async beatOne(jobId: string, tracked: Tracked): Promise<void> {
    try {
      const status = await tracked.ctx.repos.jobs.heartbeat(jobId);
      const alive = status === 'queued' || status === 'running';
      // Cancelled on another replica, failed as orphaned while this process stalled, or gone: stop working.
      if (!alive && !tracked.cancelled) this.stop(jobId, tracked);
    } catch (error) {
      // A database blip must not take the process down; the next beat tries again.
      tracked.ctx.logger.warn(
        { err: error, jobId, event: 'job.heartbeat_failed' },
        'could not record the job heartbeat',
      );
    }
  }

  /** Asks the work to stop; a job still waiting for a slot is dropped from the queue. */
  private stop(jobId: string, tracked: Tracked): void {
    tracked.cancelled = true;
    tracked.controller.abort();
    if (tracked.state !== 'queued') return;
    this.queue = this.queue.filter((id) => id !== jobId);
    this.tracked.delete(jobId);
    tracked.resolveSettled();
    this.reportQueueDepth();
    this.stopHeartbeatWhenIdle();
  }

  private reportQueueDepth(): void {
    this.infra.metrics.setQueueDepth('jobs', this.queue.length);
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer !== null || this.tuning.heartbeatIntervalMs <= 0) return;
    this.heartbeatTimer = setInterval(() => void this.beat(), this.tuning.heartbeatIntervalMs);
    this.heartbeatTimer.unref();
  }

  private stopHeartbeatWhenIdle(): void {
    if (this.tracked.size > 0 || this.heartbeatTimer === null) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

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

  private enqueue(ctx: RequestContext, job: Job, work: JobWork, timeoutMs: number): void {
    const controller = new AbortController();
    let resolveSettled: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const tracked: Tracked = {
      ctx,
      controller,
      settled,
      resolveSettled,
      state: 'queued',
      cancelled: false,
      execute: () =>
        this.execute(withSignal(ctx, controller.signal), job, work, tracked, timeoutMs),
    };
    this.tracked.set(job.id, tracked);
    this.queue.push(job.id);
    this.reportQueueDepth();
    this.startHeartbeat();
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
      this.reportQueueDepth();
      void tracked.execute().finally(() => {
        this.running -= 1;
        this.tracked.delete(id);
        tracked.resolveSettled();
        this.stopHeartbeatWhenIdle();
        this.pump();
      });
    }
  }

  /** Writes how a job ended, retrying a few times; a job that is already finished is never rewritten. */
  private async record(
    ctx: RequestContext,
    jobId: string,
    patch: JobPatch,
    what: string,
  ): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await ctx.repos.jobs.update(jobId, patch);
        return;
      } catch (error) {
        const hopeless =
          error instanceof ConflictError ||
          error instanceof NotFoundError ||
          attempt >= OUTCOME_WRITE_ATTEMPTS;
        if (hopeless) {
          // The job stops heartbeating, so a later sweep fails it as orphaned instead of leaving it running.
          ctx.logger.error(
            { err: error, jobId, event: 'job.outcome_not_recorded' },
            `could not record ${what}`,
          );
          return;
        }
        await sleep(this.tuning.retryDelayMs * attempt);
      }
    }
  }

  /** Never rejects: every outcome is written to the job row. */
  private async execute(
    ctx: RequestContext,
    job: Job,
    work: JobWork,
    tracked: Tracked,
    timeoutMs: number,
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
      await repos.jobs
        .update(job.id, { status: 'running', startedAt: stamp() })
        .catch((error: unknown) => {
          // The repository refuses to reopen a finished job: another replica cancelled it (or failed it
          // as orphaned) while it waited for a slot.
          throw error instanceof ConflictError ? new JobCancelledError() : error;
        });
      const result: JobResult = await withDeadline(work(handle, ctx), timeoutMs, () =>
        tracked.controller.abort(),
      );
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
      await this.record(
        ctx,
        job.id,
        {
          status: 'succeeded',
          progress: { percent: 100, stage: stages[stages.length - 1]?.id ?? current, stages },
          resultRef: result.resultRef,
          completedAt: at,
          cancellable: false,
        },
        'the result of the job',
      );
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
        await this.record(
          ctx,
          job.id,
          {
            status: 'cancelled',
            progress: progressOf(stages, current),
            completedAt: at,
            cancellable: false,
          },
          'the cancellation',
        );
        tracker.finish('cancelled');
        return;
      }
      if (running) {
        running.status = 'failed';
        running.completedAt = at;
      }
      if (error instanceof JobTimeoutError) {
        log.error(
          { limitMs: error.limitMs, event: 'job.timed_out' },
          'job exceeded its time limit',
        );
        if (running) running.detail = 'Timed out';
        await this.record(
          ctx,
          job.id,
          {
            status: 'failed',
            progress: progressOf(stages, current),
            error: {
              code: 'timeout',
              message: `The job did not finish within ${Math.max(1, Math.round(error.limitMs / 1000))} seconds and was stopped.`,
            },
            completedAt: at,
            cancellable: false,
          },
          'the time-out',
        );
        tracker.finish('failed', 'timeout');
        return;
      }
      const appError = error instanceof AppError ? error : null;
      const expected = appError !== null && appError.status < 500;
      if (expected) log.warn({ err: error }, 'job failed');
      else log.error({ err: error }, 'job failed');
      await this.record(
        ctx,
        job.id,
        {
          status: 'failed',
          progress: progressOf(stages, current),
          error: {
            code: appError?.code ?? 'internal',
            message:
              expected && appError !== null ? appError.message.slice(0, 400) : GENERIC_FAILURE,
          },
          completedAt: at,
          cancellable: false,
        },
        'the failure',
      );
      tracker.finish('failed', appError?.code ?? 'internal');
    }
  }
}
