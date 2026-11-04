import type { RuleContext } from '../context';
import { isInShownText } from '../locate';
import { collectCitations, normaliseExcerpt, sanitisePath } from '../text';
import type { ProposalIssue } from '../types';

export type CitationVerdict = 'ok' | 'not_found' | 'wrong_event' | 'skipped';

export interface CheckedCitation {
  path: string;
  verdict: CitationVerdict;
}

/**
 * What became of each quotation of a proposal. A quotation is verbatim when, after Unicode NFC and whitespace-run
 * collapsing on both sides and nothing else, it is a substring of the title or the body of the cited event as the model
 * was shown it. A quotation that is not, but is in another event the model was shown, is a quotation of the wrong
 * event. A citation of an event the model was not shown is left to `unknown_event` and `future_information`.
 */
export function classifyCitations(proposal: unknown, ctx: RuleContext): CheckedCitation[] {
  return collectCitations(proposal).map((citation) => {
    const event = ctx.events.get(citation.eventId);
    if (!event) return { path: citation.path, verdict: 'skipped' };
    const needle = normaliseExcerpt(citation.excerpt);
    if (needle.length >= 3 && isInShownText(event, needle))
      return { path: citation.path, verdict: 'ok' };
    const elsewhere =
      needle.length >= 3 &&
      [...ctx.events.values()].some(
        (other) => other.id !== event.id && isInShownText(other, needle),
      );
    return { path: citation.path, verdict: elsewhere ? 'wrong_event' : 'not_found' };
  });
}

const issuesFor = (
  proposal: unknown,
  ctx: RuleContext,
  verdict: CitationVerdict,
  issue: Pick<ProposalIssue, 'code' | 'message'>,
): ProposalIssue[] =>
  classifyCitations(proposal, ctx)
    .filter((c) => c.verdict === verdict)
    .slice(0, 10)
    .map((c) => ({ ...issue, path: sanitisePath(`${c.path}.excerpt`) }));

/** The quotation is not in the cited event as the model saw it (nor in any other event it saw). */
export function checkExcerptNotFound(proposal: unknown, ctx: RuleContext): ProposalIssue[] {
  return issuesFor(proposal, ctx, 'not_found', {
    code: 'excerpt_not_found',
    message: 'The quotation is not a verbatim part of the cited event as the model saw it.',
  });
}

/** The quotation is real, but it comes from another event than the one cited. */
export function checkExcerptWrongEvent(proposal: unknown, ctx: RuleContext): ProposalIssue[] {
  return issuesFor(proposal, ctx, 'wrong_event', {
    code: 'excerpt_wrong_event',
    message: 'The quotation is in another event than the one it is cited for.',
  });
}
