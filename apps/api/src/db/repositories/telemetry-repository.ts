import {
  AgentNameSchema,
  ModelExecutionWithUsageSchema,
  PromptVersionSchema,
  type AgentName,
  type ModelExecutionWithUsage,
  type Page,
  type PromptVersion,
} from '@caseguard/schemas';
import { z } from 'zod';
import { ValidationFailedError } from '../../errors';
import { decodeCursor, encodeCursor, normalizeLimit, toPage } from '../cursor';
import { MODEL_EXECUTIONS, PROMPT_VERSIONS, TOKEN_USAGE } from './table-specs';
import {
  QueryBuilder,
  assertTenant,
  insertRows,
  normalizeInstant,
  parseStored,
  readCount,
  unique,
  validateInput,
  type DataRow,
  type RepoContext,
} from './support';
import type { SqlExecutor, TelemetryAggregate, TelemetryRepository } from './types';

const FAILURE_STATUSES = [
  'failed',
  'timed_out',
  'rejected_by_validation',
  'circuit_open',
  'budget_exceeded',
] as const;

const TotalsRow = z.object({
  executions: z.number(),
  prompt_tokens: z.number(),
  completion_tokens: z.number(),
  cached_tokens: z.number(),
  failures: z.number(),
  cache_hits: z.number(),
  avg_latency_ms: z.number(),
  cost: z.number().nullable(),
  compression: z.number(),
  cache_savings: z.number(),
  early_savings: z.number(),
});

const AgentRow = z.object({
  agent: AgentNameSchema,
  executions: z.number(),
  prompt_tokens: z.number(),
  completion_tokens: z.number(),
  cached_tokens: z.number(),
  avg_latency_ms: z.number(),
  cache_hits: z.number(),
  failures: z.number(),
  savings: z.number(),
});

const ModelRow = z.object({
  model: z.string(),
  provider: z.string(),
  executions: z.number(),
  total_tokens: z.number(),
  avg_latency_ms: z.number(),
});

/**
 * Upserts model executions and their token-usage rows inside the caller's transaction. Shared with
 * the analysis snapshot so executions are saved atomically with the artefacts they belong to.
 */
export async function upsertExecutions(
  tx: SqlExecutor,
  ctx: RepoContext,
  items: readonly ModelExecutionWithUsage[],
): Promise<void> {
  if (items.length === 0) return;
  const executions = validateInput(
    z.array(ModelExecutionWithUsageSchema),
    items,
    'model executions',
  );
  const ids = new Set<string>();
  for (const execution of executions) {
    assertTenant(ctx, execution.tenantId);
    if (ids.has(execution.id)) {
      throw new ValidationFailedError('Invalid model executions', [
        { path: 'id', message: `Duplicate execution ${execution.id}` },
      ]);
    }
    ids.add(execution.id);
    const usage = execution.usage;
    if (usage) {
      assertTenant(ctx, usage.tenantId);
      if (usage.modelExecutionId !== execution.id) {
        throw new ValidationFailedError('Invalid model executions', [
          { path: 'usage.modelExecutionId', message: 'The usage belongs to another execution' },
        ]);
      }
    }
  }
  await insertRows(tx, MODEL_EXECUTIONS, executions, 'upsert');
  // The unique (tenant, execution) index means a re-saved execution replaces its usage row.
  await tx.query(
    'DELETE FROM token_usage WHERE tenant_id = $1 AND model_execution_id = ANY($2::text[])',
    [ctx.scope.tenantId, [...ids]],
  );
  const usages = executions.flatMap((execution) => (execution.usage ? [execution.usage] : []));
  await insertRows(tx, TOKEN_USAGE, usages);
}

function startOfUtcDay(now: Date): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
}

