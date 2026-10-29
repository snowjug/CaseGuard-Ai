import type { ActionKind, DecisionFork, DiagnosticAction, ForkCategory } from '@caseguard/schemas';
import { isSatisfiedAt } from '../engine/requirements';
import { tokenJaccard } from '../util/math';
import { formatUtcStamp } from '../util/time';
import { eventLink, evidenceLink, plural, truncate, uniqueLinks } from './links';
import type { QualityFacts } from './facts';
import { CLOSURE_REQUIREMENT_IDS } from './parameters';
import type { PenaltyDraft } from './types';

const DIAGNOSTIC_KINDS: ReadonlySet<ActionKind> = new Set([
  'log_query',
  'client_diagnostic',
  'network_diagnostic',
  'analysis',
  'customer_request',
]);

const forkHas = (fork: DecisionFork | undefined, category: ForkCategory): boolean =>
  fork !== undefined &&
  (fork.category === category || fork.additionalCategories.includes(category));

const forkIdsFor = (f: QualityFacts, eventIds: Iterable<string>): string[] =>
  [...eventIds].flatMap((id) => {
    const fork = f.forksByEvent.get(id);
    return fork ? [fork.id] : [];
  });

function eventLinksFor(f: QualityFacts, ids: Iterable<string>, max = 4) {
  return [...ids].slice(0, max).flatMap((id) => {
    const event = f.events[f.indexOf.get(id) ?? -1];
    return event ? [eventLink(event)] : [];
  });
}

function unsupportedRootCause(f: QualityFacts): PenaltyDraft | null {
  const claims = f.statementClaims.filter((c) => c.flags.includes('unsupported_root_cause'));
  const first = claims[0];
  if (!first) return null;
  const eventIds = new Set(claims.flatMap((c) => (c.eventId ? [c.eventId] : [])));
  return {
    key: 'unsupported_root_cause',
    dimension: 'evidence_integrity',
    instances: claims.length,
    forkIds: forkIdsFor(f, eventIds),
    evidence: uniqueLinks([
      ...claims.slice(0, 3).map((c) => evidenceLink('claim', c.id, c.text)),
      ...eventLinksFor(f, eventIds),
    ]),
    rationale: truncate(
      `${plural(claims.length, 'statement')} presented a cause as established without supporting diagnostic evidence, first at ${formatUtcStamp(first.timestamp)}. ${first.explanation}`,
      800,
    ),
  };
}

function templateWithoutEvidence(f: QualityFacts): PenaltyDraft | null {
  const claims = f.statementClaims.filter((c) => c.flags.includes('template_without_evidence'));
  const first = claims[0];
  if (!first) return null;
  const eventIds = new Set(claims.flatMap((c) => (c.eventId ? [c.eventId] : [])));
  return {
    key: 'template_completion_without_evidence',
    dimension: 'evidence_integrity',
    instances: claims.length,
    forkIds: forkIdsFor(f, eventIds),
    evidence: uniqueLinks([
      ...claims.slice(0, 3).map((c) => evidenceLink('claim', c.id, c.text)),
      ...eventLinksFor(f, eventIds),
    ]),
    rationale: truncate(
      `${plural(claims.length, 'checklist-style statement')} stood in for evidence (first at ${formatUtcStamp(first.timestamp)}); no supporting diagnostic evidence was cited.`,
      800,
    ),
  };
}

function repeatedLowValue(f: QualityFacts): PenaltyDraft | null {
  const hits = f.actions.filter(
    (a: DiagnosticAction) =>
      a.lowValue && DIAGNOSTIC_KINDS.has(a.kind) && (a.isRepeat || a.kind !== 'customer_request'),
  );
  if (hits.length === 0) return null;
  const repeats = hits.filter((a) => a.isRepeat).length;
  return {
    key: 'repeated_low_value_diagnostic',
    dimension: 'efficiency_proportionality',
    instances: hits.length,
    forkIds: forkIdsFor(
      f,
      hits.map((a) => a.eventId),
    ),
    evidence: uniqueLinks(hits.slice(0, 4).map((a) => evidenceLink('action', a.id, a.label))),
    rationale: truncate(
      `${plural(hits.length, 'diagnostic step')} repeated earlier work or re-checked what the record already showed (${repeats} exact repeats): ${hits
        .slice(0, 3)
        .map((a) => `“${a.label}” at ${formatUtcStamp(a.startedAt)}`)
        .join('; ')}.`,
      800,
    ),
  };
}

