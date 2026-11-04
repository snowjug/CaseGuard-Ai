import type { AnyProposal } from '@caseguard/schemas';
import { collectProposalTexts } from '../text';
import type { ProposalIssue } from '../types';

/** A basis that is not the record itself: nothing in the record states it, so it cannot support certainty. */
const UNSTATED_BASES: ReadonlySet<string> = new Set([
  'inferred_from_sequence',
  'inferred_from_absence',
  'general_knowledge',
]);

/** Words that claim a certainty no inference has. Quotations of the record are not read: the record may say them. */
const ABSOLUTE_WORDS = new RegExp(
  String.raw`\b(?:definitely|certainly|undoubtedly|unquestionably|conclusively|absolutely|guaranteed?|guarantees|proves?|proven|proof\s+that|beyond\s+(?:any\s+)?doubt|without\s+(?:a\s+|any\s+)?doubt|no\s+doubt|for\s+certain|for\s+sure|one\s+hundred\s+percent)\b|\b100\s?%`,
  'i',
);

/**
 * Certainty has to be earned by the record. High confidence is refused when the model says it rests on an inference
 * (from the order of events, from something missing) or on general knowledge; so are absolute words ("definitely",
 * "proves", "guaranteed", "100%") in what the model wrote on such a basis.
 */
export function checkUnsupportedCertainty(proposal: AnyProposal): ProposalIssue[] {
  if (!UNSTATED_BASES.has(proposal.confidenceBasis)) return [];
  const issues: ProposalIssue[] = [];
  if (proposal.confidence === 'high') {
    issues.push({
      code: 'unsupported_certainty',
      path: 'confidence',
      message:
        'High confidence is not allowed when the basis is an inference or general knowledge rather than the record.',
    });
  }
  const { own } = collectProposalTexts(proposal);
  const absolute = own.find((t) => ABSOLUTE_WORDS.test(t.text));
  if (absolute) {
    issues.push({
      code: 'unsupported_certainty',
      path: absolute.path,
      message:
        'Absolute wording is not allowed when the basis is an inference or general knowledge.',
    });
  }
  return issues;
}
