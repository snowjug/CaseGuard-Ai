import type { SkillApproval, SkillDna } from '@caseguard/schemas';
import type { CaseListItem } from '../../db';
import type { RequestContext } from '../../http/request-context';
import { STORY_CASES, type StoryCase } from './story-cases';
import type { CaseFacts, DemoFacts, FollowUpMatchFacts, SkillFacts } from './types';

/** The ingested copy of a built-in sample, recognised by its bundle reference (synthetic cases only). */
export async function findStoryCase(
  ctx: RequestContext,
  story: StoryCase,
): Promise<CaseListItem | null> {
  const page = await ctx.repos.cases.list({ limit: 50, q: story.reference });
  return page.items.find((item) => item.reference === story.reference && item.synthetic) ?? null;
}

/** The skill derived from Case One: the oldest skill whose source cases include it. */
export async function findStorySkill(
  ctx: RequestContext,
  caseOneId: string,
): Promise<SkillDna | null> {
  const page = await ctx.repos.skills.list({ limit: 200 });
  return (
    page.items
      .filter((candidate) => candidate.sourceCaseIds.includes(caseOneId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] ?? null
  );
}

const total = (counts: Readonly<Record<string, number>>): number =>
  Object.values(counts).reduce((sum, count) => sum + count, 0);

async function caseFacts(ctx: RequestContext, item: CaseListItem): Promise<CaseFacts> {
  const { analysis, counterfactuals } = ctx.repos;
  const [claims, hypotheses, forks, quality, metrics] = await Promise.all([
    analysis.countClaimsByCategory(item.id),
    analysis.listHypotheses(item.id),
    analysis.listForks(item.id),
    analysis.getQuality(item.id),
    analysis.listMetrics(item.id),
  ]);
  const earliest = forks.find((fork) => fork.isEarliestMeaningful) ?? null;
  const scenarios =
    earliest === null ? [] : await counterfactuals.list(item.id, { forkId: earliest.id });
  return {
    id: item.id,
    reference: item.reference,
    analyzed: item.analysisState === 'analyzed',
    claimCount: total(claims),
    hypothesisCount: hypotheses.length,
    forkCount: forks.length,
    earliestForkId: earliest?.id ?? null,
    acceptedScenarioId: scenarios.find((s) => s.reviewState === 'confirmed')?.id ?? null,
    qualityAssessed: quality !== null,
    metricCount: metrics.length,
  };
}

/** The person who approved the move to `toState`, if anyone did. */
const approverOf = (approvals: readonly SkillApproval[], toState: SkillApproval['toState']) =>
  approvals.find((a) => a.toState === toState && a.decision === 'approved')?.approver ?? null;

async function skillFacts(ctx: RequestContext, skill: SkillDna): Promise<SkillFacts> {
  const approvals = await ctx.repos.skills.listApprovals(skill.id);
  const pilot = approverOf(approvals, 'pilot');
  const publisher = approverOf(approvals, 'published');
  return {
    id: skill.id,
    lifecycle: skill.lifecycle,
    governedPublication: pilot !== null && publisher !== null && pilot !== publisher,
  };
}

/** Only a match made once the skill was validated counts: a pilot-stage match is not "the validated skill". */
const VALIDATED_LIFECYCLES: ReadonlySet<string> = new Set(['validated', 'published']);

async function followUpMatch(
  ctx: RequestContext,
  caseTwoId: string,
  skillId: string,
): Promise<FollowUpMatchFacts | null> {
  const matches = await ctx.repos.skills.listMatchesForCase(caseTwoId);
  const match = matches.find((candidate) => candidate.skillId === skillId);
  if (match === undefined) return null;
  return {
    applies: match.applicability === 'applies' && VALIDATED_LIFECYCLES.has(match.lifecycle),
    applied: match.applied,
    hasConformance: match.conformance !== null,
  };
}

/** Reads what the story's progress is derived from: a handful of tenant-scoped queries, no writes. */
export async function loadFacts(ctx: RequestContext): Promise<DemoFacts> {
  const [one, two] = await Promise.all([
    findStoryCase(ctx, STORY_CASES.one),
    findStoryCase(ctx, STORY_CASES.two),
  ]);
  const caseOne = one === null ? null : await caseFacts(ctx, one);
  const caseTwo = two === null ? null : await caseFacts(ctx, two);
  const skill = caseOne === null ? null : await findStorySkill(ctx, caseOne.id);
  const skillState = skill === null ? null : await skillFacts(ctx, skill);
  const match =
    skillState === null || caseTwo === null
      ? null
      : await followUpMatch(ctx, caseTwo.id, skillState.id);
  return { caseOne, caseTwo, skill: skillState, followUpMatch: match };
}
