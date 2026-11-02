import type { Claim, ClaimFlag } from '@caseguard/schemas';
import { makeCheck, makeDimension, undecided } from './checks';
import type { QualityFacts } from './facts';
import { eventLink, evidenceLink, plural } from './links';
import type { DimensionDraft } from './types';

const ASSERTION_FLAGS: readonly ClaimFlag[] = [
  'assumption_as_fact',
  'unsupported_root_cause',
  'template_without_evidence',
];
const AS_FACT_FLAGS: readonly ClaimFlag[] = ['assumption_as_fact', 'unsupported_root_cause'];
const REASONING_FLAGS: readonly ClaimFlag[] = [
  'assumption_as_fact',
  'unsupported_root_cause',
  'ignored_contradiction',
  'contradicted',
];

const hasFlag = (claim: Claim, flags: readonly ClaimFlag[]): boolean =>
  claim.flags.some((f) => flags.includes(f));

const claimLink = (claim: Claim) => evidenceLink('claim', claim.id, claim.text);

/** Evidence integrity: conclusions backed by evidence, assumptions labelled, contradictions heard. */
export function evidenceIntegrity(f: QualityFacts): DimensionDraft {
  const { params } = f;
  const statements = f.statementClaims;
  const flagged = statements.filter((c) => hasFlag(c, ASSERTION_FLAGS));
  const asFact = statements.filter((c) => hasFlag(c, AS_FACT_FLAGS));
  // What carries a pass when nothing was flagged: the conclusions that cite diagnostic evidence, and
  // the statements that said they were assumptions.
  const backed = statements.filter(
    (c) => c.category === 'confirmed_fact' && c.supportingEvidenceIds.length > 0,
  );
  const labelled = statements.filter(
    (c) => c.category === 'engineer_assumption' && c.flags.length === 0,
  );
  const anchorEvents = [...new Set(f.analysis.anchors.map((a) => a.eventId))];
  const haveStatements = statements.length > 0;

  const claimsCheck = haveStatements
    ? makeCheck({
        id: 'EI-1',
        label: 'Conclusions are backed by diagnostic evidence',
        weight: 0.3,
        score: 1 - flagged.length * params.unsupportedClaimSlope,
        note:
          flagged.length === 0
            ? 'No statement presented a cause or a checklist result as established without evidence.'
            : `${plural(flagged.length, 'statement')} presented a cause or a checklist result as established without cited diagnostic evidence.`,
        evidence: (flagged.length > 0 ? flagged.slice(0, 4) : backed.slice(0, 3)).map(claimLink),
      })
    : undecided(
        'EI-1',
        'Conclusions are backed by diagnostic evidence',
        0.3,
        'No engineer statements yet.',
      );

  const contradictionCheck = haveStatements
    ? makeCheck({
        id: 'EI-2',
        label: 'Contradicting evidence is acknowledged',
        weight: 0.25,
        score: 1 - anchorEvents.length * params.contradictionSlope,
        note:
          anchorEvents.length === 0
            ? 'No working hypothesis was kept after the evidence on record had turned against it.'
            : `On ${plural(anchorEvents.length, 'occasion')} work continued on a hypothesis that the evidence on record already contradicted.`,
        evidence: anchorEvents.slice(0, 4).flatMap((id) => {
          const event = f.events[f.indexOf.get(id) ?? -1];
          return event ? [eventLink(event)] : [];
        }),
      })
    : undecided(
        'EI-2',
        'Contradicting evidence is acknowledged',
        0.25,
        'No engineer statements yet.',
      );

  const labelledCheck = haveStatements
    ? makeCheck({
        id: 'EI-3',
        label: 'Assumptions are labelled as assumptions',
        weight: 0.15,
        score: 1 - asFact.length / statements.length,
        note: `${asFact.length} of ${statements.length} engineer statements were written as established fact without support; the rest were hedged or backed by evidence.`,
        evidence: (asFact.length > 0 ? asFact.slice(0, 3) : labelled.slice(0, 3)).map(claimLink),
      })
    : undecided(
        'EI-3',
        'Assumptions are labelled as assumptions',
        0.15,
        'No engineer statements yet.',
      );

  const closureClaims = statements.filter((c) => {
    const event = f.events[f.indexOf.get(c.eventId ?? '') ?? -1];
    return event?.type === 'resolution_note' || event?.type === 'validation_result';
  });
  const supported = closureClaims.filter(
    (c) =>
      c.category === 'confirmed_fact' && !hasFlag(c, [...ASSERTION_FLAGS, 'unvalidated_closure']),
  );
  const unsupported = closureClaims.filter((c) => !supported.includes(c));
  // A supported conclusion rests on the validation on record: the messages that state it and the
  // requirement that was met, not the sentences themselves (those are in the messages).
  const validationId = f.pack.pack.policies.validationRequirementId;
  const supportingLinks = [
    ...new Set(supported.flatMap((c) => (c.eventId === null ? [] : [c.eventId]))),
  ].flatMap((id) => {
    const event = f.events[f.indexOf.get(id) ?? -1];
    return event ? [eventLink(event)] : [];
  });
  if (validationId) {
    supportingLinks.push(
      evidenceLink('requirement', validationId, f.pack.requirements.get(validationId)?.label),
    );
  }
  const conclusionCheck =
    closureClaims.length > 0
      ? makeCheck({
          id: 'EI-4',
          label: 'The recorded conclusion is supported',
          weight: 0.3,
          score: supported.length / closureClaims.length,
          note: `${supported.length} of ${closureClaims.length} closure statements were backed by validation evidence on record.`,
          evidence:
            unsupported.length > 0
              ? unsupported.slice(0, 3).map(claimLink)
              : supported.length > 0
                ? supportingLinks
                : [],
        })
      : undecided(
          'EI-4',
          'The recorded conclusion is supported',
          0.3,
          'No resolution or validation statement is in this view yet.',
        );

  return makeDimension(
    'evidence_integrity',
    [claimsCheck, contradictionCheck, labelledCheck, conclusionCheck],
    params.uncertaintyMargin,
    '',
  );
}

