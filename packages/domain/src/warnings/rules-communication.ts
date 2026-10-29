import { isCustomerSide } from '../engine/context';
import {
  awaitsReply,
  isCustomerChase,
  isCustomerFacingEngineerEvent,
} from '../quality/conversation';
import { plural } from '../quality/links';
import { formatDuration, minutesBetween } from '../util/time';
import { candidate, eventLinks, isAfter, isoAt, latestEvent, stampOf } from './helpers';
import { classStep } from './suggest';
import type { Checkpoint, WarningCandidate } from './types';

export const COM_WAITING = 'LQ-COM-01';
export const COM_EXPECTATION = 'LQ-COM-02';

interface Waiting {
  /** The earliest customer message after the last engineer-facing reply that expects an answer. */
  index: number;
  chasers: number[];
}

function waitingState(cp: Checkpoint): Waiting | null {
  if (cp.closureIndex >= 0) return null;
  let lastReply = -1;
  cp.events.forEach((e, i) => {
    if (isCustomerFacingEngineerEvent(e)) lastReply = i;
  });
  const firstCustomer = cp.events.findIndex((e) => isCustomerSide(e.participantRole));
  for (let i = lastReply + 1; i < cp.events.length; i++) {
    const event = cp.events[i];
    if (!event || !awaitsReply(event, i === firstCustomer)) continue;
    const chasers: number[] = [];
    for (let j = lastReply + 1; j < cp.events.length; j++) {
      const later = cp.events[j];
      if (later && isCustomerChase(later, j === firstCustomer)) chasers.push(j);
    }
    return { index: i, chasers };
  }
  return null;
}

/** A customer message that expects an answer has had no engineer-facing reply for too long. */
function customerWaiting(cp: Checkpoint): WarningCandidate[] {
  const waiting = waitingState(cp);
  const event = waiting ? cp.events[waiting.index] : undefined;
  if (!waiting || !event) return [];
  const { replyWaitHours, replyWaitCriticalHours } = cp.options;
  const hours = minutesBetween(event.timestamp, cp.now) / 60;
  const critical = hours >= replyWaitCriticalHours;
  if (!critical && hours < replyWaitHours) return [];
  const threshold = critical ? replyWaitCriticalHours : replyWaitHours;
  const raisedMs = Date.parse(event.timestamp) + threshold * 3_600_000;
  const chaserIds = waiting.chasers.map((i) => cp.events[i]?.id ?? '').filter((id) => id !== '');
  return [
    candidate({
      ruleId: COM_WAITING,
      subject: `${event.id}:${threshold}h`,
      category: 'communication',
      priority: critical ? 'high' : 'medium',
      title: critical
        ? 'The customer has been waiting more than a day for news'
        : 'The customer is waiting for a reply',
      message: `The customer's message from ${stampOf(event.timestamp)} expects an answer and has had no reply for ${formatDuration(hours * 60)}.${chaserIds.length > 0 ? ` The customer has asked for news ${plural(chaserIds.length, 'time')}.` : ''} They have not been told what will happen next.`,
      step: classStep(cp, 'communication'),
      lead: 'Send an update now, even if the diagnosis is not complete: ',
      fallback: 'Send the customer a status update with next steps and timing.',
      evidence: eventLinks(cp, [event.id, ...chaserIds]),
      raisedAt: isoAt(raisedMs),
      kind: 'state',
      supersedes: critical ? [`${COM_WAITING}|${event.id}:${replyWaitHours}h`] : [],
    }),
  ];
}

/** Instants (after `now`) at which a waiting customer crosses a threshold. */
export function waitingDeadlines(cp: Checkpoint): string[] {
  const waiting = waitingState(cp);
  const event = waiting ? cp.events[waiting.index] : undefined;
  if (!event) return [];
  return [cp.options.replyWaitHours, cp.options.replyWaitCriticalHours]
    .map((h) => isoAt(Date.parse(event.timestamp) + h * 3_600_000))
    .filter((t) => isAfter(t, cp.now));
}

/** A heavy request to the customer that does not say what happens next or when they will hear back. */
function noExpectationSet(cp: Checkpoint): WarningCandidate[] {
  const event = latestEvent(cp);
  const action = event ? cp.actionByEvent.get(event.id) : undefined;
  if (!event || !action || event.type !== 'engineer_email') return [];
  if (!isCustomerFacingEngineerEvent(event)) return [];
  if (cp.config.effortScale[action.customerEffort] < cp.options.heavyEffortScore) return [];
  if (cp.pack.lexicon.expectation.some((re) => re.test(event.body))) return [];
  return [
    candidate({
      ruleId: COM_EXPECTATION,
      subject: event.id,
      category: 'communication',
      priority: 'low',
      title: 'A heavy request without an expectation of what happens next',
      message: `The message at ${stampOf(event.timestamp)} asks the customer for substantial effort (${action.customerEffort.replace('_', ' ')}) but does not say what will be done with it or when they will hear back.`,
      step: classStep(cp, 'communication'),
      lead: 'Add what you will do with the result and when you will update the customer: ',
      fallback: 'Say what you will do with the result and when the customer will hear back.',
      evidence: eventLinks(cp, [event.id]),
      raisedAt: event.timestamp,
      kind: 'nudge',
      triggerIndex: cp.index,
    }),
  ];
}

export const communicationRules = [customerWaiting, noExpectationSet] as const;
