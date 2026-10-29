import type { SkillDetail } from '@caseguard/schemas';
import { describeSkillTransitions } from './lifecycle';
import {
  currentVersionOf,
  skillFail,
  skillOk,
  type SkillActor,
  type SkillAggregate,
  type SkillResult,
} from './types';

/**
 * Assembles the `skills.get` response: the current and any proposed version, history, validations,
 * approvals and, for this actor, every legal next state with the reason it is or is not available.
 */
export function buildSkillDetail(args: {
  aggregate: SkillAggregate;
  actor: SkillActor;
  matches?: SkillDetail['matches'];
}): SkillResult<SkillDetail> {
  const { aggregate, actor } = args;
  const current = currentVersionOf(aggregate);
  if (!current) {
    return skillFail('not_found', `Skill ${aggregate.skill.id} has no current version.`);
  }
  const bySequence = [...aggregate.versions].sort((a, b) => a.sequence - b.sequence);
  const proposed = [...bySequence].reverse().find((v) => v.state === 'proposed') ?? null;
  const byTime = <T extends { createdAt: string }>(items: readonly T[]): T[] =>
    [...items].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  return skillOk({
    skill: aggregate.skill,
    currentVersion: current,
    proposedVersion: proposed,
    versions: bySequence.map(({ content: _content, ...rest }) => rest),
    validations: byTime(aggregate.validations),
    approvals: byTime(aggregate.approvals),
    matches: args.matches ?? [],
    transitions: describeSkillTransitions(aggregate, actor),
    notices: [
      'An AI-generated skill is never published automatically: every lifecycle step needs a person with the right permission, and publication needs a different person from the creator and the approver.',
      'Confidence, branch probabilities and effectiveness are model estimates, not measurements.',
      ...(aggregate.skill.synthetic
        ? [
            'This skill was derived from synthetic demonstration data and demonstrates the pipeline only.',
          ]
        : []),
    ],
  });
}
