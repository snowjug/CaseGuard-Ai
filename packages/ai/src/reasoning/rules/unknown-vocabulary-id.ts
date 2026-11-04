import type { AnyProposal } from '@caseguard/schemas';
import type { RuleContext } from '../context';
import type { ProposalIssue } from '../types';

const unknown = (path: string, what: string): ProposalIssue => ({
  code: 'unknown_vocabulary_id',
  path,
  message: `The proposal names a ${what} that is not in the list it was given.`,
});

/**
 * A signal, requirement, action or skill the proposal names must be in the allow-list the prompt carried. A pack id
 * can be null where the schema says so (a requirement the pack does not name); anything else is checked.
 */
export function checkUnknownVocabularyId(proposal: AnyProposal, ctx: RuleContext): ProposalIssue[] {
  const { vocabulary } = ctx;
  switch (proposal.type) {
    case 'signal':
      return vocabulary.signals.has(proposal.signalId) ? [] : [unknown('signalId', 'signal')];
    case 'missing_evidence':
      return proposal.requirementId === null || vocabulary.requirements.has(proposal.requirementId)
        ? []
        : [unknown('requirementId', 'requirement')];
    case 'missed_step':
      return proposal.actionId === null || vocabulary.actions.has(proposal.actionId)
        ? []
        : [unknown('actionId', 'action')];
    case 'counterfactual':
      return proposal.skillId === null || vocabulary.skills.has(proposal.skillId)
        ? []
        : [unknown('skillId', 'skill')];
    default:
      return [];
  }
}
