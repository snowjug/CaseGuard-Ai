import { CLOSURE_REQUIREMENT_IDS } from '../quality/parameters';
import { candidate, eventLinks, requirementLink, stampOf } from './helpers';
import { classStep } from './suggest';
import type { Checkpoint, WarningCandidate } from './types';

export const CLS_UNVALIDATED = 'LQ-CLS-01';
export const CLS_CONFLATION = 'LQ-CLS-02';

/** Closure was recorded without validation evidence or the customer's confirmation. */
function closureWithoutValidation(cp: Checkpoint): WarningCandidate[] {
  const closure = cp.closureIndex;
  const event = cp.events[closure];
  if (!event) return [];
  const label = (id: string): string => cp.pack.requirements.get(id)?.label ?? id;
  const tracked = [
    CLOSURE_REQUIREMENT_IDS.fixValidation,
    CLOSURE_REQUIREMENT_IDS.customerConfirmation,
  ].filter((id) => cp.pack.requirements.has(id));
  const missingAtClosure = tracked.filter((id) => !cp.satisfiedBefore(id, closure + 1));
  if (missingAtClosure.length === 0 || missingAtClosure.every((id) => cp.satisfied(id))) return [];
  const noValidation = missingAtClosure.includes(CLOSURE_REQUIREMENT_IDS.fixValidation);
  return [
    candidate({
      ruleId: CLS_UNVALIDATED,
      subject: 'closure',
      category: 'closure',
      priority: noValidation ? 'critical' : 'high',
      title: noValidation
        ? 'Resolution recorded without validation evidence'
        : 'Resolution recorded without the customer’s confirmation',
      message: `The case was marked resolved at ${stampOf(event.timestamp)} but the record does not yet show: ${missingAtClosure.map(label).join('; ')}. Closing without it risks reopening the case.`,
      step: classStep(cp, 'validation'),
      lead: 'Validate before closing: ',
      fallback: 'Compare failures before and after the change and ask the customer to confirm.',
      evidence: [
        ...eventLinks(cp, [event.id]),
        ...missingAtClosure.map((id) => requirementLink(cp, id)),
      ],
      raisedAt: event.timestamp,
      kind: 'state',
    }),
  ];
}

/** A workaround is described but not separated from the permanent fix. */
function workaroundFixConflation(cp: Checkpoint): WarningCandidate[] {
  const closure = cp.closureIndex;
  const event = cp.events[closure];
  const id = CLOSURE_REQUIREMENT_IDS.workaroundVsFix;
  const requirement = cp.pack.requirements.get(id);
  if (!event || !requirement) return [];
  const mentionsWorkaround = cp.events.some((e) =>
    cp.pack.lexicon.workaround.some((re) => re.test(e.body)),
  );
  if (!mentionsWorkaround || cp.satisfiedBefore(id, closure + 1) || cp.satisfied(id)) return [];
  return [
    candidate({
      ruleId: CLS_CONFLATION,
      subject: 'closure',
      category: 'closure',
      priority: 'medium',
      title: 'Workaround and permanent fix are not stated separately',
      message: `The record mentions a workaround, but at ${stampOf(event.timestamp)} it does not describe the workaround and the permanent fix as separate items. A temporary measure can be mistaken for the cure.`,
      step: null,
      lead: requirement.askText,
      evidence: [...eventLinks(cp, [event.id]), requirementLink(cp, id)],
      raisedAt: event.timestamp,
      kind: 'state',
    }),
  ];
}

export const closureRules = [closureWithoutValidation, workaroundFixConflation] as const;
