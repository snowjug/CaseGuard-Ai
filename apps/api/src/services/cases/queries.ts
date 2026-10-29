import type { CaseDetail, CaseSummary, Page } from '@caseguard/schemas';
import { DataIntegrityError, type CaseListQuery } from '../../db';
import { NotFoundError } from '../../errors';
import type { RequestContext } from '../../http/request-context';
import { summarizeCases } from './summaries';

/** One page of cases (newest first by opening time), with the figures of their latest analysis. */
export async function listCases(
  ctx: RequestContext,
  query: CaseListQuery,
): Promise<Page<CaseSummary>> {
  const page = await ctx.repos.cases.list(query);
  return { items: await summarizeCases(ctx, page.items), nextCursor: page.nextCursor };
}

/**
 * The case record with its participants, the immutable source record (without the stored location)
 * and the resolution. Another tenant's case is indistinguishable from a missing one: both are 404.
 */
export async function getCaseDetail(ctx: RequestContext, caseId: string): Promise<CaseDetail> {
  const record = await ctx.repos.cases.get(caseId);
  if (record === null) throw new NotFoundError('Case', caseId);
  const [participants, source, resolution] = await Promise.all([
    ctx.repos.cases.getParticipants(caseId),
    ctx.repos.cases.getSource(caseId),
    ctx.repos.cases.getResolution(caseId),
  ]);
  // Ingestion writes the source together with the case, so a case without one is corrupt data.
  if (source === null) throw new DataIntegrityError('case source');
  return {
    ...record,
    participants,
    source: {
      id: source.id,
      kind: source.kind,
      fileName: source.fileName,
      mediaType: source.mediaType,
      sizeBytes: source.sizeBytes,
      receivedSha256: source.receivedSha256,
      storedSha256: source.storedSha256,
      redactionApplied: source.redactionApplied,
      redactionReplacements: source.redactionReplacements,
      synthetic: source.synthetic,
    },
    resolution,
  };
}
