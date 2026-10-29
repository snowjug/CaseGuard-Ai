import {
  JobSchema,
  JobStatusSchema,
  JobKindSchema,
  type Job,
  type JobKind,
  type JobStatus,
  type Page,
} from '@caseguard/schemas';
import { ConflictError, NotFoundError } from '../../errors';
import { decodeCursor, encodeCursor, normalizeLimit, toPage } from '../cursor';
import { JOBS } from './table-specs';
import {
  QueryBuilder,
  assertTenant,
  insertRows,
  nowIso,
  parseStored,
  updateRow,
  validateInput,
  type DataRow,
  type RepoContext,
} from './support';
import type { JobRepository } from './types';

const TERMINAL: readonly JobStatus[] = ['succeeded', 'failed', 'cancelled'];

const PatchSchema = JobSchema.pick({
  status: true,
  progress: true,
  error: true,
  resultRef: true,
  startedAt: true,
  completedAt: true,
  cancellable: true,
}).partial();

export class JobRepositoryImpl implements JobRepository {
  constructor(private readonly ctx: RepoContext) {}

  async create(job: Job): Promise<void> {
    const valid = validateInput(JobSchema, job, 'job');
    assertTenant(this.ctx, valid.tenantId);
    await this.ctx.run((tx) => insertRows(tx, JOBS, [valid]));
  }

  async update(
    jobId: string,
    patch: Partial<
      Pick<
        Job,
        'status' | 'progress' | 'error' | 'resultRef' | 'startedAt' | 'completedAt' | 'cancellable'
      >
    >,
  ): Promise<Job> {
    const valid = validateInput(PatchSchema, patch, 'job update');
    return this.ctx.run(async (tx) => {
      // The row lock keeps concurrent progress/cancel updates from overwriting each other.
      const result = await tx.query<DataRow>(
        'SELECT data FROM jobs WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
        [this.ctx.scope.tenantId, jobId],
      );
      const row = result.rows[0];
      if (!row) throw new NotFoundError('Job', jobId);
      const current = parseStored(JobSchema, row.data, 'job');
      if (
        TERMINAL.includes(current.status) &&
        valid.status !== undefined &&
        valid.status !== current.status
      ) {
        throw new ConflictError(`The job already finished as ${current.status}`, {
          reason: 'job_terminal',
        });
      }
      const defined = Object.fromEntries(
        Object.entries(valid).filter(([, value]) => value !== undefined),
      );
      const next = validateInput(JobSchema, { ...current, ...defined }, 'job');
      await updateRow(tx, JOBS, next, {
        columns: ['status', 'started_at', 'completed_at', 'cancellable', 'data'],
      });
      return next;
    });
  }

  async get(jobId: string): Promise<Job | null> {
    return this.ctx.run(async (tx) => {
      const result = await tx.query<DataRow>(
        'SELECT data FROM jobs WHERE tenant_id = $1 AND id = $2',
        [this.ctx.scope.tenantId, jobId],
      );
      const row = result.rows[0];
      return row ? parseStored(JobSchema, row.data, 'job') : null;
    });
  }

  async list(query: {
    caseId?: string | undefined;
    status?: JobStatus | undefined;
    kind?: JobKind | undefined;
    limit: number;
    cursor?: string | undefined;
  }): Promise<Page<Job>> {
    const limit = normalizeLimit(query.limit);
    const cursor = decodeCursor('jobs', query.cursor, ['timestamp', 'text']);
    const q = new QueryBuilder();
    q.where(`tenant_id = ${q.bind(this.ctx.scope.tenantId)}`);
    if (query.caseId) q.where(`case_id = ${q.bind(query.caseId)}`);
    if (query.status)
      q.where(`status = ${q.bind(validateInput(JobStatusSchema, query.status, 'status'))}`);
    if (query.kind) q.where(`kind = ${q.bind(validateInput(JobKindSchema, query.kind, 'kind'))}`);
    if (cursor) {
      q.where(`(created_at, id) < (${q.bind(cursor[0])}::timestamptz, ${q.bind(cursor[1])}::text)`);
    }
    const limitParam = q.bind(limit + 1);
    const rows = await this.ctx.run(async (tx) => {
      const result = await tx.query<DataRow & { sort_ts: string; id: string }>(
        `SELECT data, created_at AS sort_ts, id FROM jobs WHERE ${q.clause}
          ORDER BY created_at DESC, id DESC LIMIT ${limitParam}::integer`,
        q.params,
      );
      return result.rows;
    });
    return toPage(
      rows,
      limit,
      (row) => parseStored(JobSchema, row.data, 'job'),
      (row) => encodeCursor('jobs', [row.sort_ts, row.id]),
    );
  }

  async findByIdempotencyKey(kind: JobKind, key: string): Promise<Job | null> {
    return this.ctx.run(async (tx) => {
      const result = await tx.query<DataRow>(
        'SELECT data FROM jobs WHERE tenant_id = $1 AND kind = $2 AND idempotency_key = $3',
        [this.ctx.scope.tenantId, kind, key],
      );
      const row = result.rows[0];
      return row ? parseStored(JobSchema, row.data, 'job') : null;
    });
  }

  /**
   * Fails every job a previous process left queued or running. The in-memory runner does not resume
   * work after a restart, so a non-terminal job found at startup can never finish on its own.
   */
  async failOrphaned(reason: string): Promise<number> {
    const message = reason.trim().slice(0, 400) || 'The job was interrupted by a restart';
    const at = nowIso(this.ctx);
    return this.ctx.run(async (tx) => {
      const result = await tx.query(
        `UPDATE jobs
            SET status = 'failed', completed_at = $2::timestamptz, cancellable = false,
                data = data || jsonb_build_object(
                  'status', 'failed',
                  'completedAt', $3::text,
                  'cancellable', false,
                  'error', jsonb_build_object('code', 'orphaned', 'message', $4::text))
          WHERE tenant_id = $1 AND status IN ('queued', 'running')`,
        [this.ctx.scope.tenantId, at, at, message],
      );
      return result.rowCount;
    });
  }
}
