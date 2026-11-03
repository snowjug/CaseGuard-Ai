import type { AnyProposal, Critique } from '@caseguard/schemas';
import { precedes } from '../../validators/temporal';
import type { RuleContext } from '../context';
import { wordShingles } from '../../util/text';
import { collectEventRefs, collectProposalTexts, sanitisePath } from '../text';
import type { ProposalIssue } from '../types';

const SHINGLE_SIZE = 6;

const future = (path: string, message: string): ProposalIssue => ({
  code: 'future_information',
  path: sanitisePath(path),
  message,
});

/**
 * The decision-bound proposals: what they say must rest on what was known at the decision, and not on anything the
 * case showed later. Their decision event is the anchor.
 */
function decisionEventOf(proposal: AnyProposal | Critique): string | null {
  if (!('type' in proposal)) return null;
  switch (proposal.type) {
    case 'missed_step':
    case 'counterfactual':
      return proposal.decisionEventId;
    case 'missing_evidence':
      return proposal.neededByEventId;
    default:
      return null;
  }
}

/**
 * Nothing a finding cites or says may come from after the moment it is about. Three things are checked: an event after
 * the temporal boundary (the events the case still held but the model was not shown); for a missed step, a
 * counterfactual or a missing-evidence claim, every cited event must be at or before its decision event, and what was
 * "available then" strictly before it; and no identifier or verbatim phrase that exists only after the boundary or in the
 * resolution may appear in what the model wrote.
 */
export function checkFutureInformation(
  proposal: AnyProposal | Critique,
  ctx: RuleContext,
): ProposalIssue[] {
  const issues: ProposalIssue[] = [];
  const refs = collectEventRefs(proposal);

  for (const ref of refs) {
    if (ctx.futureEventIds.has(ref.eventId)) {
      issues.push(
        future(ref.path, 'The proposal cites an event from after the temporal boundary.'),
      );
    }
  }

  const decisionId = decisionEventOf(proposal);
  const decision = decisionId === null ? undefined : ctx.events.get(decisionId);
  if (decision) {
    for (const ref of refs) {
      const event = ctx.events.get(ref.eventId);
      if (!event || ref.role === 'anchor') continue;
      const strict = ref.role === 'available';
      if (!precedes(event, decision, !strict)) {
        issues.push(
          future(
            ref.path,
            'The proposal cites an event that was not yet known at the decision it is about.',
          ),
        );
      }
    }
  }

  const guard = ctx.leakGuard;
  if (guard) {
    const { own } = collectProposalTexts(proposal);
    const haystack = own
      .map((t) => t.text)
      .join('\n')
      .toLowerCase();
    if ([...guard.futureTokens].some((token) => haystack.includes(token))) {
      issues.push(
        future(
          '$',
          'The proposal uses an identifier that first appears after the boundary or only in the resolution.',
        ),
      );
    }
    const copied = own.find((t) =>
      [...wordShingles(t.text, SHINGLE_SIZE)].some((s) => guard.futureShingles.has(s)),
    );
    if (copied) {
      issues.push(
        future(
          copied.path,
          'The proposal repeats wording that appears only after the boundary or in the resolution.',
        ),
      );
    }
  }
  return issues.slice(0, 10);
}
