import type { Permission, ReviewDecision } from '@caseguard/schemas';
import type { TenantRepositories } from '../../db';
import { ForbiddenError, ValidationFailedError } from '../../errors';
import { auditRoleOf, type RequestContext } from '../../http/request-context';

const MIN_REASON_LENGTH = 5;

/**
 * The reason a reviewer gives for a decision. The schema only counts characters, so a reason made of
 * blanks is refused here. The trimmed text goes to the review record, never to audit details or logs.
 */
export function requireReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length < MIN_REASON_LENGTH) {
    throw new ValidationFailedError('A reason is required', [
      {
        path: 'body.reason',
        message: `Explain the decision in at least ${MIN_REASON_LENGTH} characters`,
      },
    ]);
  }
  return trimmed;
}

export interface ReviewInput {
  readonly caseId: string;
  readonly targetType: ReviewDecision['targetType'];
  readonly targetId: string;
  readonly decision: ReviewDecision['decision'];
  /** The machine (or previous) value, preserved next to the new one. */
  readonly originalValue: unknown;
  readonly newValue: unknown;
  readonly reason: string;
  /** The permission the route required: it picks which of the caller's roles is recorded. */
  readonly permission: Permission;
}

/** Records one reviewer decision inside the caller's transaction (`tx` is the transaction's repositories). */
export async function recordReview(
  ctx: RequestContext,
  tx: TenantRepositories,
  input: ReviewInput,
): Promise<ReviewDecision> {
  const role = auditRoleOf(ctx.auth, input.permission);
  if (role === 'anonymous') throw new ForbiddenError();
  const at = ctx.now().toISOString();
  const decision: ReviewDecision = {
    tenantId: ctx.scope.tenantId,
    createdAt: at,
    updatedAt: at,
    createdBy: ctx.auth.userId,
    version: 1,
    id: ctx.newId('rev'),
    caseId: input.caseId,
    targetType: input.targetType,
    targetId: input.targetId,
    decision: input.decision,
    originalValue: input.originalValue,
    newValue: input.newValue,
    reason: input.reason,
    reviewerId: ctx.auth.userId,
    reviewerRole: role,
    decidedAt: at,
  };
  await tx.reviews.record(decision);
  return decision;
}
