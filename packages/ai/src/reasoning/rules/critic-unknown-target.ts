import type { Critique } from '@caseguard/schemas';
import type { RuleContext } from '../context';
import type { ProposalIssue } from '../types';

/**
 * A critique may only be about a conclusion that was under review. An id the critic was never given is a conclusion
 * it made up. (A critique with no target at all is `critic_new_story`.)
 */
export function checkCriticUnknownTarget(critique: Critique, ctx: RuleContext): ProposalIssue[] {
  if (critique.targetId === null || ctx.conclusionIds.has(critique.targetId)) return [];
  return [
    {
      code: 'critic_unknown_target',
      path: 'targetId',
      message: 'The critique targets a conclusion that was not under review.',
    },
  ];
}
