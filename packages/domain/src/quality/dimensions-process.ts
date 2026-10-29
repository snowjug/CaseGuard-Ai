import { DEFAULT_EFFORT_MINUTES, type EvidenceLink } from '@caseguard/schemas';
import { isCustomerSide } from '../engine/context';
import { isSatisfiedAt } from '../engine/requirements';
import { mean } from '../util/math';
import { formatDuration, minutesBetween } from '../util/time';
import { makeCheck, makeDimension, notApplicable, scoreBetween, undecided } from './checks';
import type { QualityFacts } from './facts';
import { CLOSURE_REQUIREMENT_IDS } from './parameters';
import { eventLink, evidenceLink, plural } from './links';
import type { DimensionDraft } from './types';

const CRITICALITY_WEIGHT = { critical: 3, important: 2, helpful: 1 } as const;

/** Scoping completeness: the facts needed to start a real investigation were obtained, and asked for sensibly. */
export function scopingCompleteness(f: QualityFacts): DimensionDraft {
  const { params } = f;
  const scoping = f.pack.pack.requirements.filter(
    (r) => r.neededFrom === 'case_open' || r.neededFrom === 'first_engineer_request',
  );
  let earned = 0;
  let counted = 0;
  let pending = 0;
  const missing: EvidenceLink[] = [];
  for (const req of scoping) {
    const state = f.requirement(req.id);
    if (!state || state.firstRelevantIndex === null) continue;
    const satisfied = state.satisfiedAtIndex !== null;
    const age = minutesBetween(state.firstRelevantAt ?? f.viewEnd, f.viewEnd);
    if (!satisfied && age < params.scopingGraceMinutes) {
      pending += 1;
      continue;
    }
    const weight = CRITICALITY_WEIGHT[req.criticality];
    counted += weight;
    if (satisfied) earned += weight;
    else missing.push(evidenceLink('requirement', req.id, req.label));
  }
  // Items still inside the grace period are neither credited nor held against the case, but a
  // verdict of "everything was captured" cannot be given while some are still open.
  const capturedCheck =
    counted > 0 && (pending === 0 || missing.length > 0)
      ? makeCheck({
          id: 'SC-1',
          label: 'Scope, impact and key identifiers were captured',
          weight: 0.45,
          score: earned / counted,
          note:
            missing.length === 0
              ? 'Every scoping item the knowledge pack expects was captured.'
              : `${plural(missing.length, 'scoping item')} still missing: ${missing.map((m) => m.label ?? m.id).join('; ')}.`,
          evidence: missing,
        })
      : undecided(
          'SC-1',
          'Scope, impact and key identifiers were captured',
          0.45,
          pending > 0
            ? `${plural(pending, 'scoping item')} still within the grace period, so completeness cannot be judged yet.`
            : 'Too early to judge.',
        );

  const firstAsk = f.customerFacing.find((e) => f.actionByEvent.has(e.id));
  const firstAction = firstAsk ? f.actionByEvent.get(firstAsk.id) : undefined;
  let askCheck = undecided(
    'SC-2',
    'The first request to the customer was minimal and targeted',
    0.3,
    'No request to the customer yet.',
  );
  if (firstAsk && firstAction) {
    const idx = f.indexOf.get(firstAsk.id) ?? 0;
    const missingCritical = f.pack.pack.requirements
      .filter((r) => r.criticality === 'critical' && r.neededFrom === 'case_open')
      .filter((r) => {
        const state = f.requirement(r.id);
        return !(state && isSatisfiedAt(state, idx - 1));
      });
    const produced = new Set(
      firstAction.actionKey ? (f.pack.actions.get(firstAction.actionKey)?.produces ?? []) : [],
    );
    const covers = missingCritical.length === 0 || missingCritical.some((r) => produced.has(r.id));
    const effort = f.actionConfig.effortScale[firstAction.customerEffort];
    askCheck = makeCheck({
      id: 'SC-2',
      label: 'The first request to the customer was minimal and targeted',
      weight: 0.3,
      score: (covers ? 1 : 0.4) * (1 - 0.75 * effort),
      note: `The first request (“${firstAction.label}”) asked for ${firstAction.customerEffort.replace('_', ' ')} customer effort and ${covers ? 'covered' : 'did not cover'} the critical scoping items still missing (${missingCritical.map((r) => r.label).join('; ') || 'none'}).`,
      evidence: [eventLink(firstAsk), evidenceLink('action', firstAction.id, firstAction.label)],
    });
  }

  const escalationIndex = f.events.findIndex(
    (e) => e.type === 'escalation' || f.actionByEvent.get(e.id)?.kind === 'escalation',
  );
  const required = f.pack.pack.policies.minimumEvidenceForEscalation;
  const escalationEvent = f.events[escalationIndex];
  let escalationCheck = notApplicable(
    'SC-3',
    'The minimum evidence was in hand before escalating',
    'The case has not been escalated in this view, so there is nothing to check.',
  );
  if (escalationEvent && required.length > 0) {
    const unmet = required.filter((id) => {
      const state = f.requirement(id);
      return !(state && isSatisfiedAt(state, escalationIndex - 1));
    });
    escalationCheck = makeCheck({
      id: 'SC-3',
      label: 'The minimum evidence was in hand before escalating',
      weight: 0.25,
      score: (required.length - unmet.length) / required.length,
      note:
        unmet.length === 0
          ? 'All minimum evidence for escalation was on record before the escalation.'
          : `At escalation these were still missing: ${unmet.map((id) => f.pack.requirements.get(id)?.label ?? id).join('; ')}.`,
      evidence: [
        eventLink(escalationEvent),
        ...unmet.map((id) => evidenceLink('requirement', id, f.pack.requirements.get(id)?.label)),
      ],
    });
  }
  return makeDimension(
    'scoping_completeness',
    [capturedCheck, askCheck, escalationCheck],
    params.uncertaintyMargin,
    '',
  );
}

