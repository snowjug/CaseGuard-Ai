import {
  PENALTY_LABELS,
  type DecisionFork,
  type Improvement,
  type PenaltyKey,
  type Priority,
  type QualityAssessment,
  type SubCheck,
} from '@caseguard/schemas';
import { stableId } from '../util/ids';
import { clamp, round } from '../util/math';
import { truncate, uniqueLinks } from './links';
import type { QualityFacts } from './facts';
import type { ComposedScore } from './score';
import type { DimensionDraft, PenaltyDraft } from './types';

/** Sub-checks whose defect is already priced by a named penalty; they are not listed twice. */
const COVERED_BY_PENALTY: Readonly<Record<string, PenaltyKey>> = {
  'EI-1': 'unsupported_root_cause',
  'EI-2': 'ignored_contradiction',
  'DR-3': 'destructive_action_without_justification',
  'SC-3': 'premature_escalation',
  'EF-1': 'repeated_low_value_diagnostic',
  'EF-2': 'unnecessary_customer_request',
  'RV-1': 'missing_resolution_validation',
  'RV-3': 'workaround_fix_conflation',
  'RV-4': 'premature_closure',
};

interface Advice {
  title: string;
  detail: string;
}

const CHECK_ADVICE: Readonly<Record<string, Advice>> = {
  'EI-1': {
    title: 'Back conclusions with diagnostic evidence',
    detail:
      'Keep statements about the cause hedged until diagnostic evidence supports them, and cite that evidence when stating a conclusion.',
  },
  'EI-3': {
    title: 'Label assumptions as assumptions',
    detail:
      'Use wording such as “working hypothesis” for beliefs, and reserve statements of fact for what the evidence on record supports.',
  },
  'EI-4': {
    title: 'Support the recorded conclusion',
    detail:
      'Cite the validation evidence that backs the root cause and the fix in the closure note.',
  },
  'DR-1': {
    title: 'Choose the highest-value safe step at each decision',
    detail:
      'Before each step, compare it with the best-ranked safe alternative for the evidence on record and prefer the step that tests the leading hypotheses at the lowest cost.',
  },
  'DR-2': {
    title: 'Revisit the working hypothesis when new evidence arrives',
    detail:
      'After each new result, restate which hypothesis the evidence now favours and whether the plan still tests it.',
  },
  'SC-1': {
    title: 'Capture scope, impact and key identifiers early',
    detail:
      'Confirm who and how many are affected, the exact error, sample users and UTC failure times in the first exchange.',
  },
  'SC-2': {
    title: 'Open with a minimal, targeted request to the customer',
    detail:
      'Ask first for the few items that unlock log correlation (error text, sample users, UTC failure times) and hold heavier captures until cheaper checks have been used.',
  },
  'CC-1': {
    title: 'Reply to the customer promptly',
    detail:
      'Acknowledge the case and say what happens next soon after it opens, even before the first result is in.',
  },
  'CC-2': {
    title: 'Set expectations in every message to the customer',
    detail:
      'End each message with what you will do next and when the customer will hear from you again.',
  },
  'CC-3': {
    title: 'Answer customer messages that expect a reply sooner',
    detail:
      'When the customer asks a question or for news, reply within a few hours, even with a short status update.',
  },
  'CC-4': {
    title: 'Send proactive updates so the customer does not have to chase',
    detail:
      'Agree an update rhythm and keep to it, so the customer is never left asking what is happening.',
  },
  'EF-3': {
    title: 'Turn strong evidence into a confirmation test sooner',
    detail:
      'When one hypothesis clearly leads, run the cheapest test that would confirm or rule it out instead of continuing broader collection.',
  },
};

const PENALTY_ADVICE: Readonly<Record<PenaltyKey, Advice>> = {
  unsupported_root_cause: {
    title: 'Write causes as hypotheses until evidence supports them',
    detail:
      'State the cause as a working hypothesis and cite the diagnostic evidence for it; run the cheapest test that would confirm it before presenting it as established.',
  },
  template_completion_without_evidence: {
    title: 'Replace checklist wording with the evidence itself',
    detail:
      'Record what was observed (the query, the result, the time) rather than a statement that a checklist was completed.',
  },
  repeated_low_value_diagnostic: {
    title: 'Check the record before repeating a diagnostic',
    detail:
      'Before re-running a query or re-asking for data, look at what the earlier result already showed and choose a step that adds new information.',
  },
  destructive_action_without_justification: {
    title: 'Hold disruptive changes until the cause is confirmed',
    detail:
      'Reserve session revocations and policy exclusions for after the targeted hypothesis is supported by evidence; use read-only checks first.',
  },
  ignored_contradiction: {
    title: 'Reconcile contradicting evidence before continuing',
    detail:
      'When a result favours a different explanation, say so explicitly and test the better-supported hypothesis before continuing on the earlier one.',
  },
  premature_escalation: {
    title: 'Collect the minimum evidence before escalating',
    detail:
      'Attach the minimum evidence set (error, sample users, failure times and the server-side correlation result) so the receiving team can act immediately.',
  },
  premature_closure: {
    title: 'Confirm the diagnosis before closing',
    detail: 'Close only after a hypothesis has been confirmed by evidence on record.',
  },
  unnecessary_customer_request: {
    title: 'Prefer the lightest request that answers the question',
    detail:
      'Ask the customer for the smallest, most targeted data first, and do not repeat a request whose answer is already on record.',
  },
  missing_resolution_validation: {
    title: 'Validate the fix before closing',
    detail:
      'Compare failures before and after the change over a monitoring window and record the result.',
  },
  workaround_fix_conflation: {
    title: 'State the workaround and the permanent fix separately',
    detail:
      'Record the temporary measure and the permanent correction as two items, with an owner for the permanent fix.',
  },
};

