import { ENGINEER_SIDE_ROLES, type Claim } from '@caseguard/schemas';
import { eventText } from '../engine/signals';
import { evidenceLink, plural, truncate } from '../quality/links';
import {
  candidate,
  eventLinks,
  latestBeliefIndex,
  latestEvent,
  requirementLink,
  stampOf,
} from './helpers';
import { bestNextStep, producerStep } from './suggest';
import type { Checkpoint, WarningCandidate } from './types';

export const EVD_MIN_EVIDENCE = 'LQ-EVD-01';
export const EVD_UNSUPPORTED = 'LQ-EVD-02';
export const EVD_CONTRADICTED = 'LQ-EVD-03';
export const EVD_TEMPLATE = 'LQ-EVD-04';

/** Intent to hand the case to another team (an engineer or manager says so, or escalates). */
const ESCALATION_INTENT =
  /\bescalat\w*|\b(?:ask(?:ed|ing)?|engag\w*|involv\w*|rais\w*|hand\w*)\b[^.\n]{0,40}\b(?:identity|backend|product group|pg|engineering|tier ?2)\b[^.\n]{0,24}\bteam\b/i;

const AS_FACT: readonly Claim['flags'][number][] = ['unsupported_root_cause', 'assumption_as_fact'];

const isEscalationEvent = (cp: Checkpoint, index: number): boolean => {
  const event = cp.events[index];
  return (
    event !== undefined &&
    (event.type === 'escalation' || cp.actionByEvent.get(event.id)?.kind === 'escalation')
  );
};

/** Minimum evidence missing before or at escalation (two tiers: considered, then recorded). */
function minimumEvidenceBeforeEscalation(cp: Checkpoint): WarningCandidate[] {
  const required = cp.pack.pack.policies.minimumEvidenceForEscalation;
  if (required.length === 0) return [];
  const label = (id: string): string => cp.pack.requirements.get(id)?.label ?? id;
  const escalationIndex = cp.events.findIndex((_, i) => isEscalationEvent(cp, i));
  const out: WarningCandidate[] = [];

  if (escalationIndex >= 0) {
    const missingAtEscalation = required.filter((id) => !cp.satisfiedBefore(id, escalationIndex));
    const event = cp.events[escalationIndex];
    if (
      event &&
      missingAtEscalation.length > 0 &&
      missingAtEscalation.some((id) => !cp.satisfied(id))
    ) {
      const first = missingAtEscalation[0] ?? '';
      out.push(
        candidate({
          ruleId: EVD_MIN_EVIDENCE,
          subject: 'recorded',
          category: 'evidence',
          priority: 'high',
          title: 'Escalated before the minimum evidence was in hand',
          message: `The case was escalated at ${stampOf(event.timestamp)} while required evidence was still missing: ${missingAtEscalation.map(label).join('; ')}. A receiving team needs it to act, and escalations without it tend to be sent back.`,
          step: producerStep(cp, first),
          lead: 'Collect it and add it to the escalation: ',
          evidence: [
            ...eventLinks(cp, [event.id]),
            ...missingAtEscalation.map((id) => requirementLink(cp, id)),
          ],
          raisedAt: event.timestamp,
          kind: 'state',
          supersedes: [`${EVD_MIN_EVIDENCE}|planned`],
        }),
      );
    }
    return out;
  }

  const missingNow = required.filter((id) => !cp.satisfied(id));
  if (missingNow.length === 0) return out;
  const intentIndex = cp.events.findIndex(
    (e) => ENGINEER_SIDE_ROLES.includes(e.participantRole) && ESCALATION_INTENT.test(eventText(e)),
  );
  const intent = cp.events[intentIndex];
  if (intent) {
    const first = missingNow[0] ?? '';
    out.push(
      candidate({
        ruleId: EVD_MIN_EVIDENCE,
        subject: 'planned',
        category: 'evidence',
        priority: 'medium',
        title: 'Escalation is being considered, but the minimum evidence is not in hand',
        message: `At ${stampOf(intent.timestamp)} the record shows an escalation or hand-over is being considered. The minimum evidence for escalation is still missing: ${missingNow.map(label).join('; ')}.`,
        step: producerStep(cp, first),
        lead: 'Collect it before escalating: ',
        evidence: [
          ...eventLinks(cp, [intent.id]),
          ...missingNow.map((id) => requirementLink(cp, id)),
        ],
        raisedAt: intent.timestamp,
        kind: 'state',
      }),
    );
  }
  return out;
}

