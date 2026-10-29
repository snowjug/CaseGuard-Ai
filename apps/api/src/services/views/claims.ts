import type { Claim } from '@caseguard/schemas';
import { NotFoundError, VersionConflictError } from '../../errors';
import type { BodyOf } from '../../http/route-binder';
import type { RequestContext } from '../../http/request-context';
import { recordReview, requireReason } from './reviews';
import { loadCaseRun } from './state';

/**
 * Corrects a claim's classification. The original machine classification is never overwritten (the
 * repository keeps `aiCategory`); the decision is recorded as a review, version-checked, and the
 * audit event commits in the same transaction. The reason goes to the review record only.
 */
export async function reviewClaim(
  ctx: RequestContext,
  caseId: string,
  claimId: string,
  body: BodyOf<'claims.review'>,
): Promise<Claim> {
  const reason = requireReason(body.reason);
  await loadCaseRun(ctx, caseId);

  return ctx.repos.transaction(async (tx) => {
    const before = await tx.analysis.getClaim(caseId, claimId);
    if (before === null) throw new NotFoundError('Claim', claimId);
    if (before.version !== body.expectedVersion) {
      throw new VersionConflictError('Claim', body.expectedVersion, before.version);
    }
    const next = await tx.analysis.reviewClaim(caseId, claimId, {
      reviewedCategory: body.category,
      reason,
      reviewedBy: ctx.auth.userId,
      reviewedAt: ctx.now().toISOString(),
      expectedVersion: body.expectedVersion,
    });
    const decision = await recordReview(ctx, tx, {
      caseId,
      targetType: 'claim',
      targetId: claimId,
      decision: next.reviewState === 'confirmed' ? 'confirm' : 'correct',
      originalValue: { category: before.category, aiCategory: before.aiCategory },
      newValue: { category: next.category },
      reason,
      permission: 'evidence:review',
    });
    await ctx.audit(
      {
        action: 'claim.reviewed',
        targetType: 'claim',
        targetId: claimId,
        caseId,
        outcome: 'success',
        details: {
          reviewId: decision.id,
          aiCategory: before.aiCategory,
          fromCategory: before.category,
          toCategory: next.category,
          reviewState: next.reviewState,
          expectedVersion: body.expectedVersion,
          version: next.version,
        },
      },
      tx,
    );
    return next;
  });
}
