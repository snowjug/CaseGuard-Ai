import { minutesBetween } from '../util/time';
import { isCustomerFacingEngineerEvent } from '../quality/conversation';
import { candidate, isAfter, isoAt, requirementLink, stampOf } from './helpers';
import { producerStep } from './suggest';
import type { Checkpoint, WarningCandidate } from './types';

export const SCO_MISSING = 'LQ-SCO-01';

interface Neglected {
  id: string;
  label: string;
  description: string;
  askText: string;
  criticality: 'critical' | 'important';
  relevantAt: string;
  /** The instant the grace period ends: the warning is raised then. */
  dueAt: string;
}

/**
 * Scoping items the pack expects at case opening that were never obtained and never asked for.
 * Items the engineer has asked for (a pack step that produces them was sent to the customer) are
 * not flagged, and a grace period leaves the customer time to answer.
 */
function neglectedScoping(cp: Checkpoint): Neglected[] {
  const requested = new Set<string>();
  for (const event of cp.events) {
    if (!isCustomerFacingEngineerEvent(event)) continue;
    const key = cp.actionByEvent.get(event.id)?.actionKey;
    for (const id of key ? (cp.pack.actions.get(key)?.produces ?? []) : []) requested.add(id);
  }
  const engaged = cp.events.some(isCustomerFacingEngineerEvent);
  if (!engaged) return [];
  const out: Neglected[] = [];
  for (const req of cp.pack.pack.requirements) {
    if (req.neededFrom !== 'case_open' || req.criticality === 'helpful') continue;
    const state = cp.requirement(req.id);
    if (!state || state.firstRelevantAt === null || cp.satisfied(req.id) || requested.has(req.id)) {
      continue;
    }
    const dueMs = Date.parse(state.firstRelevantAt) + cp.options.scopingGraceMinutes * 60_000;
    out.push({
      id: req.id,
      label: req.label,
      description: req.description,
      askText: req.askText,
      criticality: req.criticality,
      relevantAt: state.firstRelevantAt,
      dueAt: isoAt(dueMs),
    });
  }
  return out;
}

function missingScoping(cp: Checkpoint): WarningCandidate[] {
  return neglectedScoping(cp)
    .filter((n) => !isAfter(n.dueAt, cp.now))
    .map((n) =>
      candidate({
        ruleId: SCO_MISSING,
        subject: n.id,
        category: 'scoping',
        priority: n.criticality === 'critical' ? 'medium' : 'low',
        title: `${n.label}: not yet obtained or requested`,
        message: `${n.description} It has been missing since ${stampOf(n.relevantAt)} (${Math.round(minutesBetween(n.relevantAt, cp.now))} minutes) and no request for it has gone to the customer. Suggested ask: ${n.askText}`,
        step: producerStep(cp, n.id),
        lead: 'Ask for it now: ',
        fallback: `Ask for it now: ${n.askText}`,
        evidence: [requirementLink(cp, n.id)],
        raisedAt: n.dueAt,
        kind: 'state',
      }),
    );
}

/** Instants (after `now`) at which a not-yet-flagged scoping item passes its grace period. */
export function scopingDeadlines(cp: Checkpoint): string[] {
  return neglectedScoping(cp)
    .map((n) => n.dueAt)
    .filter((due) => isAfter(due, cp.now));
}

export const scopingRules = [missingScoping] as const;
