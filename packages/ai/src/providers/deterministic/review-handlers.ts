import {
  FORK_CATEGORIES,
  type ClaimFlag,
  type ForkCategory,
  type Level,
  type QualityDimensionKey,
} from '@caseguard/schemas';
import { rankActions } from '@caseguard/domain';
import type { CoachingNote, CoachingNotes, QualityJudgement } from '../../agents/outputs';
import { MODEL_LIMITATION_NOTICE, NO_INDIVIDUAL_RANKING_NOTICE } from '../../agents/notices';
import type { CoachTaskInput, QualityTaskInput } from '../../agents/tasks';
import { scopeAnalysis, type ScopedAnalysis } from '../../context/scope';
import { AiTaskError } from '../../errors';
import { clip, isRecommendable, oneLine, unique, uncertainty } from './shared';

const FORK_DIMENSION: Record<ForkCategory, QualityDimensionKey> = {
  premature_destructive_action: 'diagnostic_reasoning',
  premature_escalation: 'scoping_completeness',
  assumption_as_fact: 'evidence_integrity',
  contradiction_ignored: 'diagnostic_reasoning',
  high_value_signal_unused: 'diagnostic_reasoning',
  disproportionate_customer_effort: 'efficiency_proportionality',
  low_value_action: 'efficiency_proportionality',
  alternative_action_available: 'diagnostic_reasoning',
};

const FLAG_DIMENSION: Record<ClaimFlag, QualityDimensionKey> = {
  unsupported_root_cause: 'evidence_integrity',
  assumption_as_fact: 'evidence_integrity',
  ignored_contradiction: 'diagnostic_reasoning',
  template_without_evidence: 'evidence_integrity',
  contradicted: 'evidence_integrity',
  unvalidated_closure: 'resolution_validation',
};

const FLAG_LABEL: Record<ClaimFlag, string> = {
  unsupported_root_cause: 'unsupported root cause',
  assumption_as_fact: 'assumption stated as fact',
  ignored_contradiction: 'contradiction not addressed',
  template_without_evidence: 'template wording without evidence',
  contradicted: 'contradicted statement',
  unvalidated_closure: 'closure without validation',
};

const FLAG_ADVICE: Record<ClaimFlag, string> = {
  unsupported_root_cause:
    'Back each root-cause statement with diagnostic evidence before presenting it as established.',
  assumption_as_fact:
    'Keep assumptions labelled as assumptions until a diagnostic result confirms them.',
  ignored_contradiction:
    'Acknowledge evidence that contradicts the working explanation and say how it was resolved.',
  template_without_evidence:
    'Replace checklist wording with the specific evidence that supports each statement.',
  contradicted: 'Reconcile statements that conflict and record which one the evidence supports.',
  unvalidated_closure:
    'Confirm the fix with a validation step and record the result before closing.',
};

const nonNull = <T>(value: T | null): value is T => value !== null;

function wellChosen(scoped: ScopedAnalysis) {
  return scoped.actions.filter(
    (a) => (a.relativeValueAtDecision ?? 0) >= 0.8 && !a.lowValue && !a.isRepeat,
  );
}

function flaggedGroups(scoped: ScopedAnalysis) {
  const groups = new Map<ClaimFlag, ScopedAnalysis['claims']>();
  for (const claim of scoped.claims) {
    for (const flag of claim.flags) groups.set(flag, [...(groups.get(flag) ?? []), claim]);
  }
  return [...groups].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1));
}

const severityOf = (count: number): Level => (count >= 3 ? 'high' : count === 2 ? 'medium' : 'low');