/** Customer communication: prompt first answer, expectations set, replies timely, no need to chase. */
export function customerCommunication(f: QualityFacts): DimensionDraft {
  const { params } = f;
  const firstCustomer = f.events.find((e) => isCustomerSide(e.participantRole));
  const firstReply = firstCustomer
    ? f.customerFacing.find(
        (e) => (f.indexOf.get(e.id) ?? 0) > (f.indexOf.get(firstCustomer.id) ?? 0),
      )
    : undefined;
  let responseCheck = undecided(
    'CC-1',
    'The first reply to the customer was prompt',
    0.15,
    'No customer message yet.',
  );
  if (firstCustomer) {
    const minutes = minutesBetween(firstCustomer.timestamp, firstReply?.timestamp ?? f.viewEnd);
    if (firstReply || minutes > params.firstResponseGoodMinutes) {
      responseCheck = makeCheck({
        id: 'CC-1',
        label: 'The first reply to the customer was prompt',
        weight: 0.15,
        score: scoreBetween(
          minutes,
          params.firstResponseGoodMinutes,
          params.firstResponseBadMinutes,
        ),
        note: firstReply
          ? `The first reply reached the customer after ${formatDuration(minutes)}.`
          : `No reply had reached the customer after ${formatDuration(minutes)}.`,
        evidence: [eventLink(firstCustomer), ...(firstReply ? [eventLink(firstReply)] : [])],
      });
    }
  }

  const emails = f.customerFacing.filter((e) => e.type === 'engineer_email');
  const withExpectation = emails.filter((e) =>
    f.pack.lexicon.expectation.some((re) => re.test(e.body)),
  );
  const expectationCheck =
    emails.length > 0
      ? makeCheck({
          id: 'CC-2',
          label: 'Expectations and next steps were set',
          weight: 0.25,
          score: withExpectation.length / emails.length,
          note: `${withExpectation.length} of ${plural(emails.length, 'message')} to the customer said when the next update or result would come.`,
          evidence: emails
            .filter((e) => !withExpectation.includes(e))
            .slice(0, 4)
            .map(eventLink),
        })
      : undecided(
          'CC-2',
          'Expectations and next steps were set',
          0.25,
          'No message to the customer yet.',
        );

  const counted = f.replyWaits.filter((w) => !w.censored || w.hours >= params.replyWaitGoodHours);
  const latencyCheck =
    counted.length > 0
      ? makeCheck({
          id: 'CC-3',
          label: 'Customer messages were answered in a timely way',
          weight: 0.3,
          score: mean(
            counted.map((w) =>
              scoreBetween(w.hours, params.replyWaitGoodHours, params.replyWaitBadHours),
            ),
          ),
          note: `${counted.filter((w) => w.hours > params.replyWaitGoodHours).length} of ${plural(counted.length, 'customer message')} waited longer than ${params.replyWaitGoodHours} hours for a reply; the longest wait was ${formatDuration(Math.max(...counted.map((w) => w.hours)) * 60)}.`,
          evidence: [...counted]
            .sort((a, b) => b.hours - a.hours)
            .slice(0, 3)
            .flatMap((w) => {
              const event = f.events[f.indexOf.get(w.eventId) ?? -1];
              return event ? [eventLink(event)] : [];
            }),
        })
      : undecided(
          'CC-3',
          'Customer messages were answered in a timely way',
          0.3,
          'No customer message awaiting a reply yet.',
        );

  const chasers = f.chaseEvents.length;
  // Without a chaser, "no need to chase" only means something once the customer has waited long
  // enough to need news.
  const spanHours = firstCustomer ? minutesBetween(firstCustomer.timestamp, f.viewEnd) / 60 : 0;
  const chaseCheck =
    chasers > 0 || spanHours >= params.replyWaitGoodHours
      ? makeCheck({
          id: 'CC-4',
          label: 'The customer did not have to chase for news',
          weight: 0.3,
          score: 1 - Math.min(1, chasers / params.chaseCountForZero),
          note:
            chasers === 0
              ? 'The customer never had to ask for an update.'
              : `The customer asked for an update or plan ${plural(chasers, 'time')}.`,
          evidence: f.chaseEvents.slice(0, 4).map(eventLink),
        })
      : undecided(
          'CC-4',
          'The customer did not have to chase for news',
          0.3,
          'Too early to tell: the customer has not yet waited long enough to need an update.',
        );

  return makeDimension(
    'customer_communication',
    [responseCheck, expectationCheck, latencyCheck, chaseCheck],
    params.uncertaintyMargin,
    '',
  );
}

