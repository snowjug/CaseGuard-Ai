import type { RuleContext } from '../context';
import { collectEventRefs, sanitisePath } from '../text';
import type { ProposalIssue } from '../types';

/**
 * Every event the proposal names must be one the model was shown. An event after the temporal boundary is reported by
 * `future_information` instead; an id that is nothing at all is unknown.
 */
export function checkUnknownEvent(proposal: unknown, ctx: RuleContext): ProposalIssue[] {
  return collectEventRefs(proposal)
    .filter((ref) => !ctx.events.has(ref.eventId) && !ctx.futureEventIds.has(ref.eventId))
    .slice(0, 10)
    .map((ref) => ({
      code: 'unknown_event' as const,
      path: sanitisePath(ref.path),
      message: 'The proposal cites an event that was not shown to the model.',
    }));
}
