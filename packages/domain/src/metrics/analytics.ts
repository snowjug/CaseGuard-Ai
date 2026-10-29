import {
  FORK_CATEGORIES,
  RESPONSIBLE_USE_NOTICE,
  type AnalyticsOverview,
  type ForkCategory,
  type ReviewState,
  type SkillDna,
} from '@caseguard/schemas';
import { clamp, mean, round } from '../util/math';

/** Subject used when an unsupported statement carries no attribute key; never the statement text. */
export const GENERIC_ASSUMPTION_SUBJECT = 'Cause stated as established without supporting evidence';

export interface AnalyticsInput {
  cases: {
    id: string;
    synthetic: boolean;
    analysisState: string;
    openedAt: string;
  }[];
  quality: {
    caseId: string;
    analyzedAt: string;
    compositeScore: number;
    evidenceIntegrity: number;
  }[];
  forks: { caseId: string; category: string }[];
  missing: { caseId: string; requirementId: string; label: string; resolved: boolean }[];
  metrics: {
    caseId: string;
    key: string;
    value: number | null;
    ase: { components: { key: string; label: string; avoidablePct: number }[] } | null;
  }[];
  /** Only `subject` is read: statement text never reaches the overview. */
  assumptionFlags: { caseId: string; subject: string | null }[];
  scenarios: {
    caseId: string;
    reviewState: ReviewState;
    counterfactualTokens: number;
    actualTokens: number;
  }[];
  skills: Pick<SkillDna, 'id' | 'name' | 'lifecycle' | 'effectiveness' | 'synthetic'>[];
  matches: { caseId: string; skillId: string; applied: boolean }[];
  /** Claim-review statistics (reviewer corrections), when available. */
  reviewStats?: { reviewedClaims: number; correctedClaims: number };
}

export interface AnalyticsOptions {
  /** Injected clock for the `generatedAt` stamp. */
  now: string;
  /** Trend bucket size; months by default. */
  period?: 'day' | 'week' | 'month';
  /** Groups smaller than this are left out (privacy); 1 keeps everything. */
  minCellSize?: number;
  /** Count requirements that were eventually collected as well as those still missing. */
  includeResolvedMissing?: boolean;
  /** Maximum rows in each ranked list. */
  topN?: number;
}

function periodOf(iso: string, period: 'day' | 'week' | 'month'): string {
  if (period === 'day') return iso.slice(0, 10);
  if (period === 'month') return iso.slice(0, 7);
  const date = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  const day = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - day);
  return `${date.toISOString().slice(0, 10)} (week)`;
}

const avg = (xs: readonly number[]): number | null => (xs.length === 0 ? null : round(mean(xs), 1));

function countBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of items) out.set(keyOf(item), (out.get(keyOf(item)) ?? 0) + 1);
  return out;
}

const byCountThenName = (a: [string, number], b: [string, number]): number =>
  b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

/**
 * Privacy-safe portfolio analytics (spec 5.16): trends, evidence integrity, fork categories,
 * missing evidence, avoidable-effort patterns, skill adoption and effectiveness, token efficiency,
 * counterfactual acceptance, reviewer disagreement and frequent unsupported assumptions. Only
 * counts, averages and pack labels are emitted: no case text, names or participant identities, and
 * nothing is ranked per person. Pure and deterministic.
 */