/** Resolution validation: closure was earned (validated, confirmed, workaround and fix told apart). */
export function resolutionValidation(f: QualityFacts): DimensionDraft {
  const { params, closure } = f;
  const waiting = 'No closure statement or resolution is in this view yet.';
  const requirementCheck = (
    id: string,
    label: string,
    weight: number,
    requirementId: string,
    yes: string,
    no: string,
  ) => {
    const state = f.requirement(requirementId);
    if (!closure || !state) {
      return undecided(
        id,
        label,
        weight,
        closure ? 'The knowledge pack defines no such requirement.' : waiting,
      );
    }
    const ok = isSatisfiedAt(state, closure.index);
    return makeCheck({
      id,
      label,
      weight,
      score: ok ? 1 : 0,
      note: ok ? yes : no,
      evidence: [
        ...(closure.event ? [eventLink(closure.event)] : []),
        evidenceLink('requirement', requirementId, f.pack.requirements.get(requirementId)?.label),
      ],
    });
  };
  const diagnosed = closure !== null && f.diagnosis !== null && f.diagnosis.index <= closure.index;
  const diagnosisCheck = closure
    ? makeCheck({
        id: 'RV-4',
        label: 'A diagnosis was confirmed before closing',
        weight: 0.15,
        score: diagnosed ? 1 : 0,
        note: diagnosed
          ? 'The leading hypothesis was confirmed by evidence before the case was closed.'
          : 'No hypothesis had been confirmed by evidence when the case was closed.',
        evidence: closure.event ? [eventLink(closure.event)] : [],
      })
    : undecided('RV-4', 'A diagnosis was confirmed before closing', 0.15, waiting);
  return makeDimension(
    'resolution_validation',
    [
      requirementCheck(
        'RV-1',
        'The fix was validated with before/after evidence',
        0.4,
        CLOSURE_REQUIREMENT_IDS.fixValidation,
        'A before/after comparison was on record before the case was closed.',
        'The case was closed without a before/after comparison of the failures.',
      ),
      requirementCheck(
        'RV-2',
        'The customer confirmed the result',
        0.25,
        CLOSURE_REQUIREMENT_IDS.customerConfirmation,
        'The customer confirmed users could sign in before the case was closed.',
        'The case was closed without the customer confirming the result.',
      ),
      requirementCheck(
        'RV-3',
        'Workaround and permanent fix were stated separately',
        0.2,
        CLOSURE_REQUIREMENT_IDS.workaroundVsFix,
        'The workaround and the permanent fix were described separately.',
        'The workaround and the permanent fix were not clearly separated.',
      ),
      diagnosisCheck,
    ],
    params.uncertaintyMargin,
    '',
  );
}

