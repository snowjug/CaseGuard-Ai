import type {
  CaseWarning,
  CommandCenter,
  Hypothesis,
  MissingEvidence,
  SkillDna,
  SkillMatch,
} from '@caseguard/schemas';

/** How many items each list of the command center shows. */
export const LIST_LIMITS = { warnings: 8, missing: 8, candidates: 5, recentCases: 6 } as const;

/** The hypothesis with the highest current confidence (a model estimate, shown with its range). */
export function leadingHypothesisOf(
  hypotheses: readonly Hypothesis[],
): CommandCenter['leadingHypothesis'] {
  const leader = [...hypotheses].sort((a, b) => b.currentConfidence - a.currentConfidence)[0];
  if (leader === undefined) return null;
  return {
    hypothesisId: leader.id,
    name: leader.name,
    confidence: leader.currentConfidence,
    low: leader.currentLow,
    high: leader.currentHigh,
    caseId: leader.caseId,
  };
}

const APPLICABILITY_RANK: Readonly<Record<SkillMatch['applicability'], number>> = {
  applies: 2,
  partial: 1,
  not_applicable: 0,
};

/**
 * The best stored match with a published or validated skill that applies at least partly. A skill that
 * does not apply is not a match, so it is never shown as one.
 */
export function bestSkillMatch(matches: readonly SkillMatch[]): CommandCenter['skillMatch'] {
  const best = matches
    .filter(
      (match) =>
        (match.lifecycle === 'published' || match.lifecycle === 'validated') &&
        match.applicability !== 'not_applicable',
    )
    .sort(
      (a, b) =>
        APPLICABILITY_RANK[b.applicability] - APPLICABILITY_RANK[a.applicability] ||
        b.score - a.score,
    )[0];
  if (best === undefined) return null;
  return {
    skillId: best.skillId,
    name: best.skillName,
    version: best.skillVersion,
    score: best.score,
    applicability: best.applicability,
    caseId: best.caseId,
  };
}

/** Skills that still await a decision (not yet published, never withdrawn), newest activity first. */
export function skillCandidatesOf(skills: readonly SkillDna[], limit: number): SkillDna[] {
  const open = new Set([
    'discovered',
    'draft',
    'simulation_tested',
    'expert_reviewed',
    'pilot',
    'validated',
  ]);
  return skills
    .filter((skill) => open.has(skill.lifecycle))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
    .slice(0, limit);
}

/** Unresolved critical evidence the case still lacks, in the knowledge pack's own order. */
export function criticalMissingOf(
  missing: readonly MissingEvidence[],
  caseId: string,
  limit: number,
): (MissingEvidence & { caseId: string })[] {
  return missing
    .filter((item) => item.criticality === 'critical' && item.resolvedAt === null)
    .slice(0, limit)
    .map((item) => ({ ...item, caseId }));
}

/** Open warnings, the engine's own ranking first (rank 1 is shown first). */
export function openWarningsOf(warnings: readonly CaseWarning[], limit: number): CaseWarning[] {
  return warnings
    .filter((warning) => warning.state === 'open')
    .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id))
    .slice(0, limit);
}
