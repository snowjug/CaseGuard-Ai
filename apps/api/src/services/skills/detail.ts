import { buildSkillDetail, transitionRule, type SkillActor } from '@caseguard/domain';
import type { SkillDetail, SkillDna } from '@caseguard/schemas';
import type { RequestContext } from '../../http/request-context';
import { actorOf } from './actor';
import { SELF_APPROVAL_MESSAGE, loadAggregate } from './aggregate';
import { skillErrorToAppError } from './errors';

/** The most cases listed in a skill's match summary. */
export const MAX_DETAIL_MATCHES = 50;

/**
 * The transitions offered to the creator of the skill: the data tier records no approval from the
 * requester, so every step that would record an approval is shown as unavailable with the reason.
 */
export function withSelfApprovalGuard(
  detail: SkillDetail,
  skill: SkillDna,
  actor: SkillActor,
): SkillDetail {
  if (actor.id !== skill.createdBy) return detail;
  return {
    ...detail,
    transitions: detail.transitions.map((option) => {
      const rule = transitionRule(skill.lifecycle, option.toState);
      if (!option.allowed || rule === null || rule.decision !== 'approved') return option;
      return { ...option, allowed: false, reason: SELF_APPROVAL_MESSAGE };
    }),
  };
}

/** `skills.get`: the skill, its versions and history, and the transitions available to this caller. */
export async function loadSkillDetail(ctx: RequestContext, skillId: string): Promise<SkillDetail> {
  const aggregate = await loadAggregate(ctx.repos, skillId);
  const actor = actorOf(ctx);

  const stored = await ctx.repos.skills.listMatchesForSkill(skillId);
  const references = new Map<string, string>();
  const matches: SkillDetail['matches'] = [];
  for (const match of stored.slice(0, MAX_DETAIL_MATCHES)) {
    let reference = references.get(match.caseId);
    if (reference === undefined) {
      reference = (await ctx.repos.cases.get(match.caseId))?.reference ?? match.caseId;
      references.set(match.caseId, reference);
    }
    matches.push({
      caseId: match.caseId,
      caseReference: reference,
      score: match.score,
      applicability: match.applicability,
      applied: match.applied,
    });
  }

  const built = buildSkillDetail({ aggregate, actor, matches });
  if (!built.ok) throw skillErrorToAppError(built.error);
  return withSelfApprovalGuard(built.value, aggregate.skill, actor);
}
