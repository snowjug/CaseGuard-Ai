import type { ReasonerProposal } from '@caseguard/schemas';
import { normaliseExcerpt } from '../text';
import type { ProposalIssue } from '../types';

const norm = (text: string): string => normaliseExcerpt(text).toLowerCase();

/**
 * What a proposal is about, as a key: two proposals with the same key say the same thing. (Free text is normalised:
 * case, spacing and Unicode form do not make a different proposal.)
 */
export function signatureOf(proposal: ReasonerProposal): string {
  switch (proposal.type) {
    case 'signal':
      return `signal|${proposal.signalId}|${proposal.eventId}`;
    case 'contradiction':
      return `contradiction|${proposal.conflictClass}|${proposal.sides
        .map((s) => s.eventId)
        .sort()
        .join(',')}`;
    case 'missing_evidence':
      return `missing_evidence|${proposal.requirementId ?? norm(proposal.missing)}|${proposal.neededByEventId}`;
    case 'missed_step':
      return `missed_step|${proposal.actionId ?? norm(proposal.step)}|${proposal.decisionEventId}`;
    case 'counterfactual':
      return `counterfactual|${proposal.decisionEventId}|${norm(proposal.alternativeAction)}`;
    case 'recommendation':
      return `recommendation|${norm(proposal.action)}`;
    case 'case_synthesis':
      return 'case_synthesis';
  }
}

/**
 * A proposal that repeats an earlier one of the same reply is dropped, the earlier one kept. "Repeats" means the same
 * model-local id, the same subject (see `signatureOf`) or the same statement. Pass the proposals that survived every
 * other rule, in the order of the reply: a proposal dropped for another reason must not make a later one a duplicate.
 * Returns the issues per index (an empty list for a proposal that is not a duplicate).
 */
export function checkDuplicates(proposals: readonly ReasonerProposal[]): ProposalIssue[][] {
  const ids = new Set<string>();
  const signatures = new Set<string>();
  const statements = new Set<string>();
  return proposals.map((proposal, index) => {
    const signature = signatureOf(proposal);
    const statement = `${proposal.type}|${norm(proposal.statement)}`;
    const repeated = ids.has(proposal.id) || signatures.has(signature) || statements.has(statement);
    ids.add(proposal.id);
    signatures.add(signature);
    statements.add(statement);
    return repeated
      ? [
          {
            code: 'duplicate' as const,
            path: `[${index}]`,
            message: 'The proposal repeats an earlier proposal of the same reply.',
          },
        ]
      : [];
  });
}
