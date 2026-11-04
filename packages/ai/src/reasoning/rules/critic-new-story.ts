import type { Critique } from '@caseguard/schemas';
import type { RuleContext } from '../context';
import type { ProposalIssue } from '../types';

const NEW_STORY = (path: string, message: string): ProposalIssue => ({
  code: 'critic_new_story',
  path,
  message,
});

/**
 * The critic checks other people's conclusions; it does not write a case story of its own. A critique therefore has a
 * target and cites events, and an alternative explanation may only name a hypothesis of the knowledge pack: not a
 * cause the critic made up, and not nothing.
 */
export function checkCriticNewStory(critique: Critique, ctx: RuleContext): ProposalIssue[] {
  const issues: ProposalIssue[] = [];
  if (critique.targetId === null) {
    issues.push(
      NEW_STORY(
        'targetId',
        'The critique has no target: it is not about any conclusion under review.',
      ),
    );
  }
  if (critique.evidence.length === 0) {
    issues.push(NEW_STORY('evidence', 'The critique cites no event.'));
  }
  if (
    critique.kind === 'alternative_explanation' &&
    (critique.alternativeHypothesisId === null ||
      !ctx.vocabulary.hypotheses.has(critique.alternativeHypothesisId))
  ) {
    issues.push(
      NEW_STORY(
        'alternativeHypothesisId',
        'An alternative explanation has to name a hypothesis of the knowledge pack.',
      ),
    );
  }
  return issues;
}
