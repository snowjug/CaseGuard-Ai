import type { AnyProposal, Critique } from '@caseguard/schemas';
import {
  findViolations,
  PEOPLE_RULES,
  UNSAFE_RECOMMENDATION_RULES,
} from '../../validators/unsafe-patterns';
import type { RuleContext } from '../context';
import { collectProposalTexts, sanitisePath } from '../text';
import type { ProposalIssue, TextAt } from '../types';

const violation = (path: string, message: string): ProposalIssue => ({
  code: 'policy_violation',
  path: sanitisePath(path),
  message,
});

/** The fields that read as advice: the unsafe-wording rules apply to these and not to descriptions of what happened. */
function adviceFields(proposal: AnyProposal | Critique): TextAt[] {
  if (!('type' in proposal)) return [];
  switch (proposal.type) {
    case 'recommendation':
      return [
        { path: 'action', text: proposal.action },
        { path: 'rationale', text: proposal.rationale },
      ];
    case 'counterfactual':
      return [{ path: 'alternativeAction', text: proposal.alternativeAction }];
    case 'missed_step':
      return [{ path: 'step', text: proposal.step }];
    default:
      return [];
  }
}

/**
 * The safety policy of the pipeline, applied to one proposal (the validator's own rules, not new ones): an action
 * the proposal names must be one the engine itself would recommend (not destructive, not approval-required, below the
 * risk ceiling); advice must not recommend a destructive operation, a mass credential reset, weakening a security
 * control, granting privileges, sharing a secret, closing the case or skipping approval (a negated "do not delete the
 * logs" is fine); and no text may discipline, rank or personally judge an individual.
 */
export function checkPolicyViolation(
  proposal: AnyProposal | Critique,
  ctx: RuleContext,
): ProposalIssue[] {
  const issues: ProposalIssue[] = [];
  if ('type' in proposal && proposal.type === 'missed_step' && proposal.actionId !== null) {
    const action = ctx.policy.actions.get(proposal.actionId);
    if (action?.destructive) {
      issues.push(
        violation('actionId', 'The action named is destructive and is never recommended.'),
      );
    }
    if (action?.requiresApproval) {
      issues.push(
        violation(
          'actionId',
          'The action named requires approval and is never recommended automatically.',
        ),
      );
    }
    if (action && action.operationalRisk >= ctx.policy.riskCeiling) {
      issues.push(
        violation('actionId', 'The action named is at or above the operational risk ceiling.'),
      );
    }
  }
  for (const { path, text } of adviceFields(proposal)) {
    for (const hit of findViolations(text, UNSAFE_RECOMMENDATION_RULES, true)) {
      issues.push(violation(path, hit.message));
    }
  }
  for (const { path, text } of collectProposalTexts(proposal).own) {
    for (const hit of findViolations(text, PEOPLE_RULES, true)) {
      issues.push(violation(path, hit.message));
    }
  }
  return issues.slice(0, 5);
}
