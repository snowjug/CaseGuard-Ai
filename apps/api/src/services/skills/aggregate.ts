import {
  skillFail,
  type SkillActor,
  type SkillAggregate,
  type SkillChangeSet,
  type SkillOpContext,
  type SkillResult,
} from '@caseguard/domain';
import type { SkillValidation } from '@caseguard/schemas';
import type { TenantRepositories } from '../../db';
import { NotFoundError } from '../../errors';

/** What a person who requested an approval (the skill's creator) cannot do for it. */
export const SELF_APPROVAL_MESSAGE =
  'The person who created the skill cannot record an approval for it: another person must.';

/**
 * Validations in the order the domain expects (oldest first, ties broken by id), so that "the latest
 * validation of a kind" is the newest one even when two were recorded in the same instant.
 */
export function orderValidations(validations: readonly SkillValidation[]): SkillValidation[] {
  return [...validations].sort(
    (a, b) =>
      (a.executedAt < b.executedAt ? -1 : a.executedAt > b.executedAt ? 1 : 0) ||
      (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** Everything the governance functions need to know about one skill; 404 when it does not exist. */
export async function loadAggregate(
  repos: TenantRepositories,
  skillId: string,
): Promise<SkillAggregate> {
  const skill = await repos.skills.get(skillId);
  if (skill === null) throw new NotFoundError('Skill', skillId);
  const versions = await repos.skills.listVersions(skillId);
  const validations = await repos.skills.listValidations(skillId);
  const approvals = await repos.skills.listApprovals(skillId);
  return { skill, versions, validations: orderValidations(validations), approvals };
}

/**
 * Applies the writes of a domain change set inside the caller's transaction, in dependency order:
 * new versions, version states, validations and approvals (which reference versions), and last the
 * skill row, whose optimistic lock (`previousSkillVersion`) is the compare-and-swap for the whole
 * change: a concurrent change makes it throw and the transaction rolls back as one.
 */
export async function persistChangeSet(
  tx: TenantRepositories,
  change: SkillChangeSet,
): Promise<void> {
  for (const version of change.newVersions) await tx.skills.addVersion(version);
  for (const { versionId, state } of change.versionStates) {
    await tx.skills.setVersionState(change.skill.id, versionId, state);
  }
  for (const validation of change.validations) await tx.skills.addValidation(validation);
  for (const approval of change.approvals) await tx.skills.addApproval(approval);
  const {
    id: _id,
    tenantId: _tenantId,
    createdAt: _createdAt,
    version: _version,
    ...patch
  } = change.skill;
  await tx.skills.update(change.skill.id, patch, change.previousSkillVersion);
}

/**
 * The data tier requires every recorded approval to come from someone other than the requester (the
 * creator of the skill). The domain allows a creator to take the first step out of `discovered`, so
 * this refuses such a change up front as a separation-of-duties denial, which is audited like any
 * other, instead of letting the storage rule fail it. Withdrawing a skill (deprecating or retiring it)
 * is not an approval: the domain records it as a rejection, so the creator, like anyone who holds the
 * permission, may do it and nothing is refused here.
 */
export function guardSelfApproval(
  result: SkillResult<SkillChangeSet>,
  context: { actor: SkillActor; op: SkillOpContext; fromState: string },
): SkillResult<SkillChangeSet> {
  if (!result.ok) return result;
  const offending = result.value.approvals.find(
    (approval) => approval.decision === 'approved' && approval.approver === approval.requestedBy,
  );
  if (offending === undefined) return result;
  const action =
    offending.toState === 'published' ? 'skill.publish_denied' : 'skill.transition_denied';
  const details = {
    fromState: context.fromState,
    toState: offending.toState,
    code: 'separation_of_duties',
    reason: SELF_APPROVAL_MESSAGE,
  };
  return skillFail('separation_of_duties', SELF_APPROVAL_MESSAGE, details, {
    action,
    targetType: 'skill',
    targetId: offending.skillId,
    caseId: null,
    outcome: 'denied',
    actorId: context.actor.id,
    occurredAt: context.op.now,
    details,
  });
}