function compareSemver(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

export class TelemetryRepositoryImpl implements TelemetryRepository {
  constructor(private readonly ctx: RepoContext) {}

  async saveExecutions(items: ModelExecutionWithUsage[]): Promise<void> {
    await this.ctx.run((tx) => upsertExecutions(tx, this.ctx, items));
  }

  async listExecutions(query: {
    caseId?: string | undefined;
    agent?: AgentName | undefined;
    limit: number;
    cursor?: string | undefined;
  }): Promise<Page<ModelExecutionWithUsage>> {
    const limit = normalizeLimit(query.limit);
    const cursor = decodeCursor('executions', query.cursor, ['timestamp', 'text']);
    const q = new QueryBuilder();
    q.where(`tenant_id = ${q.bind(this.ctx.scope.tenantId)}`);
    if (query.caseId) q.where(`case_id = ${q.bind(query.caseId)}`);
    if (query.agent)
      q.where(`agent = ${q.bind(validateInput(AgentNameSchema, query.agent, 'agent'))}`);
    if (cursor) {
      q.where(`(started_at, id) < (${q.bind(cursor[0])}::timestamptz, ${q.bind(cursor[1])}::text)`);
    }
    const limitParam = q.bind(limit + 1);
    const rows = await this.ctx.run(async (tx) => {
      const result = await tx.query<DataRow & { sort_ts: string; id: string }>(
        `SELECT data, started_at AS sort_ts, id FROM model_executions WHERE ${q.clause}
          ORDER BY started_at DESC, id DESC LIMIT ${limitParam}::integer`,
        q.params,
      );
      return result.rows;
    });
    return toPage(
      rows,
      limit,
      (row) => parseStored(ModelExecutionWithUsageSchema, row.data, 'model execution'),
      (row) => encodeCursor('executions', [row.sort_ts, row.id]),
    );
  }

  async aggregate(query: {
    caseId?: string | undefined;
    since?: string | undefined;
  }): Promise<TelemetryAggregate> {
    const q = new QueryBuilder();
    q.where(`e.tenant_id = ${q.bind(this.ctx.scope.tenantId)}`);
    if (query.caseId) q.where(`e.case_id = ${q.bind(query.caseId)}`);
    if (query.since)
      q.where(`e.started_at >= ${q.bind(normalizeInstant(query.since, 'since'))}::timestamptz`);
    const failureList = FAILURE_STATUSES.map((status) => `'${status}'`).join(', ');
    const from = `FROM model_executions e
      LEFT JOIN token_usage u ON u.tenant_id = e.tenant_id AND u.model_execution_id = e.id
      WHERE ${q.clause}`;
    const failures = `(count(*) FILTER (WHERE e.status IN (${failureList})))::int`;
    const cacheHits = `(count(*) FILTER (WHERE e.status = 'cache_hit' OR coalesce(u.cache_hit, false)))::int`;
    const sums = (column: string): string => `coalesce(sum(u.${column}), 0)::float8`;
    const todayStart = startOfUtcDay(this.ctx.now());

    return this.ctx.run(async (tx) => {
      const totalsResult = await tx.query(
        `SELECT count(*)::int AS executions,
                ${sums('prompt_tokens')} AS prompt_tokens,
                ${sums('completion_tokens')} AS completion_tokens,
                ${sums('cached_tokens')} AS cached_tokens,
                ${failures} AS failures,
                ${cacheHits} AS cache_hits,
                coalesce(avg(e.latency_ms), 0)::float8 AS avg_latency_ms,
                sum(u.estimated_cost_usd)::float8 AS cost,
                coalesce(sum(greatest(u.context_tokens_before - u.context_tokens_after, 0))
                  FILTER (WHERE NOT u.cache_hit AND NOT u.early_stopped), 0)::float8 AS compression,
                coalesce(sum(u.estimated_savings_tokens) FILTER (WHERE u.cache_hit), 0)::float8 AS cache_savings,
                coalesce(sum(u.estimated_savings_tokens)
                  FILTER (WHERE u.early_stopped AND NOT u.cache_hit), 0)::float8 AS early_savings
           ${from}`,
        q.params,
      );
      const totals = parseStored(TotalsRow, totalsResult.rows[0], 'telemetry totals');
      const byAgent = await tx.query(
        `SELECT e.agent AS agent, count(*)::int AS executions,
                ${sums('prompt_tokens')} AS prompt_tokens,
                ${sums('completion_tokens')} AS completion_tokens,
                ${sums('cached_tokens')} AS cached_tokens,
                coalesce(avg(e.latency_ms), 0)::float8 AS avg_latency_ms,
                ${cacheHits} AS cache_hits, ${failures} AS failures,
                ${sums('estimated_savings_tokens')} AS savings
           ${from} GROUP BY e.agent ORDER BY e.agent`,
        q.params,
      );
      const byModel = await tx.query(
        `SELECT e.model AS model, e.provider AS provider, count(*)::int AS executions,
                ${sums('total_tokens')} AS total_tokens,
                coalesce(avg(e.latency_ms), 0)::float8 AS avg_latency_ms
           ${from} GROUP BY e.model, e.provider ORDER BY e.model, e.provider`,
        q.params,
      );
      // The daily budget is tenant-wide and ignores the caseId/since filters of this query.
      const tokensToday = await readCount(
        tx,
        `SELECT coalesce(sum(u.total_tokens), 0)::float8 AS n
           FROM model_executions e
           JOIN token_usage u ON u.tenant_id = e.tenant_id AND u.model_execution_id = e.id
          WHERE e.tenant_id = $1 AND e.started_at >= $2::timestamptz`,
        [this.ctx.scope.tenantId, todayStart],
      );
      return {
        totals: {
          executions: totals.executions,
          promptTokens: totals.prompt_tokens,
          completionTokens: totals.completion_tokens,
          cachedTokens: totals.cached_tokens,
          failures: totals.failures,
          cacheHits: totals.cache_hits,
          avgLatencyMs: totals.avg_latency_ms,
          estimatedCostUsd: totals.cost,
        },
        byAgent: byAgent.rows.map((row) => {
          const parsed = parseStored(AgentRow, row, 'telemetry by agent');
          return {
            agent: parsed.agent,
            executions: parsed.executions,
            promptTokens: parsed.prompt_tokens,
            completionTokens: parsed.completion_tokens,
            cachedTokens: parsed.cached_tokens,
            avgLatencyMs: parsed.avg_latency_ms,
            cacheHits: parsed.cache_hits,
            failures: parsed.failures,
            estimatedSavingsTokens: parsed.savings,
          };
        }),
        byModel: byModel.rows.map((row) => {
          const parsed = parseStored(ModelRow, row, 'telemetry by model');
          return {
            model: parsed.model,
            provider: parsed.provider,
            executions: parsed.executions,
            totalTokens: parsed.total_tokens,
            avgLatencyMs: parsed.avg_latency_ms,
          };
        }),
        savings: {
          contextCompressionTokens: totals.compression,
          // Duplicate removal is part of context compression and not tracked separately.
          duplicateRemovalTokens: 0,
          cacheHitTokens: totals.cache_savings,
          earlyStopTokens: totals.early_savings,
        },
        tokensToday,
      };
    });
  }

  async upsertPromptVersions(items: PromptVersion[]): Promise<void> {
    if (items.length === 0) return;
    const versions = validateInput(z.array(PromptVersionSchema), items, 'prompt versions');
    for (const version of versions) assertTenant(this.ctx, version.tenantId);
    if (unique(versions.map((version) => version.id)).length !== versions.length) {
      throw new ValidationFailedError('Invalid prompt versions', [
        { path: 'id', message: 'Prompt version ids must be unique' },
      ]);
    }
    await this.ctx.run((tx) => insertRows(tx, PROMPT_VERSIONS, versions, 'upsert'));
  }

  async listPromptVersions(): Promise<PromptVersion[]> {
    const versions = await this.ctx.run(async (tx) => {
      const result = await tx.query<DataRow>(
        'SELECT data FROM prompt_versions WHERE tenant_id = $1 ORDER BY agent, id LIMIT 500',
        [this.ctx.scope.tenantId],
      );
      return result.rows.map((row) => parseStored(PromptVersionSchema, row.data, 'prompt version'));
    });
    return versions.sort(
      (a, b) => a.agent.localeCompare(b.agent) || compareSemver(a.version, b.version),
    );
  }
}
