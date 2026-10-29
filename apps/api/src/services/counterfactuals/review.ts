import type {
  CounterfactualScenario,
  ReviewCounterfactualBody,
  ReviewDecision,
} from '@caseguard/schemas';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationFailedError,
  VersionConflictError,
} from '../../errors';
import { auditRoleOf, type RequestContext } from '../../http/request-context';

/**
 * Why a scenario cannot be accepted as the basis of a skill. The engine's own verdict stands: a
 * scenario it rejected (failed validity or leak checks) can be rejected by a reviewer, never accepted.
 */
export function acceptanceBlockers(scenario: CounterfactualScenario): string[] {
  const blockers: string[] = [];
  if (scenario.status !== 'completed') {
    blockers.push(`The engine marked the scenario ${scenario.status}.`);
  }
  const failed = scenario.validity.checks.filter((check) => !check.passed).map((check) => check.id);
  if (!scenario.validity.valid || failed.length > 0) {
    blockers.push(
      `It failed validity checks${failed.length > 0 ? ` (${failed.join(', ')})` : ''}.`,
    );
  }
  const leak = scenario.boundary.leakCheck;
  if (!leak.passed || leak.futureReferencesFound > 0 || !leak.resolutionExcluded) {
    blockers.push('It did not pass the temporal leak check.');
  }
  return blockers;
}

/**
 * Accepts or rejects a scenario. The decision, its `ReviewDecision` record and the audit event commit
 * in one transaction, with optimistic locking on the scenario version. The reviewer's reason is
 * stored on the review record only: it never reaches the audit details or the logs. Accepted
 * scenarios (`confirmed`) are what skill extraction may use.
 */
export async function reviewScenario(
  ctx: RequestContext,
  caseId: string,
  scenarioId: string,
  input: ReviewCounterfactualBody,
): Promise<CounterfactualScenario> {
  const role = auditRoleOf(ctx.auth, 'counterfactual:review');
  if (role === 'anonymous') throw new ForbiddenError();
  const reason = input.reason.trim();
  if (reason.length < 5) {
    throw new ValidationFailedError('A reason of at least five characters is required', [
      { path: 'reason', message: 'Explain the decision in at least five characters' },
    ]);
  }
  const accept = input.decision === 'accept';
  const now = ctx.now().toISOString();

  return ctx.repos.transaction(async (tx) => {
    const before = await tx.counterfactuals.get(caseId, scenarioId);
    if (before === null) throw new NotFoundError('Counterfactual scenario', scenarioId);
    if (before.version !== input.expectedVersion) {
      throw new VersionConflictError(
        'Counterfactual scenario',
        input.expectedVersion,
        before.version,
      );
    }
    if (accept) {
      const blockers = acceptanceBlockers(before);
      if (blockers.length > 0) {
        throw new ConflictError(`This scenario cannot be accepted. ${blockers.join(' ')}`);
      }
    }

    const after = await tx.counterfactuals.review(caseId, scenarioId, {
      reviewState: accept ? 'confirmed' : 'rejected',
      reason,
      reviewedBy: ctx.auth.userId,
      reviewedAt: now,
      expectedVersion: input.expectedVersion,
    });

    const record: ReviewDecision = {
      tenantId: ctx.scope.tenantId,
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.auth.userId,
      version: 1,
      id: ctx.newId('rev'),
      caseId,
      targetType: 'counterfactual',
      targetId: scenarioId,
      decision: accept ? 'confirm' : 'reject',
      originalValue: {
        reviewState: before.reviewState,
        status: before.status,
        strategy: before.strategy,
      },
      newValue: { reviewState: after.reviewState },
      reason,
      reviewerId: ctx.auth.userId,
      reviewerRole: role,
      decidedAt: now,
    };
    await tx.reviews.record(record);

    await ctx.audit(
      {
        action: 'counterfactual.reviewed',
        targetType: 'counterfactual',
        targetId: scenarioId,
        caseId,
        outcome: 'success',
        details: {
          decision: input.decision,
          forkId: before.forkId,
          strategy: before.strategy,
          fromState: before.reviewState,
          toState: after.reviewState,
          scenarioVersion: after.version,
          reasonRecorded: true,
        },
      },
      tx,
    );
    return after;
  });
}