export function buildAnalyticsOverview(
  input: AnalyticsInput,
  options: AnalyticsOptions,
): AnalyticsOverview {
  const period = options.period ?? 'month';
  const minCell = Math.max(1, options.minCellSize ?? 1);
  const topN = options.topN ?? 10;
  const caseById = new Map(input.cases.map((c) => [c.id, c]));

  const analyzed = input.cases.filter((c) => c.analysisState === 'analyzed');
  const synthetic = input.cases.filter((c) => c.synthetic);

  // Trend: one bucket per case-opening period (cases without a case row fall back to analysis time).
  const buckets = new Map<string, { quality: number[]; integrity: number[] }>();
  for (const row of input.quality) {
    const key = periodOf(caseById.get(row.caseId)?.openedAt ?? row.analyzedAt, period);
    const bucket = buckets.get(key) ?? { quality: [], integrity: [] };
    bucket.quality.push(row.compositeScore);
    bucket.integrity.push(row.evidenceIntegrity);
    buckets.set(key, bucket);
  }
  const qualityTrend = [...buckets.entries()]
    .filter(([, b]) => b.quality.length >= minCell)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([periodKey, b]) => ({
      period: periodKey,
      caseCount: b.quality.length,
      avgQuality: avg(b.quality),
      avgEvidenceIntegrity: avg(b.integrity),
    }));

  const knownCategory = (c: string): c is ForkCategory => FORK_CATEGORIES.some((x) => x === c);
  const forkCounts = countBy(
    input.forks.filter((f) => knownCategory(f.category)),
    (f) => f.category,
  );
  const forkTotal = [...forkCounts.values()].reduce((s, n) => s + n, 0);
  const forkCategories = [...forkCounts.entries()]
    .filter(([, n]) => n >= minCell)
    .sort(byCountThenName)
    .flatMap(([category, count]) =>
      knownCategory(category)
        ? [{ category, count, share: round(forkTotal > 0 ? count / forkTotal : 0, 3) }]
        : [],
    );

  const missingRows = input.missing.filter(
    (m) => options.includeResolvedMissing === true || !m.resolved,
  );
  const missingGroups = new Map<string, { label: string; cases: Set<string>; count: number }>();
  for (const row of missingRows) {
    const g = missingGroups.get(row.requirementId) ?? {
      label: row.label,
      cases: new Set(),
      count: 0,
    };
    g.cases.add(row.caseId);
    g.count += 1;
    missingGroups.set(row.requirementId, g);
  }
  const missingEvidence = [...missingGroups.entries()]
    .filter(([, g]) => g.cases.size >= minCell)
    .sort((a, b) => b[1].cases.size - a[1].cases.size || (a[0] < b[0] ? -1 : 1))
    .slice(0, topN)
    .map(([requirementId, g]) => ({ requirementId, label: g.label, count: g.cases.size }));

  const aseRows = input.metrics.filter(
    (m) => m.key === 'avoidable_support_effort' && m.value !== null && m.ase !== null,
  );
  const components = new Map<string, { label: string; values: number[] }>();
  for (const row of aseRows) {
    for (const c of row.ase?.components ?? []) {
      const entry = components.get(c.key) ?? { label: c.label, values: [] };
      entry.values.push(clamp(c.avoidablePct, 0, 100));
      components.set(c.key, entry);
    }
  }
  const avoidableEffortPatterns = [...components.entries()]
    .filter(([, c]) => c.values.length >= minCell)
    .map(([component, c]) => ({
      component,
      label: c.label,
      avgAvoidablePct: round(mean(c.values), 1),
      caseCount: c.values.length,
    }))
    .sort((a, b) => b.avgAvoidablePct - a.avgAvoidablePct || (a.component < b.component ? -1 : 1))
    .slice(0, topN);

  const published = input.skills.filter((s) => s.lifecycle === 'published').length;
  const pilotOrValidated = input.skills.filter(
    (s) => s.lifecycle === 'pilot' || s.lifecycle === 'validated',
  ).length;
  const skillEffectiveness = input.skills
    .filter((s) => s.effectiveness.applications > 0)
    .map((s) => {
      const { avgTimeToDiagnosisMinutes: now, baselineAvgTimeToDiagnosisMinutes: base } =
        s.effectiveness;
      return {
        skillId: s.id,
        name: s.name,
        applications: s.effectiveness.applications,
        timeToDiagnosisDeltaPct:
          now !== null && base !== null && base > 0 ? round(((base - now) / base) * 100, 1) : null,
        synthetic: s.synthetic,
      };
    })
    .sort((a, b) => b.applications - a.applications || (a.skillId < b.skillId ? -1 : 1));

  const tokenRows = input.metrics.filter((m) => m.key === 'token_efficiency' && m.value !== null);
  const savingsByCase = new Map<string, number[]>();
  for (const s of input.scenarios) {
    if (s.reviewState === 'rejected' || s.actualTokens <= 0) continue;
    const pct = clamp(((s.actualTokens - s.counterfactualTokens) / s.actualTokens) * 100, 0, 100);
    savingsByCase.set(s.caseId, [...(savingsByCase.get(s.caseId) ?? []), pct]);
  }

  const reviewed = input.scenarios.filter((s) => s.reviewState !== 'pending');
  const accepted = reviewed.filter(
    (s) => s.reviewState === 'confirmed' || s.reviewState === 'corrected',
  );
  const rejected = reviewed.filter((s) => s.reviewState === 'rejected');
  const claimsReviewed = input.reviewStats?.reviewedClaims ?? 0;
  const claimsCorrected = Math.min(input.reviewStats?.correctedClaims ?? 0, claimsReviewed);

  const assumptionGroups = countBy(
    input.assumptionFlags,
    (f) => f.subject?.trim() || GENERIC_ASSUMPTION_SUBJECT,
  );
  const frequentUnsupportedAssumptions = [...assumptionGroups.entries()]
    .filter(([, n]) => n >= minCell)
    .sort(byCountThenName)
    .slice(0, topN)
    .map(([subject, count]) => ({ subject, count }));

  return {
    generatedAt: options.now,
    cohort: {
      caseCount: input.cases.length,
      analyzedCaseCount: analyzed.length,
      syntheticCaseCount: synthetic.length,
      note:
        analyzed.length < 10
          ? `n=${analyzed.length}: with so few analysed cases, trends and averages are illustrative only.`
          : `${analyzed.length} analysed cases.`,
    },
    qualityTrend,
    forkCategories,
    missingEvidence,
    avoidableEffortPatterns,
    skillAdoption: {
      totalSkills: input.skills.length,
      published,
      pilotOrValidated,
      matchedCases: new Set(input.matches.map((m) => m.caseId)).size,
      appliedCases: new Set(input.matches.filter((m) => m.applied).map((m) => m.caseId)).size,
    },
    skillEffectiveness,
    tokenEfficiency: {
      avgBitsPer1kTokens: avg(tokenRows.map((m) => m.value ?? 0)),
      avgEstimatedSavingsPct: avg([...savingsByCase.values()].map((v) => mean(v))),
    },
    counterfactualAcceptance: {
      reviewed: reviewed.length,
      accepted: accepted.length,
      rejected: rejected.length,
      rate: reviewed.length > 0 ? round(accepted.length / reviewed.length, 3) : null,
    },
    reviewerDisagreement: {
      reviewedClaims: claimsReviewed,
      corrected: claimsCorrected,
      rate: claimsReviewed > 0 ? round(claimsCorrected / claimsReviewed, 3) : null,
    },
    frequentUnsupportedAssumptions,
    responsibleUseNotice: RESPONSIBLE_USE_NOTICE,
    privacyNotes: [
      'Only counts, averages and knowledge-pack labels are shown: no case text, customer names or participant identities.',
      'No individual employee is ranked, scored or identified; every figure is a portfolio aggregate.',
      minCell > 1
        ? `Groups with fewer than ${minCell} cases are suppressed.`
        : 'Small groups are not suppressed in this cohort; with few cases, treat every figure as illustrative.',
      'All quality scores and effort figures are model estimates, not measurements.',
    ],
  };
}
