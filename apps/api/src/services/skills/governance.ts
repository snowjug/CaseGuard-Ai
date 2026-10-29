import {
  decideSkillVersion,
  rollbackSkill,
  transitionSkill,
  type SkillActor,
  type SkillAggregate,
  type SkillChangeSet,
  type SkillOpContext,
  type SkillResult,
} from '@caseguard/domain';
import type {
  SkillRollbackBody,
  SkillTransitionBody,
  SkillVersionDecisionBody,
} from '@caseguard/schemas';
import type { RequestContext } from '../../http/request-context';
import { actorOf, opOf } from './actor';
import { guardSelfApproval, loadAggregate, persistChangeSet } from './aggregate';
import { writeSkillAudits } from './audit';
import { skillErrorToAppError } from './errors';

interface ChangeInput {
  readonly aggregate: SkillAggregate;
  readonly actor: SkillActor;
  readonly op: SkillOpContext;
}

/**
 * Runs one governed change in ONE transaction: it loads the skill, asks the domain to decide, and then
 * either persists the change set together with its audit events, or records the refusal's own audit
 * event (outcome `denied` or `failure`) and commits just that. A refusal is thrown only after the
 * commit, so a blocked attempt is never lost, with the status the domain documents (`SKILL_ERROR_HTTP`).
 */
export async function runSkillChange(
  ctx: RequestContext,
  skillId: string,
  metricLabel: string,
  decide: (input: ChangeInput) => SkillResult<SkillChangeSet>,
): Promise<void> {
  const actor = actorOf(ctx);
  const op = opOf(ctx);
  const outcome = await ctx.repos.transaction(async (tx) => {
    const aggregate = await loadAggregate(tx, skillId);
    const result = decide({ aggregate, actor, op });
    if (!result.ok) {
      await writeSkillAudits(ctx, tx, [result.error.audit]);
      return result;
    }
    await persistChangeSet(tx, result.value);
    await writeSkillAudits(ctx, tx, result.value.audit);
    return result;
  });
  ctx.metrics.recordSkillTransition(
    metricLabel,
    outcome.ok ? 'success' : (outcome.error.audit?.outcome ?? 'failure'),
  );
  if (!outcome.ok) throw skillErrorToAppError(outcome.error);
}

/** `skills.transition`: permission, separation of duties, validations and the optimistic lock are the domain's. */
export function transitionSkillStep(
  ctx: RequestContext,
  skillId: string,
  request: SkillTransitionBody,
): Promise<void> {
  return runSkillChange(ctx, skillId, `transition:${request.toState}`, ({ aggregate, actor, op }) =>
    guardSelfApproval(transitionSkill({ aggregate, request, actor, op }), {
      actor,
      op,
      fromState: aggregate.skill.lifecycle,
    }),
  );
}

/** `skills.versionDecision`: approving needs a distinct approver, a fresh parent and validated content. */
export function decideVersionStep(
  ctx: RequestContext,
  skillId: string,
  versionId: string,
  request: SkillVersionDecisionBody,
): Promise<void> {
  return runSkillChange(ctx, skillId, 'version_decision', ({ aggregate, actor, op }) =>
    decideSkillVersion({ aggregate, versionId, request, actor, op }),
  );
}

/** `skills.rollback`: creates a NEW version with an earlier version's content; history is never rewritten. */
export function rollbackStep(
  ctx: RequestContext,
  skillId: string,
  request: SkillRollbackBody,
): Promise<void> {
  return runSkillChange(ctx, skillId, 'rollback', ({ aggregate, actor, op }) =>
    rollbackSkill({ aggregate, request, actor, op }),
  );
}