/** Qualitative, evidence-linked findings derived from the engine's forks, claim flags and open requirements. */
export function runQualityJudge(input: QualityTaskInput): QualityJudgement {
  const scoped = scopeAnalysis(input);
  const { pack, config } = input;
  const last = input.view.events[input.view.events.length - 1];
  if (!last) throw new AiTaskError('invalid_input', 'The temporal view contains no events.');
  const evidenceIds = new Set(scoped.evidence.map((e) => e.id));

  const findings: QualityJudgement['findings'] = [];
  const forks = [...scoped.forks]
    .sort((a, b) => b.impactScore - a.impactScore || (a.id < b.id ? -1 : 1))
    .slice(0, 8);
  for (const fork of forks) {
    const alt = fork.alternatives.find(
      (a) => a.safe && isRecommendable(pack.actions.get(a.actionKey), config.riskCeiling),
    );
    findings.push({
      dimension: FORK_DIMENSION[fork.category],
      severity: fork.severity,
      finding: clip(`${fork.title}. ${fork.summary}`, 500),
      eventIds: [fork.eventId],
      evidenceIds: fork.informationAvailable.evidenceIds
        .filter((id) => evidenceIds.has(id))
        .slice(0, 4),
      claimIds: [],
      suggestedImprovement: alt
        ? clip(`At this point consider “${alt.label}”: ${oneLine(alt.rationale, 220)}`, 400)
        : null,
      suggestedActionKey: alt ? alt.actionKey : null,
    });
  }
  for (const [flag, claims] of flaggedGroups(scoped)) {
    if (findings.length >= 18) break;
    const sample = claims.slice(0, 3);
    const first = sample[0];
    if (!first) continue;
    findings.push({
      dimension: FLAG_DIMENSION[flag],
      severity: severityOf(claims.length),
      finding: clip(
        `${claims.length} statement(s) were flagged as ${FLAG_LABEL[flag]}. Example: “${oneLine(first.text, 140)}”.`,
        500,
      ),
      eventIds: unique(sample.map((c) => c.eventId).filter(nonNull)),
      evidenceIds: [],
      claimIds: sample.map((c) => c.id),
      suggestedImprovement: FLAG_ADVICE[flag],
      suggestedActionKey: null,
    });
  }
  const open = scoped.missing.filter((m) => m.openAtBoundary && m.criticality === 'critical');
  if (open.length > 0 && findings.length < 20) {
    findings.push({
      dimension: 'scoping_completeness',
      severity: open.length >= 3 ? 'high' : 'medium',
      finding: clip(
        `At the latest recorded event, critical information was still missing: ${open.map((m) => m.label).join('; ')}.`,
        500,
      ),
      eventIds: [last.id],
      evidenceIds: [],
      claimIds: [],
      suggestedImprovement: clip(
        `Ask for: ${open.map((m) => oneLine(m.askText, 100)).join(' ')}`,
        400,
      ),
      suggestedActionKey: null,
    });
  }
  return {
    findings,
    strengths: wellChosen(scoped)
      .slice(0, 4)
      .map((a) => ({
        dimension: 'diagnostic_reasoning' as const,
        note: clip(
          `“${oneLine(a.label, 160)}” was a high-value, proportionate choice at the time.`,
          300,
        ),
        eventIds: [a.eventId],
        evidenceIds: [],
      })),
    limitations: [
      MODEL_LIMITATION_NOTICE,
      'Numeric scores come from the deterministic quality engine, not from this narrative.',
    ],
    uncertainty: uncertainty(
      'medium',
      'Findings describe the process using rule-based signals and are meant to focus a human review.',
    ),
  };
}

const note = (
  title: string,
  detail: string,
  refs: Partial<Pick<CoachingNote, 'eventIds' | 'evidenceIds' | 'claimIds'>>,
): CoachingNote => ({
  title: clip(title, 160),
  detail: clip(detail, 500),
  eventIds: refs.eventIds ?? [],
  evidenceIds: refs.evidenceIds ?? [],
  claimIds: refs.claimIds ?? [],
});

