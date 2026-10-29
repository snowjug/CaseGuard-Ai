import { ConflictError, NotFoundError } from '../../errors';
import type { RequestContext } from '../../http/request-context';
import { buildObjectKey, scopeObjectStoreToTenant } from '../../storage';

/** A job that still works on the case would write results into rows that are about to disappear. */
async function assertNoActiveJob(ctx: RequestContext, caseId: string): Promise<void> {
  for (const status of ['queued', 'running'] as const) {
    const page = await ctx.repos.jobs.list({ caseId, status, limit: 1 });
    if (page.items.length > 0) {
      throw new ConflictError(
        'A job for this case is still queued or running. Cancel it or wait until it has finished, then delete the case.',
        { reason: 'job_active' },
      );
    }
  }
}

/**
 * Administrator erasure of a case and everything derived from it (events, analysis artefacts,
 * scenarios, matches, jobs, telemetry: the repository cascades), together with the mirrored payload in
 * the object store. The database delete and the audit record `case.deleted` (counts only) commit
 * together. The object is removed last inside the same transaction: if the store fails, nothing is
 * deleted and the call can be retried, and an erased case never leaves its redacted payload behind.
 * A second call finds nothing and is a 404.
 */
export async function deleteCase(ctx: RequestContext, caseId: string): Promise<{ deleted: true }> {
  const record = await ctx.repos.cases.get(caseId);
  if (record === null) throw new NotFoundError('Case', caseId);
  await assertNoActiveJob(ctx, caseId);

  const [participants, source] = await Promise.all([
    ctx.repos.cases.getParticipants(caseId),
    ctx.repos.cases.getSource(caseId),
  ]);
  const { tenantId } = ctx.scope;
  const store = scopeObjectStoreToTenant(ctx.services.objects, tenantId);

  await ctx.repos.transaction(async (tx) => {
    if (!(await tx.cases.delete(caseId))) throw new NotFoundError('Case', caseId);
    await ctx.audit(
      {
        action: 'case.deleted',
        targetType: 'case',
        targetId: caseId,
        caseId,
        outcome: 'success',
        details: {
          reference: record.reference,
          eventCount: record.eventCount,
          participantCount: participants.length,
          hadAnalysis: record.analyzedAt !== null,
          sourceKind: record.sourceKind,
        },
      },
      tx,
    );
    if (source !== null) {
      await store.delete(buildObjectKey({ tenantId, caseId, sourceId: source.id }));
    }
  });
  ctx.logger.info({ event: 'case.deleted', caseId }, 'case deleted');
  return { deleted: true };
}
