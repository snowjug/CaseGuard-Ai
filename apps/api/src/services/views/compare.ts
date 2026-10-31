import {
  COMPARISON_NOTICE,
  buildComparisonNarrative,
  buildComparisonRows,
} from '@caseguard/domain';
import { IdSchema, type CaseComparison, type SkillMatch } from '@caseguard/schemas';
import { NotFoundError, ValidationFailedError } from '../../errors';
import type { QueryOf } from '../../http/route-binder';
import type { RequestContext } from '../../http/request-context';
import { summarizeCase } from '../cases';
import { compareText } from './instants';

/** `caseIds=a,b`: exactly two different, well-formed case ids. */
export function parseCaseIds(raw: string): [string, string] {
  const ids = raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
  const [first, second] = ids;
  const bad = (message: string): ValidationFailedError =>
    new ValidationFailedError('Compare exactly two different cases', [
      { path: 'query.caseIds', message },
    ]);
  if (ids.length !== 2 || first === undefined || second === undefined) {
    throw bad('Send exactly two case ids separated by a comma');
  }
  if (!IdSchema.safeParse(first).success || !IdSchema.safeParse(second).success) {
    throw bad('A case id may contain letters, digits, _ . : - only');
  }
  if (first === second) throw bad('The two case ids must be different');
  return [first, second];
}

/** The strongest applicable skill match of a case, in the shape of the comparison. */
function skillReuseOf(matches: readonly SkillMatch[]): CaseComparison['skillReuse'] {
  const best = matches
    .filter((match) => match.applicability !== 'not_applicable')
    .sort(
      (a, b) =>
        b.score - a.score ||
        compareText(a.skillName, b.skillName) ||
        compareText(a.skillId, b.skillId),
    )[0];
  if (best === undefined) return null;
  return {
    skillId: best.skillId,
    skillName: best.skillName,
    skillVersion: best.skillVersion,
    matchScore: best.score,
    conformance: best.conformance?.score ?? null,
    stepsFollowed: best.conformance?.stepsFollowed ?? 0,
    stepsTotal: best.conformance?.stepsTotal ?? best.recommendedSteps.length,
  };
}

/**
 * Compares the stored metric estimates of two cases of the caller's tenant (404 for a missing or
 * foreign one). Everything is an estimate and says so; the comparison is between cases, never
 * between people. Skill reuse is read from the second case's stored skill matches.
 */
export async function compareCases(
  ctx: RequestContext,
  query: QueryOf<'compare.cases'>,
): Promise<CaseComparison> {
  const [firstId, secondId] = parseCaseIds(query.caseIds);
  const [first, second] = await Promise.all([
    ctx.repos.cases.get(firstId),
    ctx.repos.cases.get(secondId),
  ]);
  if (first === null) throw new NotFoundError('Case', firstId);
  if (second === null) throw new NotFoundError('Case', secondId);

  const [firstSummary, secondSummary, firstMetrics, secondMetrics, secondMatches] =
    await Promise.all([
      summarizeCase(ctx, first),
      summarizeCase(ctx, second),
      ctx.repos.analysis.listMetrics(first.id),
      ctx.repos.analysis.listMetrics(second.id),
      ctx.repos.analysis.listSkillMatches(second.id),
    ]);
  const rows = buildComparisonRows(
    { caseId: first.id, estimates: firstMetrics },
    { caseId: second.id, estimates: secondMetrics },
  );
  return {
    generatedAt: ctx.now().toISOString(),
    cases: [firstSummary, secondSummary],
    rows,
    narrative: buildComparisonNarrative(rows, {
      [first.id]: first.reference,
      [second.id]: second.reference,
    }),
    skillReuse: skillReuseOf(secondMatches),
    notice: COMPARISON_NOTICE,
    labels: { synthetic: first.synthetic || second.synthetic, estimated: true },
  };
}