function destructiveWithoutJustification(f: QualityFacts): PenaltyDraft | null {
  const forks = f.analysis.forks.filter((fork) => forkHas(fork, 'premature_destructive_action'));
  const first = forks[0];
  if (!first) return null;
  return {
    key: 'destructive_action_without_justification',
    dimension: 'diagnostic_reasoning',
    instances: forks.length,
    forkIds: forks.map((fork) => fork.id),
    evidence: uniqueLinks([
      ...forks.slice(0, 3).map((fork) => evidenceLink('fork', fork.id, fork.title)),
      ...eventLinksFor(
        f,
        forks.map((fork) => fork.eventId),
      ),
    ]),
    rationale: truncate(
      `${plural(forks.length, 'risky or disruptive step')} went ahead before the targeted hypothesis was justified by evidence (first at ${formatUtcStamp(first.timestamp)}). ${first.summary}`,
      800,
    ),
  };
}

function ignoredContradiction(f: QualityFacts): PenaltyDraft | null {
  const anchors = f.analysis.anchors;
  const flagged = f.statementClaims.filter((c) => c.flags.includes('ignored_contradiction'));
  const eventIds = new Set([
    ...anchors.map((a) => a.eventId),
    ...flagged.flatMap((c) => (c.eventId ? [c.eventId] : [])),
  ]);
  if (eventIds.size === 0) return null;
  const conflictClaims = f.analysis.claims.filter((c) => c.ruleId === 'conflict.anchoring');
  const first = conflictClaims[0] ?? flagged[0];
  const labelOf = new Map(f.analysis.evidence.map((e) => [e.id, e.label]));
  const contradicting = anchors.flatMap((a) => a.contradictingEvidenceIds).slice(0, 3);
  return {
    key: 'ignored_contradiction',
    dimension: 'evidence_integrity',
    instances: eventIds.size,
    forkIds: forkIdsFor(f, eventIds),
    evidence: uniqueLinks([
      ...conflictClaims.slice(0, 2).map((c) => evidenceLink('claim', c.id, c.text)),
      ...contradicting.map((id) => evidenceLink('evidence', id, labelOf.get(id))),
      ...eventLinksFor(f, eventIds),
    ]),
    rationale: truncate(
      `On ${plural(eventIds.size, 'occasion')} work or statements continued on a hypothesis that evidence already on record contradicted.${first ? ` ${first.text}` : ''}`,
      800,
    ),
  };
}

function prematureEscalation(f: QualityFacts): PenaltyDraft | null {
  const required = f.pack.pack.policies.minimumEvidenceForEscalation;
  const hits: { index: number; unmet: string[] }[] = [];
  f.events.forEach((event, index) => {
    if (event.type !== 'escalation' && f.actionByEvent.get(event.id)?.kind !== 'escalation') return;
    const unmet = required.filter((id) => {
      const state = f.requirement(id);
      return !(state && isSatisfiedAt(state, index - 1));
    });
    if (unmet.length > 0) hits.push({ index, unmet });
  });
  const first = hits[0];
  const firstEvent = first ? f.events[first.index] : undefined;
  if (!first || !firstEvent) return null;
  const label = (id: string): string => f.pack.requirements.get(id)?.label ?? id;
  return {
    key: 'premature_escalation',
    dimension: 'scoping_completeness',
    instances: hits.length,
    forkIds: forkIdsFor(f, [firstEvent.id]),
    evidence: uniqueLinks([
      eventLink(firstEvent),
      ...first.unmet.map((id) => evidenceLink('requirement', id, label(id))),
    ]),
    rationale: truncate(
      `The case was escalated at ${formatUtcStamp(firstEvent.timestamp)} before the minimum evidence was on record. Still missing then: ${first.unmet.map(label).join('; ')}.`,
      800,
    ),
  };
}

function prematureClosure(f: QualityFacts): PenaltyDraft | null {
  const { closure, diagnosis } = f;
  if (!closure) return null;
  if (diagnosis !== null && diagnosis.index <= closure.index) return null;
  return {
    key: 'premature_closure',
    dimension: 'resolution_validation',
    instances: 1,
    forkIds: [],
    evidence: uniqueLinks(closure.event ? [eventLink(closure.event)] : []),
    rationale: `The case was closed at ${formatUtcStamp(closure.at)} although no hypothesis had been confirmed by evidence on record at that point.`,
  };
}