const priorityOf = (gain: number): Priority =>
  gain >= 6 ? 'critical' : gain >= 4 ? 'high' : gain >= 2 ? 'medium' : 'low';

/** The best safe alternative at the linked decision, in plain words (decision-time data only). */
function alternativeHint(fork: DecisionFork | undefined): string {
  const alt = fork?.alternatives.find((a) => a.safe);
  if (!alt) return '';
  return ` At that moment a safer, higher-value step was available: “${alt.label}” (about ${Math.round(alt.timeMinutes)} minutes, ${alt.customerEffort.replace('_', ' ')} customer effort).`;
}

/** A detected penalty together with its configured points. */
export type PricedPenalty = PenaltyDraft & { points: number };

export interface ImprovementPlan {
  improvements: Improvement[];
  estimatedAfter: QualityAssessment['estimatedScoreAfterImprovements'];
}

/** Composite points gained by lifting one sub-check to full marks. */
const checkGain = (check: SubCheck, dimensionWeight: number, decidedWeight: number): number =>
  dimensionWeight * (check.weight / decidedWeight) * (1 - check.score) * 100;

/**
 * Turns applied penalties and weak sub-checks into recommended improvements with an estimated
 * composite gain each, and an estimate of the score if they were applied.
 */
export function buildImprovements(input: {
  facts: QualityFacts;
  dimensions: readonly DimensionDraft[];
  penalties: readonly PricedPenalty[];
  composed: ComposedScore;
  caseId: string;
}): ImprovementPlan {
  const { facts, dimensions, penalties, composed, caseId } = input;
  const { params } = facts;
  const forkById = new Map(facts.analysis.forks.map((f) => [f.id, f]));
  const applied = new Set(penalties.map((p) => p.key));
  const candidates: Improvement[] = [];

  for (const penalty of penalties) {
    const advice = PENALTY_ADVICE[penalty.key];
    const fork = penalty.forkIds.map((id) => forkById.get(id)).find((f) => f !== undefined);
    const gain = penalty.points * composed.capScale;
    candidates.push({
      id: stableId('imp', caseId, penalty.key),
      title: advice.title,
      description: truncate(
        `${PENALTY_LABELS[penalty.key]}: ${advice.detail}${alternativeHint(fork)}`,
        800,
      ),
      expectedScoreGain: round(gain, 1),
      priority: priorityOf(gain),
      linkedPenaltyKey: penalty.key,
      linkedForkId: fork?.id ?? penalty.forkIds[0] ?? null,
      evidence: uniqueLinks(penalty.evidence, 6),
    });
  }

  for (const dimension of dimensions) {
    const weight = composed.dimensions.find((d) => d.key === dimension.key)?.weight ?? 0;
    const decided = dimension.subChecks.filter((c) => c.determinable);
    const decidedWeight = decided.reduce((s, c) => s + c.weight, 0);
    if (weight <= 0 || decidedWeight <= 0) continue;
    for (const check of decided) {
      const covering = COVERED_BY_PENALTY[check.id];
      const advice = CHECK_ADVICE[check.id];
      if (!advice || check.score >= 0.7) continue;
      if (covering !== undefined && applied.has(covering)) continue;
      const gain = checkGain(check, weight, decidedWeight);
      candidates.push({
        id: stableId('imp', caseId, check.id),
        title: advice.title,
        description: truncate(`${advice.detail} Observed: ${check.note}`, 800),
        expectedScoreGain: round(gain, 1),
        priority: priorityOf(gain),
        linkedPenaltyKey: null,
        linkedForkId: null,
        evidence: uniqueLinks(check.evidence, 6),
      });
    }
  }

  // Candidates are listed in a fixed order (penalties, then weak checks by dimension), so a stable sort
  // keeps equal gains in that order; breaking the tie by `id` would order them by a hash of the case id.
  const improvements = candidates
    .filter((c) => c.expectedScoreGain >= params.minImprovementGain)
    .sort((a, b) => b.expectedScoreGain - a.expectedScoreGain)
    .slice(0, 8);

  const total = improvements.reduce((s, i) => s + i.expectedScoreGain, 0);
  const realized = params.improvementRealization;
  const base = composed.composite;
  const mid = clamp(base + realized * total, base, 100);
  const high = clamp(base + total, mid, 100);
  const low = clamp(base + (realized / 2) * total, base, mid);
  return {
    improvements,
    estimatedAfter: {
      score: round(mid, 1),
      low: round(low, 1),
      high: round(high, 1),
      method:
        improvements.length === 0
          ? 'No improvement was recommended, so the estimate equals the current score.'
          : `Assumes each listed improvement is applied: the penalty it addresses is removed and the check it targets reaches full marks. ${Math.round(realized * 100)}% of that gain is assumed to materialise (range: half of that to the full gain, capped at 100). An estimate for planning, not a prediction.`,
    },
  };
}
