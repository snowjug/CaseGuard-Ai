import { redactSecrets } from '../../util/redact';
import { collectProposalTexts, sanitisePath } from '../text';
import type { ProposalIssue } from '../types';

/**
 * No text of a proposal (what the model wrote or what it quoted) may hold a secret-like value: a key, a token, a
 * password assignment, a connection string. The record is masked before the model sees it, so a quotation of the record
 * has none; a model that writes one is inventing it or leaking something.
 */
export function checkSecretLikeText(proposal: unknown): ProposalIssue[] {
  const { own, quoted } = collectProposalTexts(proposal);
  return [...own, ...quoted]
    .filter((t) => redactSecrets(t.text) !== t.text)
    .slice(0, 3)
    .map((t) => ({
      code: 'secret_like_text' as const,
      path: sanitisePath(t.path),
      message: 'The proposal contains a secret-like value.',
    }));
}