/** Efficiency and proportionality: little repeated work, a light touch on the customer, a prompt diagnosis. */
export function efficiencyProportionality(f: QualityFacts): DimensionDraft {
  const { params } = f;
  const lowValue = f.actions.filter((a) => a.lowValue);
  const valueCheck =
    f.actions.length > 0
      ? makeCheck({
          id: 'EF-1',
          label: 'Steps added information rather than repeating work',
          weight: 0.35,
          score: 1 - lowValue.length / f.actions.length,
          note: `${lowValue.length} of ${plural(f.actions.length, 'step')} repeated earlier work, re-checked what was already known, or had a far better alternative available.`,
          evidence: lowValue.slice(0, 4).map((a) => evidenceLink('action', a.id, a.label)),
        })
      : undecided(
          'EF-1',
          'Steps added information rather than repeating work',
          0.35,
          'No steps yet.',
        );

  const minutes = f.actions.reduce((s, a) => s + DEFAULT_EFFORT_MINUTES[a.customerEffort], 0);
  const heavy = f.actions.filter(
    (a) => f.actionConfig.effortScale[a.customerEffort] >= params.heavyEffortScore,
  );
  const burdenCheck =
    f.actions.length > 0
      ? makeCheck({
          id: 'EF-2',
          label: 'The effort asked of the customer was proportionate',
          weight: 0.35,
          score: scoreBetween(minutes, params.customerMinutesGood, params.customerMinutesBad),
          note: `About ${minutes} minutes of customer time were requested (estimated from effort levels), including ${plural(heavy.length, 'heavy request')}.`,
          evidence: heavy.slice(0, 4).map((a) => evidenceLink('action', a.id, a.label)),
        })
      : undecided(
          'EF-2',
          'The effort asked of the customer was proportionate',
          0.35,
          'No steps yet.',
        );

  let lagCheck = undecided(
    'EF-3',
    'The evidence was turned into a confirmed diagnosis promptly',
    0.3,
    'No confirmed diagnosis yet.',
  );
  if (f.diagnosis) {
    const key = f.diagnosis.key;
    const diagnosisEvent = f.events[f.diagnosis.index];
    const leading = f.analysis.timeline.steps.find((s) => (s.posterior[key] ?? 0) >= 0.6);
    const hours = Math.max(0, minutesBetween(leading?.at ?? f.diagnosis.at, f.diagnosis.at)) / 60;
    lagCheck = makeCheck({
      id: 'EF-3',
      label: 'The evidence was turned into a confirmed diagnosis promptly',
      weight: 0.3,
      score: scoreBetween(hours, params.diagnosisLagGoodHours, params.diagnosisLagBadHours),
      note: `“${f.hypothesisName(key)}” led at 60% or more ${formatDuration(hours * 60)} before it was confirmed.`,
      evidence: [
        evidenceLink('hypothesis', key, f.hypothesisName(key)),
        ...(diagnosisEvent ? [eventLink(diagnosisEvent)] : []),
      ],
    });
  }
  return makeDimension(
    'efficiency_proportionality',
    [valueCheck, burdenCheck, lagCheck],
    params.uncertaintyMargin,
    '',
  );
}