/** A cause or assumption presented as established fact without supporting diagnostic evidence. */
function unsupportedAssertion(cp: Checkpoint): WarningCandidate[] {
  const belief = latestBeliefIndex(cp);
  const event = cp.events[belief];
  if (!event) return [];
  const flagged = cp.claims.filter(
    (c) =>
      c.eventId === event.id &&
      c.ruleId.startsWith('statement.') &&
      c.flags.some((f) => AS_FACT.includes(f)),
  );
  const bySubject = new Map<string, Claim>();
  for (const claim of flagged) {
    const subject = cp.hypothesisKey(claim.relatedHypothesisIds[0] ?? 'unspecified');
    if (!bySubject.has(subject)) bySubject.set(subject, claim);
  }
  return [...bySubject.entries()].map(([subject, claim]) => {
    const rootCause = claim.flags.includes('unsupported_root_cause');
    return candidate({
      ruleId: EVD_UNSUPPORTED,
      subject,
      category: 'evidence',
      priority: 'high',
      title: rootCause
        ? 'Root cause stated without supporting evidence'
        : 'Assumption stated as fact',
      message: `At ${stampOf(event.timestamp)} the record states “${truncate(claim.text, 150)}” as established. ${claim.explanation}`,
      step: bestNextStep(cp),
      lead: 'Word it as a working hypothesis until diagnostic evidence supports it. A higher-value check right now: ',
      evidence: [evidenceLink('claim', claim.id, claim.text), ...eventLinks(cp, [event.id])],
      raisedAt: event.timestamp,
      kind: 'state',
    });
  });
}

/** The working hypothesis the engineer last stated is contradicted by evidence already on record. */
function contradictedHypothesis(cp: Checkpoint): WarningCandidate[] {
  const belief = latestBeliefIndex(cp);
  const event = cp.events[belief];
  if (!event) return [];
  return cp.anchors
    .filter((a) => a.eventIndex === belief)
    .map((anchor) => {
      const conflict = cp.claims.find(
        (c) => c.ruleId === 'conflict.anchoring' && c.eventId === event.id,
      );
      const key = cp.hypothesisKey(anchor.hypothesisId);
      const leader = cp.hypothesisKey(anchor.leaderId);
      return candidate({
        ruleId: EVD_CONTRADICTED,
        subject: key,
        category: 'evidence',
        priority: 'high',
        title: 'Working hypothesis conflicts with evidence on record',
        message:
          conflict?.text ??
          `The working hypothesis “${cp.hypothesisName(key)}” stood at ${Math.round(anchor.pBefore * 100)}% while “${cp.hypothesisName(leader)}” stood at ${Math.round(anchor.leaderP * 100)}% when it was stated.`,
        step: bestNextStep(cp, { target: leader }),
        lead: `Test the better-supported explanation (“${cp.hypothesisName(leader)}”) before continuing: `,
        evidence: [
          ...(conflict ? [evidenceLink('claim', conflict.id, conflict.text)] : []),
          ...anchor.contradictingEvidenceIds
            .slice(0, 3)
            .map((id) => evidenceLink('evidence', id, cp.evidenceLabel(id))),
          ...eventLinks(cp, [event.id]),
        ],
        raisedAt: event.timestamp,
        kind: 'state',
      });
    });
}

/** Checklist wording stood in for evidence (a nudge raised at the statement). */
function templateWithoutEvidence(cp: Checkpoint): WarningCandidate[] {
  const event = latestEvent(cp);
  if (!event) return [];
  const claims = cp.claims.filter(
    (c) => c.eventId === event.id && c.flags.includes('template_without_evidence'),
  );
  const first = claims[0];
  if (!first) return [];
  return [
    candidate({
      ruleId: EVD_TEMPLATE,
      subject: event.id,
      category: 'evidence',
      priority: 'medium',
      title: 'Checklist wording used in place of evidence',
      message: `At ${stampOf(event.timestamp)} ${plural(claims.length, 'statement')} say a checklist or standard procedure was completed, but no diagnostic evidence is cited. ${first.explanation}`,
      step: null,
      lead: 'Record what was actually observed (the query, the result and the time) instead of the checklist outcome.',
      evidence: [evidenceLink('claim', first.id, first.text), ...eventLinks(cp, [event.id])],
      raisedAt: event.timestamp,
      kind: 'nudge',
      triggerIndex: cp.index,
    }),
  ];
}

export const evidenceRules = [
  minimumEvidenceBeforeEscalation,
  unsupportedAssertion,
  contradictedHypothesis,
  templateWithoutEvidence,
] as const;