/** Diagnostic reasoning: sound decisions, a working hypothesis that follows the evidence, safe order. */
export function diagnosticReasoning(f: QualityFacts): DimensionDraft {
  const { params, analysis } = f;
  const decisionIds = new Set<string>();
  for (const a of f.actions) decisionIds.add(a.eventId);
  for (const c of f.statementClaims) {
    if (c.eventId && hasFlag(c, REASONING_FLAGS)) decisionIds.add(c.eventId);
  }
  for (const anchor of analysis.anchors) decisionIds.add(anchor.eventId);
  const forked = [...decisionIds].flatMap((id) => {
    const fork = f.forksByEvent.get(id);
    return fork ? [fork] : [];
  });
  const impact = forked.reduce((s, fork) => s + fork.impactScore, 0);
  // With no decision point to point at, the decisions that came closest to the best safe alternative.
  const soundest = [...f.actions]
    .filter((a) => a.relativeValueAtDecision !== null && !f.forksByEvent.has(a.eventId))
    .sort(
      (a, b) =>
        (b.relativeValueAtDecision ?? 0) - (a.relativeValueAtDecision ?? 0) ||
        a.sequence - b.sequence,
    );

  const decisionsCheck =
    decisionIds.size > 0
      ? makeCheck({
          id: 'DR-1',
          label: 'Decisions were sound at the time they were made',
          weight: 0.4,
          score: 1 - impact / decisionIds.size,
          note: `${forked.length} of ${decisionIds.size} decision points had a clearly better safe alternative on record at that moment (impact-weighted).`,
          evidence:
            forked.length > 0
              ? [...forked]
                  .sort((a, b) => b.impactScore - a.impactScore)
                  .slice(0, 4)
                  .map((fork) => evidenceLink('fork', fork.id, fork.title))
              : soundest.slice(0, 3).map((a) => evidenceLink('action', a.id, a.label)),
        })
      : undecided(
          'DR-1',
          'Decisions were sound at the time they were made',
          0.4,
          'No decisions yet.',
        );

  const beliefEvents = new Set(
    f.statementClaims.flatMap((c) =>
      c.eventId && c.relatedHypothesisIds.length > 0 ? [c.eventId] : [],
    ),
  );
  const anchoredEvents = new Set(analysis.anchors.map((a) => a.eventId));
  const trackingCheck =
    beliefEvents.size > 0
      ? makeCheck({
          id: 'DR-2',
          label: 'The working hypothesis followed the evidence',
          weight: 0.3,
          score: 1 - Math.min(1, anchoredEvents.size / beliefEvents.size),
          note: `${anchoredEvents.size} of ${beliefEvents.size} statements about the cause kept a hypothesis the evidence had already turned against.`,
          evidence: [...anchoredEvents].slice(0, 4).flatMap((id) => {
            const event = f.events[f.indexOf.get(id) ?? -1];
            return event ? [eventLink(event)] : [];
          }),
        })
      : undecided(
          'DR-2',
          'The working hypothesis followed the evidence',
          0.3,
          'No statements about the cause yet.',
        );

  const risky = f.actions.filter(
    (a) =>
      a.destructive ||
      a.operationalRisk >= f.actionConfig.riskCeiling ||
      (a.actionKey !== null && f.pack.actions.get(a.actionKey)?.valueClass === 'remediation'),
  );
  const unjustified = risky.filter((a) => {
    const fork = f.forksByEvent.get(a.eventId);
    return (
      fork !== undefined &&
      (fork.category === 'premature_destructive_action' ||
        fork.additionalCategories.includes('premature_destructive_action'))
    );
  });
  const sequencingCheck =
    f.actions.length > 0
      ? makeCheck({
          id: 'DR-3',
          label: 'Risky changes followed a justified diagnosis',
          weight: 0.3,
          score:
            risky.length === 0
              ? 1
              : 1 - params.unjustifiedRiskSlope * (unjustified.length / risky.length),
          note:
            risky.length === 0
              ? 'No risky or disruptive change was made.'
              : `${unjustified.length} of ${plural(risky.length, 'risky or disruptive step')} came before the targeted hypothesis was justified by evidence.`,
          evidence: (unjustified.length > 0 ? unjustified : risky)
            .slice(0, 4)
            .map((a) => evidenceLink('action', a.id, a.label)),
        })
      : undecided('DR-3', 'Risky changes followed a justified diagnosis', 0.3, 'No actions yet.');

  return makeDimension(
    'diagnostic_reasoning',
    [decisionsCheck, trackingCheck, sequencingCheck],
    params.uncertaintyMargin,
    '',
  );
}
