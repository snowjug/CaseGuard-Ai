import type { DecisionFork, ForkCategory } from '@caseguard/schemas';
import { evidenceLink } from '../quality/links';
import { candidate, eventLinks, latestEvent, stampOf } from './helpers';
import { decisionAlternative, toSuggestedStep } from './suggest';
import type { Checkpoint, SuggestedStep, WarningCandidate } from './types';

export const TRB_REPEAT = 'LQ-TRB-01';
export const TRB_KNOWN = 'LQ-TRB-02';
export const TRB_RISKY = 'LQ-TRB-03';
export const TRB_HEAVY = 'LQ-TRB-04';

const hasCategory = (fork: DecisionFork, category: ForkCategory): boolean =>
  fork.category === category || fork.additionalCategories.includes(category);

/** First safe alternative of a fork (decision-time data) that satisfies the filter, as a pack step. */
function forkAlternative(
  cp: Checkpoint,
  fork: DecisionFork,
  maxEffortScore?: number,
): SuggestedStep | null {
  for (const alternative of fork.alternatives) {
    if (!alternative.safe) continue;
    const action = cp.pack.actions.get(alternative.actionKey);
    if (!action) continue;
    if (
      maxEffortScore !== undefined &&
      cp.config.effortScale[action.customerEffort] > maxEffortScore
    ) {
      continue;
    }
    return toSuggestedStep(action);
  }
  return null;
}

function repeatedDiagnostic(cp: Checkpoint): WarningCandidate[] {
  const event = latestEvent(cp);
  const action = event ? cp.actionByEvent.get(event.id) : undefined;
  if (!event || !action?.isRepeat) return [];
  const original = cp.actions.find((a) => a.id === action.repeatOfActionId);
  const toCustomer = action.kind === 'customer_request';
  return [
    candidate({
      ruleId: TRB_REPEAT,
      subject: event.id,
      category: 'troubleshooting',
      priority: 'medium',
      title: toCustomer
        ? 'The same request to the customer appears to be repeated'
        : 'The same diagnostic appears to have been repeated',
      message: toCustomer
        ? `At ${stampOf(event.timestamp)} “${action.label}” repeats ${original ? `“${original.label}” from ${stampOf(original.startedAt)}` : 'an earlier request'}. The customer has already been asked for this, so asking again adds effort for them and is unlikely to add new information.`
        : `At ${stampOf(event.timestamp)} “${action.label}” repeats ${original ? `“${original.label}” from ${stampOf(original.startedAt)}` : 'an earlier step'}. The earlier result is already on record, so running it again is unlikely to add new information.`,
      step: decisionAlternative(cp, event.id),
      lead: 'A higher-value next step at that moment: ',
      fallback: 'Review the earlier result before repeating the step.',
      evidence: [
        evidenceLink('action', action.id, action.label),
        ...(original ? [evidenceLink('action', original.id, original.label)] : []),
        ...eventLinks(cp, [event.id]),
      ],
      raisedAt: event.timestamp,
      kind: 'nudge',
      triggerIndex: cp.index,
    }),
  ];
}

function outcomeAlreadyKnown(cp: Checkpoint): WarningCandidate[] {
  const event = latestEvent(cp);
  const action = event ? cp.actionByEvent.get(event.id) : undefined;
  const known = event
    ? cp
        .decision(event.id)
        ?.actual?.safety.blockedReasons.find((r) => r.startsWith('Already known'))
    : undefined;
  if (!event || !action || action.isRepeat || !known) return [];
  return [
    candidate({
      ruleId: TRB_KNOWN,
      subject: event.id,
      category: 'troubleshooting',
      priority: 'medium',
      title: 'The likely outcome of this check was already known',
      message: `At ${stampOf(event.timestamp)} “${action.label}” was run, but evidence already on record answers it (${known.replace(/^Already known:\s*/, '').replace(/\.$/, '')}).`,
      step: decisionAlternative(cp, event.id),
      lead: 'A step that would add new information at that moment: ',
      fallback: 'Use the result already on record instead of running the check again.',
      evidence: [evidenceLink('action', action.id, action.label), ...eventLinks(cp, [event.id])],
      raisedAt: event.timestamp,
      kind: 'nudge',
      triggerIndex: cp.index,
    }),
  ];
}

function riskyWithoutJustification(cp: Checkpoint): WarningCandidate[] {
  const event = latestEvent(cp);
  if (!event) return [];
  const fork = cp.forks.find(
    (f) => f.eventId === event.id && hasCategory(f, 'premature_destructive_action'),
  );
  if (!fork) return [];
  const action = cp.actionByEvent.get(event.id);
  const severe = action
    ? action.destructive || action.operationalRisk >= cp.config.riskCeiling
    : false;
  return [
    candidate({
      ruleId: TRB_RISKY,
      subject: event.id,
      category: 'troubleshooting',
      priority: severe ? 'critical' : 'high',
      title: fork.title,
      message: fork.summary,
      step: forkAlternative(cp, fork) ?? decisionAlternative(cp, event.id),
      lead: 'A safer, higher-value step available at that moment: ',
      fallback:
        'Hold the change until the targeted hypothesis is supported by diagnostic evidence.',
      evidence: [
        evidenceLink('fork', fork.id, fork.title),
        ...(action ? [evidenceLink('action', action.id, action.label)] : []),
        ...eventLinks(cp, [event.id]),
      ],
      raisedAt: event.timestamp,
      kind: 'nudge',
      triggerIndex: cp.index,
    }),
  ];
}

function heavyAskWhenLighterExists(cp: Checkpoint): WarningCandidate[] {
  const event = latestEvent(cp);
  const action = event ? cp.actionByEvent.get(event.id) : undefined;
  if (!event || !action || action.isRepeat) return [];
  const fork = cp.forks.find(
    (f) => f.eventId === event.id && hasCategory(f, 'disproportionate_customer_effort'),
  );
  if (!fork) return [];
  const lighterThan = action.customerEffortScore - 0.3;
  return [
    candidate({
      ruleId: TRB_HEAVY,
      subject: event.id,
      category: 'troubleshooting',
      priority: action.customerEffort === 'very_high' ? 'high' : 'medium',
      title: 'A heavy request to the customer when a lighter one was available',
      message: fork.summary,
      step:
        forkAlternative(cp, fork, lighterThan) ??
        decisionAlternative(cp, event.id, { maxEffortScore: lighterThan }),
      lead: 'A lighter ask that was available at that moment: ',
      fallback: 'Ask for the smallest targeted data that answers the question first.',
      evidence: [
        evidenceLink('fork', fork.id, fork.title),
        evidenceLink('action', action.id, action.label),
        ...eventLinks(cp, [event.id]),
      ],
      raisedAt: event.timestamp,
      kind: 'nudge',
      triggerIndex: cp.index,
    }),
  ];
}

export const troubleshootingRules = [
  repeatedDiagnostic,
  outcomeAlreadyKnown,
  riskyWithoutJustification,
  heavyAskWhenLighterExists,
] as const;
