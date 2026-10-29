import { normalizeBundle } from '@caseguard/domain';
import type { Case, IngestResult, IngestionPreview, Job } from '@caseguard/schemas';
import type { IngestCaseInput, TenantRepositories } from '../../db';
import { AppError, ConflictError } from '../../errors';
import type { RequestContext } from '../../http/request-context';
import { buildObjectKey, scopeObjectStoreToTenant, type ObjectStore } from '../../storage';
import { summarizeCase } from '../cases/summaries';
import type { PreparedPayload } from './types';

const REFERENCE_PAGE_SIZE = 200;
const REFERENCE_MAX_PAGES = 10;

/** A payload that passed the pipeline, with what the caller is told about it. */
export interface AcceptedPayload {
  readonly prepared: PreparedPayload;
  readonly preview: IngestionPreview;
}

export interface PersistOptions {
  readonly analyze: boolean;
}

/**
 * True when a case of this tenant already uses `reference`. The case table has no unique index on
 * the reference (only on the content), so the service checks; `q` narrows by substring and the exact
 * comparison decides. Two concurrent requests with the same new reference can still both pass.
 */
async function referenceInUse(repos: TenantRepositories, reference: string): Promise<boolean> {
  let cursor: string | undefined;
  for (let page = 0; page < REFERENCE_MAX_PAGES; page += 1) {
    const result = await repos.cases.list({
      limit: REFERENCE_PAGE_SIZE,
      q: reference,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (result.items.some((item) => item.reference === reference)) return true;
    if (result.nextCursor === null) return false;
    cursor = result.nextCursor;
  }
  return false;
}

/** The reference is validated (upper-case letters, digits, dashes), so it is safe to show. */
function referenceConflict(reference: string): ConflictError {
  return new ConflictError(
    `A case with reference ${reference} already exists in this workspace with different content. Change the case reference in the payload, or delete the existing case first.`,
    { reason: 'reference_in_use' },
  );
}

const previewPart = (preview: IngestionPreview): IngestResult['preview'] => ({
  redaction: preview.redaction,
  injection: preview.injection,
  issues: preview.issues,
});

async function replayResult(
  ctx: RequestContext,
  existing: Case,
  preview: IngestionPreview,
): Promise<IngestResult> {
  return {
    case: await summarizeCase(ctx, existing),
    sourceId: existing.sourceId,
    eventCount: existing.eventCount,
    created: false,
    preview: previewPart(preview),
    analysisJob: null,
  };
}

/** The single transaction of an ingest: duplicate checks, the case and its audit record. */
async function commit(
  ctx: RequestContext,
  tx: TenantRepositories,
  input: IngestCaseInput,
  accepted: AcceptedPayload,
): Promise<{ case: Case; created: boolean }> {
  const { prepared, preview } = accepted;
  const identical = await tx.cases.findByContentHash(prepared.contentHash);
  if (identical !== null) return { case: identical, created: false };
  if (await referenceInUse(tx, input.case.reference)) {
    throw referenceConflict(input.case.reference);
  }
  const stored = await tx.cases.ingest(input);
  if (stored.created) {
    await ctx.audit(
      {
        action: 'case.ingested',
        targetType: 'case',
        targetId: input.case.id,
        caseId: input.case.id,
        outcome: 'success',
        // Ids, counters and enums only: never any text of the payload.
        details: {
          reference: input.case.reference,
          eventCount: input.case.eventCount,
          participantCount: input.participants.length,
          sourceKind: input.case.sourceKind,
          synthetic: input.case.synthetic,
          contentHash: prepared.contentHash,
          redactionReplacements: input.case.redactionReplacements,
          injectionHighestSeverity: preview.injection.highestSeverity,
        },
      },
      tx,
    );
  }
  return stored;
}

/** Removes an object no case refers to; a failure is logged (the key holds ids only). */
async function discard(ctx: RequestContext, store: ObjectStore, key: string): Promise<void> {
  try {
    await store.delete(key);
  } catch (error) {
    ctx.logger.error(
      { event: 'ingest.orphaned_object', key, err: error },
      'could not remove a stored payload that no case refers to',
    );
  }
}

/**
 * The case exists whatever happens to the analysis: a failure to start it (the port answering 5xx or
 * 501, a budget refusal) is logged without any payload and the UI offers to start it manually.
 */
async function startAnalysis(ctx: RequestContext, caseId: string): Promise<Job | null> {
  try {
    return (await ctx.services.analysis.startAnalysis(ctx, caseId)).job;
  } catch (error) {
    const known = error instanceof AppError;
    const fields = {
      event: 'ingest.analysis_not_started',
      caseId,
      code: known ? error.code : 'unexpected',
      status: known ? error.status : 500,
    };
    const message = 'the case was ingested but its analysis could not be started';
    if (known) ctx.logger.warn(fields, message);
    else ctx.logger.error({ ...fields, err: error }, message);
    return null;
  }
}

/**
 * Stores an accepted payload as an immutable case. An identical payload (same content hash) returns
 * the existing case with `created: false`; a different payload under a used reference is a 409. The
 * redacted payload is written to the object store before the transaction commits and deleted again
 * when the transaction fails or turns out to be a repeat, so no object is left without a case. The
 * analysis is started afterwards (unless switched off) and never decides whether the ingest worked.
 */
export async function persistCase(
  ctx: RequestContext,
  accepted: AcceptedPayload,
  options: PersistOptions,
): Promise<IngestResult> {
  const { prepared, preview } = accepted;
  const existing = await ctx.repos.cases.findByContentHash(prepared.contentHash);
  if (existing !== null) return replayResult(ctx, existing, preview);

  const { tenantId } = ctx.scope;
  const caseId = ctx.newId('case');
  const sourceId = ctx.newId('src');
  const key = buildObjectKey({ tenantId, caseId, sourceId });
  const normalized = normalizeBundle(prepared.bundle, {
    tenantId,
    caseId,
    sourceId,
    createdBy: ctx.auth.userId,
    now: ctx.now().toISOString(),
    sourceKind: prepared.sourceKind,
    storedPayload: prepared.storedPayload,
    // The repository's idempotency index is on this column: it carries the content hash, and the
    // bytes as received (which may hold secrets) are never hashed or kept.
    receivedSha256: prepared.contentHash,
    fileName: prepared.fileName,
    mediaType: 'application/json',
    storageRef: key,
    redactionReplacements: preview.redaction.totalReplacements,
    redactionByEventId: prepared.redactionByEventId,
    injectionDetected: preview.injection.detected,
  });
  const input: IngestCaseInput = {
    case: normalized.case,
    source: normalized.source,
    participants: normalized.participants,
    events: normalized.events,
    resolution: normalized.resolution,
    storedPayload: prepared.storedPayload,
  };

  const store = scopeObjectStoreToTenant(ctx.services.objects, tenantId);
  await store.put(key, Buffer.from(prepared.storedPayload, 'utf8'), {
    contentType: 'application/json',
    metadata: { source_kind: prepared.sourceKind, synthetic: String(normalized.case.synthetic) },
  });

  let stored: { case: Case; created: boolean };
  try {
    stored = await ctx.repos.transaction((tx) => commit(ctx, tx, input, accepted));
  } catch (error) {
    await discard(ctx, store, key);
    if (error instanceof ConflictError && error.details?.reason === 'duplicate') {
      throw referenceConflict(input.case.reference);
    }
    throw error;
  }
  if (!stored.created) {
    await discard(ctx, store, key);
    return replayResult(ctx, stored.case, preview);
  }

  ctx.logger.info(
    {
      event: 'case.ingested',
      caseId,
      eventCount: stored.case.eventCount,
      sourceKind: stored.case.sourceKind,
      redactionReplacements: stored.case.redactionReplacements,
      injectionDetected: stored.case.injectionDetected,
    },
    'case ingested',
  );
  if (preview.injection.detected) ctx.metrics.recordInjectionFlag('ingestion');

  const job = options.analyze ? await startAnalysis(ctx, caseId) : null;
  // Starting the analysis moves the case out of "not analyzed"; report the state as it is now.
  const current = job === null ? stored.case : ((await ctx.repos.cases.get(caseId)) ?? stored.case);
  return {
    case: await summarizeCase(ctx, current),
    sourceId,
    eventCount: current.eventCount,
    created: true,
    preview: previewPart(preview),
    analysisJob: job,
  };
}