/** Constructive, non-punitive coaching notes built from the engine's artefacts. */
export function runCommunicationCoach(input: CoachTaskInput): CoachingNotes {
  const scoped = scopeAnalysis(input);
  const { pack, config } = input;
  const last = input.view.events[input.view.events.length - 1];
  if (!last) throw new AiTaskError('invalid_input', 'The temporal view contains no events.');
  const evidenceIds = new Set(scoped.evidence.map((e) => e.id));
  const forksBy = (...categories: ForkCategory[]) =>
    scoped.forks
      .filter((f) => categories.includes(f.category))
      .sort((a, b) => b.impactScore - a.impactScore);
  const forkNote = (title: string, fork: ScopedAnalysis['forks'][number]): CoachingNote => {
    const alt = fork.alternatives.find(
      (a) => a.safe && isRecommendable(pack.actions.get(a.actionKey), config.riskCeiling),
    );
    return note(
      title,
      `${fork.summary}${alt ? ` A safer option at that point: “${alt.label}”.` : ''}`,
      {
        eventIds: [fork.eventId],
        evidenceIds: fork.informationAvailable.evidenceIds
          .filter((id) => evidenceIds.has(id))
          .slice(0, 3),
      },
    );
  };

  const earliest =
    scoped.forks.find((f) => f.isEarliestMeaningful) ?? forksBy(...FORK_CATEGORIES)[0];
  const open = scoped.missing.filter((m) => m.openAtBoundary && m.criticality !== 'helpful');
  const communication = [
    ...forksBy('premature_escalation')
      .slice(0, 2)
      .map((f) => forkNote('Escalate once the minimum evidence is attached', f)),
    ...(open.length > 0
      ? [
          note(
            'Ask for what is still missing',
            `Still open: ${open
              .slice(0, 3)
              .map((m) => `${m.label} (${oneLine(m.askText, 90)})`)
              .join(' ')}`,
            { eventIds: [last.id] },
          ),
        ]
      : []),
  ].slice(0, 6);

  const ranked = rankActions(pack, config, scoped.state.rankingState).candidates;
  const next = ranked.find((e) => isRecommendable(e.action, config.riskCeiling));
  return {
    summary: clip(
      `Reviewed ${scoped.eventIds.size} events. ${scoped.forks.length > 0 ? `${scoped.forks.length} decision point(s) could have been handled differently.` : 'No decision point stood out as a missed opportunity.'} Notes describe the process and evidence, not the person.`,
      600,
    ),
    wentWell: wellChosen(scoped)
      .slice(0, 3)
      .map((a) =>
        note(
          'A well-chosen step',
          `“${oneLine(a.label, 160)}” gave useful information at a proportionate cost.`,
          { eventIds: [a.eventId] },
        ),
      ),
    missedOpportunity: earliest ? forkNote('Most important missed opportunity', earliest) : null,
    evidenceQuality: flaggedGroups(scoped)
      .slice(0, 4)
      .flatMap(([flag, claims]) => {
        const claim = claims[0];
        if (!claim || claim.eventId === null) return [];
        return [
          note(
            'A statement needs support',
            `“${oneLine(claim.text, 160)}” was recorded as ${FLAG_LABEL[flag]}. ${FLAG_ADVICE[flag]}`,
            { eventIds: [claim.eventId], claimIds: [claim.id] },
          ),
        ];
      }),
    reasoningImprovements: forksBy(
      'contradiction_ignored',
      'high_value_signal_unused',
      'assumption_as_fact',
      'alternative_action_available',
    )
      .slice(0, 3)
      .map((f) => forkNote('Test the leading explanation before acting on it', f)),
    communicationImprovements: communication,
    customerEffortImprovements: forksBy('disproportionate_customer_effort')
      .slice(0, 3)
      .map((f) => forkNote('Match the size of the request to its value', f)),
    recommendedNextActionKey: next ? next.action.id : null,
    limitations: [MODEL_LIMITATION_NOTICE, NO_INDIVIDUAL_RANKING_NOTICE],
    uncertainty: uncertainty(
      'medium',
      'Coaching notes use rule-based signals and a model-estimated diagnosis; discuss them rather than treating them as a verdict.',
    ),
  };
}
