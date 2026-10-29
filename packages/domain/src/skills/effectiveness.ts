import type { Range, SkillEffectiveness } from '@caseguard/schemas';
import { clamp, mean, rangeOf, round } from '../util/math';

/**
 * One recorded use of a skill on one case. It deliberately carries no person identifiers: effectiveness
 * is aggregated per skill and never per engineer.
 */
export interface SkillUsageRecord {
  skillId: string;
  versionId: string;
  caseId: string;
  synthetic: boolean;
  matched: boolean;
  applied: boolean;
  suggestionsOffered: number;
  suggestionsAccepted: number;
  /** Recorded minutes from the first step to diagnosis, when the case reached one. */
  timeToDiagnosisMinutes: number | null;
  /** Estimated minutes without the skill (for example the median of an impact estimate). */
  baselineTimeToDiagnosisMinutes: number | null;
  tokenEstimate: number | null;
  baselineTokenEstimate: number | null;
  /** Share (0-1) of the minimum-evidence items held at diagnosis, recorded and estimated baseline. */
  evidenceCompleteness: number | null;
  baselineEvidenceCompleteness: number | null;
  conformanceScore: number | null;
}

export interface SkillEffectivenessReport {
  /** The persistable contract shape (`SkillDna.effectiveness`). */
  effectiveness: SkillEffectiveness;
  adoption: { matchedCases: number; appliedCases: number; adoptionRate: number | null };
  suggestionAcceptance: { offered: number; accepted: number; rate: number | null };
  estimatedTimeSaved: {
    casesCompared: number;
    perCaseMinutes: Range | null;
    estimated: true;
    note: string;
  };
  evidenceCompletenessUplift: {
    casesCompared: number;
    meanPoints: number | null;
    estimated: true;
  };
  confidence: { level: 'low' | 'medium' | 'high'; score: number; rationale: string };
  privacy: { personalData: false; aggregation: 'per_skill'; note: string };
  estimated: true;
  synthetic: boolean;
  notices: string[];
}

const average = (values: readonly number[]): number | null =>
  values.length === 0 ? null : round(mean(values), 2);

const numbers = (values: readonly (number | null)[]): number[] =>
  values.filter((v): v is number => v !== null);

/**
 * Aggregates usage records into adoption, suggestion acceptance, estimated time saved and evidence
 * completeness uplift. Deterministic, per skill, with explicit "estimated" labels and a confidence
 * that stays low until many cases back it. One record per (skill, version, case) is counted.
 */
export function aggregateSkillEffectiveness(
  records: readonly SkillUsageRecord[],
  options: { skillId?: string } = {},
): SkillEffectivenessReport {
  const scoped = options.skillId ? records.filter((r) => r.skillId === options.skillId) : records;
  const latest = new Map<string, SkillUsageRecord>();
  for (const r of scoped) latest.set(`${r.skillId}|${r.versionId}|${r.caseId}`, r);
  const rows = [...latest.values()];
  const matched = rows.filter((r) => r.matched || r.applied);
  const applied = rows.filter((r) => r.applied);
  const offered = applied.reduce((s, r) => s + r.suggestionsOffered, 0);
  const accepted = applied.reduce(
    (s, r) => s + Math.min(r.suggestionsAccepted, r.suggestionsOffered),
    0,
  );

  const timed = applied.filter((r) => r.timeToDiagnosisMinutes !== null);
  const saved = applied
    .filter((r) => r.timeToDiagnosisMinutes !== null && r.baselineTimeToDiagnosisMinutes !== null)
    .map((r) => (r.baselineTimeToDiagnosisMinutes ?? 0) - (r.timeToDiagnosisMinutes ?? 0));
  const savedRange = saved.length === 0 ? null : rangeOf(saved);
  const tokenPairs = applied.filter(
    (r) => r.tokenEstimate !== null && r.baselineTokenEstimate !== null,
  );
  const baselineTokens = tokenPairs.reduce((s, r) => s + (r.baselineTokenEstimate ?? 0), 0);
  const actualTokens = tokenPairs.reduce((s, r) => s + (r.tokenEstimate ?? 0), 0);
  const evidencePairs = applied.filter(
    (r) => r.evidenceCompleteness !== null && r.baselineEvidenceCompleteness !== null,
  );
  const uplift = evidencePairs.map(
    (r) => ((r.evidenceCompleteness ?? 0) - (r.baselineEvidenceCompleteness ?? 0)) * 100,
  );
  const synthetic = rows.length > 0 && rows.every((r) => r.synthetic);
  const n = applied.length;
  const score = round(clamp(n / 20, 0, 0.9), 2);
  const level: 'low' | 'medium' | 'high' = n < 5 ? 'low' : n < 20 ? 'medium' : 'high';

  const effectiveness: SkillEffectiveness = {
    applications: n,
    matchedCases: matched.length,
    avgTimeToDiagnosisMinutes: average(numbers(timed.map((r) => r.timeToDiagnosisMinutes))),
    baselineAvgTimeToDiagnosisMinutes: average(
      numbers(
        applied
          .filter((r) => r.timeToDiagnosisMinutes !== null)
          .map((r) => r.baselineTimeToDiagnosisMinutes),
      ),
    ),
    conformanceAvg: (() => {
      const values = numbers(applied.map((r) => r.conformanceScore));
      return values.length === 0 ? null : round(clamp(mean(values), 0, 1), 3);
    })(),
    estimatedTokenSavingsPct:
      baselineTokens > 0
        ? round(((baselineTokens - actualTokens) / baselineTokens) * 100, 1)
        : null,
    notes: [
      n === 0
        ? 'No applications recorded yet.'
        : `Estimated from ${n} recorded application${n === 1 ? '' : 's'}; figures are model estimates, not measurements.`,
      'No engineer-level data is used: usage is aggregated per skill.',
    ],
    synthetic,
    estimated: true,
  };
  return {
    effectiveness,
    adoption: {
      matchedCases: matched.length,
      appliedCases: n,
      adoptionRate: matched.length === 0 ? null : round(n / matched.length, 3),
    },
    suggestionAcceptance: {
      offered,
      accepted,
      rate: offered === 0 ? null : round(accepted / offered, 3),
    },
    estimatedTimeSaved: {
      casesCompared: saved.length,
      perCaseMinutes: savedRange
        ? {
            low: round(savedRange.low, 1),
            mid: round(savedRange.mid, 1),
            high: round(savedRange.high, 1),
          }
        : null,
      estimated: true,
      note:
        saved.length < 3
          ? 'Fewer than three cases compared: the spread is not meaningful yet.'
          : 'Range across compared cases (10th to 90th percentile of the estimated saving per case).',
    },
    evidenceCompletenessUplift: {
      casesCompared: uplift.length,
      meanPoints: uplift.length === 0 ? null : round(mean(uplift), 1),
      estimated: true,
    },
    confidence: {
      level,
      score,
      rationale: `${n} applied case${n === 1 ? '' : 's'}${synthetic ? ', all synthetic' : ''}; estimates come from simulated baselines without a control group.`,
    },
    privacy: {
      personalData: false,
      aggregation: 'per_skill',
      note: 'Records contain no user or engineer identifiers; only per-skill aggregates are produced.',
    },
    estimated: true,
    synthetic,
    notices: [
      'Effectiveness figures are estimates and are labelled as such wherever they are shown.',
      synthetic
        ? 'Every contributing case is synthetic: the figures demonstrate the pipeline only.'
        : 'Figures describe recorded applications only and are not a controlled comparison.',
    ],
  };
}