function unnecessaryCustomerRequest(f: QualityFacts): PenaltyDraft | null {
  const hits = f.actions.filter(
    (a) =>
      forkHas(f.forksByEvent.get(a.eventId), 'disproportionate_customer_effort') ||
      (a.isRepeat && a.kind === 'customer_request' && a.customerEffort !== 'none'),
  );
  const first = hits[0];
  if (!first) return null;
  return {
    key: 'unnecessary_customer_request',
    dimension: 'customer_communication',
    instances: hits.length,
    forkIds: forkIdsFor(
      f,
      hits.map((a) => a.eventId),
    ),
    evidence: uniqueLinks(hits.slice(0, 4).map((a) => evidenceLink('action', a.id, a.label))),
    rationale: truncate(
      `${plural(hits.length, 'request')} asked the customer for more effort than the information needed (first: “${first.label}” at ${formatUtcStamp(first.startedAt)}); a lighter or earlier-answered ask was available or the ask repeated an earlier one.`,
      800,
    ),
  };
}

function closureRequirementMissing(f: QualityFacts, requirementId: string): boolean {
  const { closure } = f;
  const state = f.requirement(requirementId);
  return closure !== null && state !== undefined && !isSatisfiedAt(state, closure.index);
}

function missingResolutionValidation(f: QualityFacts): PenaltyDraft | null {
  const { closure } = f;
  if (!closure || !closureRequirementMissing(f, CLOSURE_REQUIREMENT_IDS.fixValidation)) return null;
  return {
    key: 'missing_resolution_validation',
    dimension: 'resolution_validation',
    instances: 1,
    forkIds: [],
    evidence: uniqueLinks([
      ...(closure.event ? [eventLink(closure.event)] : []),
      evidenceLink('requirement', CLOSURE_REQUIREMENT_IDS.fixValidation),
    ]),
    rationale: `The case was closed at ${formatUtcStamp(closure.at)} without a before/after validation that the failures stopped.`,
  };
}

function workaroundFixConflation(f: QualityFacts): PenaltyDraft | null {
  const { closure, resolution } = f;
  if (!closure) return null;
  const mentionsWorkaround =
    (resolution?.workaround ?? null) !== null ||
    f.events.some((e) => f.pack.lexicon.workaround.some((re) => re.test(e.body)));
  const unseparated =
    mentionsWorkaround && closureRequirementMissing(f, CLOSURE_REQUIREMENT_IDS.workaroundVsFix);
  const onlyWorkaround =
    resolution !== null && resolution.workaround !== null && resolution.permanentFix === null;
  const sameText =
    resolution !== null &&
    resolution.workaround !== null &&
    resolution.permanentFix !== null &&
    tokenJaccard(resolution.workaround, resolution.permanentFix) >= 0.85;
  if (!unseparated && !onlyWorkaround && !sameText) return null;
  return {
    key: 'workaround_fix_conflation',
    dimension: 'resolution_validation',
    instances: 1,
    forkIds: [],
    evidence: uniqueLinks([
      ...(closure.event ? [eventLink(closure.event)] : []),
      evidenceLink('requirement', CLOSURE_REQUIREMENT_IDS.workaroundVsFix),
    ]),
    rationale: onlyWorkaround
      ? 'A workaround is recorded as the resolution and no permanent fix is documented, so the temporary measure may be mistaken for the cure.'
      : 'The workaround and the permanent fix are not stated separately in the closure record.',
  };
}

/** Runs the ten penalty rules over one view. Each fires at most once and links its evidence. */
export function detectPenalties(f: QualityFacts): PenaltyDraft[] {
  return [
    unsupportedRootCause(f),
    templateWithoutEvidence(f),
    repeatedLowValue(f),
    destructiveWithoutJustification(f),
    ignoredContradiction(f),
    prematureEscalation(f),
    prematureClosure(f),
    unnecessaryCustomerRequest(f),
    missingResolutionValidation(f),
    workaroundFixConflation(f),
  ].filter((p): p is PenaltyDraft => p !== null);
}
