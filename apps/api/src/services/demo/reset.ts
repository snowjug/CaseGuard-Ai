import type { RequestContext } from '../../http/request-context';
import { buildObjectKey, scopeObjectStoreToTenant } from '../../storage';
import { auditDemo, auditDemoQuietly } from './audit';
import { assertDemoManageable, assertNoActiveJobs } from './guard';

/** A reset sweeps the stored payloads of at most this many cases; a demo tenant holds a handful. */
const MAX_PAYLOAD_SWEEP = 1_000;
const PAGE_SIZE = 200;

/** What one erasure removed: counters only, so it can go straight into an audit event. */
export interface ErasureSummary {
  readonly cases: number;
  readonly skills: number;
  readonly payloadsRemoved: number;
  readonly payloadsKept: number;
}

/** The object-store keys of the stored case payloads, read before the rows that name them are erased. */
async function payloadKeys(ctx: RequestContext): Promise<{ keys: string[]; complete: boolean }> {
  const keys: string[] = [];
  let cursor: string | undefined;
  let swept = 0;
  do {
    const page = await ctx.repos.cases.list({
      limit: PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const item of page.items) {
      const source = await ctx.repos.cases.getSource(item.id);
      if (source === null) continue;
      keys.push(
        buildObjectKey({ tenantId: ctx.scope.tenantId, caseId: item.id, sourceId: source.id }),
      );
    }
    swept += page.items.length;
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined && swept < MAX_PAYLOAD_SWEEP);
  return { keys, complete: cursor === undefined };
}

/**
 * Erases the tenant's case data (cases and everything derived, skills, jobs, telemetry, the seed
 * marker) and then the mirrored payloads in the object store. Users, governance settings and the audit
 * trail stay. A payload that cannot be removed is logged (its key holds ids only) and counted.
 */
export async function eraseCaseData(ctx: RequestContext): Promise<ErasureSummary> {
  const counts = await ctx.repos.cases.counts();
  const skills = await ctx.repos.skills.list({ limit: PAGE_SIZE });
  const { keys, complete } = await payloadKeys(ctx);

  await ctx.repos.demo.resetTenantData();

  const store = scopeObjectStoreToTenant(ctx.services.objects, ctx.scope.tenantId);
  let removed = 0;
  let kept = complete ? 0 : 1;
  for (const key of keys) {
    try {
      if (await store.delete(key)) removed += 1;
    } catch (error) {
      kept += 1;
      ctx.logger.warn(
        { err: error, key, event: 'demo.reset.payload_not_removed' },
        'a stored case payload could not be removed',
      );
    }
  }
  return {
    cases: counts.total,
    skills: skills.items.length,
    payloadsRemoved: removed,
    payloadsKept: kept,
  };
}

/**
 * `demo.reset`: only in a synthetic demo tenant, never while a job runs, and audited before and after
 * (`demo.reset` with `phase` started, completed or failed). The caller reads the fresh state.
 */
export async function resetDemo(ctx: RequestContext): Promise<void> {
  await assertDemoManageable(ctx, 'demo.reset');
  await assertNoActiveJobs(ctx, 'demo.reset');
  await auditDemo(ctx, 'demo.reset', 'success', { phase: 'started' });
  let summary: ErasureSummary;
  try {
    summary = await eraseCaseData(ctx);
  } catch (error) {
    await auditDemoQuietly(ctx, 'demo.reset', 'failure', { phase: 'failed' });
    throw error;
  }
  await auditDemo(ctx, 'demo.reset', 'success', { phase: 'completed', ...summary });
}
