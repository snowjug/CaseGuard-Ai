import { ENGINEER_SIDE_ROLES, type CaseEvent, type ParticipantRole } from '@caseguard/schemas';
import { isCustomerSide } from '../engine/context';
import { eventText } from '../engine/signals';
import { minutesBetween } from '../util/time';

/**
 * Cues that a customer message expects an answer (a question, a request, or a complaint about
 * silence). Plain, auditable patterns: they classify the customer's own words and nothing else.
 */
const AWAITING_REPLY =
  /\?|\bplease\s+(advise|update|confirm|let us know|send|share|check|respond)\b|\bupdate us\b|\ban update\b|\bETA\b|\bnot heard\b|\bnobody has told\b|\bwaiting (for|on)\b|\bany news\b|\burgent(ly)?\b/i;

/** Customer messages that chase the engineer for news (the customer had to ask). */
const CUSTOMER_CHASE =
  /\bnot heard\b|\bnobody has told\b|\bstill waiting\b|\bwaiting for (an )?update\b|\brequest for update\b|\bplease update\b|\bupdate us\b|\bwhat is happening\b/i;

export const isEngineerSide = (role: ParticipantRole): boolean =>
  ENGINEER_SIDE_ROLES.includes(role);

/** An engineer message the customer actually receives (an email, or a call the engineer made). */
export const isCustomerFacingEngineerEvent = (event: CaseEvent): boolean =>
  isEngineerSide(event.participantRole) &&
  (event.type === 'engineer_email' || event.type === 'customer_call');

/** Whether a customer-side event expects an answer; the opening message always does. */
export function awaitsReply(event: CaseEvent, isOpeningMessage: boolean): boolean {
  if (!isCustomerSide(event.participantRole)) return false;
  return isOpeningMessage || AWAITING_REPLY.test(eventText(event));
}

export function isCustomerChase(event: CaseEvent, isOpeningMessage: boolean): boolean {
  return (
    isCustomerSide(event.participantRole) &&
    !isOpeningMessage &&
    CUSTOMER_CHASE.test(eventText(event))
  );
}

export interface ReplyWait {
  eventId: string;
  at: string;
  replyEventId: string | null;
  replyAt: string | null;
  /** Hours the customer waited; for an unanswered message, the wait so far (a lower bound). */
  hours: number;
  censored: boolean;
}

/** How long each customer message that expects an answer waited for the next engineer-facing reply. */
export function computeReplyWaits(events: readonly CaseEvent[], until: string): ReplyWait[] {
  const waits: ReplyWait[] = [];
  const firstCustomer = events.findIndex((e) => isCustomerSide(e.participantRole));
  events.forEach((event, index) => {
    if (!awaitsReply(event, index === firstCustomer)) return;
    const reply = events.slice(index + 1).find(isCustomerFacingEngineerEvent);
    const end = reply ? reply.timestamp : until;
    waits.push({
      eventId: event.id,
      at: event.timestamp,
      replyEventId: reply?.id ?? null,
      replyAt: reply?.timestamp ?? null,
      hours: Math.max(0, minutesBetween(event.timestamp, end)) / 60,
      censored: reply === undefined,
    });
  });
  return waits;
}
