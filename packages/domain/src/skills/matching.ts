import type {
  ActionValueConfig,
  SkillCondition,
  SkillDna,
  SkillLifecycle,
  SkillMatch,
  SkillVersion,
} from '@caseguard/schemas';
import type { EngineContext } from '../engine/context';
import type { CompiledPack } from '../knowledge/compile';
import { stableId } from '../util/ids';
import { round } from '../util/math';
import {
  buildEvidenceIndex,
  evaluateCondition,
  type CaseInfo,
  type EvidenceIndex,
} from './evidence';
import { asOfView, guidedPlanFromState, type AnalysisAsOf } from './guidance';
import { toMatchSteps, type GuidedPlan } from './plan';
import { knowledgeStateFromView } from './state';
import { pct } from './util';

/** Only skills that completed their governance gates up to a pilot are ever suggested to engineers. */
export const MATCHABLE_LIFECYCLES: readonly SkillLifecycle[] = ['pilot', 'validated', 'published'];
export const APPLIES_THRESHOLD = 0.7;
export const PARTIAL_THRESHOLD = 0.35;

export interface MatchableSkill {
  skill: SkillDna;
  /** The skill's current version (what `listMatchable` returns). */
  version: SkillVersion;
}

export interface MatchSkillsInput {
  skills: readonly MatchableSkill[];
  /** Only the events inside it are read, and only those at or before `asOf` are used. */
  analysisAsOf: AnalysisAsOf;
  asOf: string;
  pack: CompiledPack;
  config: ActionValueConfig;
  ctx: EngineContext;
  caseInfo: CaseInfo;
}

export interface ExcludedSkill {
  skillId: string;
  versionId: string;
  lifecycle: SkillLifecycle;
  reason: string;
}

export interface SkillMatchSet {
  /** One entry per matchable skill, best score first (including those that do not apply). */
  matches: SkillMatch[];
  /** Guided plans for every match whose applicability is not `not_applicable`, keyed by skill id. */
  plans: Record<string, GuidedPlan>;
  /** Skills that never take part in matching, with the reason (deprecated, retired, not yet piloted). */
  excluded: ExcludedSkill[];
}

export interface TriggerScore {
  matched: { condition: SkillCondition; evidenceIds: string[] }[];
  unmatched: SkillCondition[];
  requiredUnmet: SkillCondition[];
  exclusionsHit: SkillCondition[];
  coverage: number;
}

/** Weighted share of the trigger conditions that hold, plus the required and exclusion checks. */
export function scoreConditions(
  triggers: readonly SkillCondition[],
  exclusions: readonly SkillCondition[],
  index: EvidenceIndex,
): TriggerScore {
  const evaluated = triggers.map((c) => evaluateCondition(c, index));
  const total = triggers.reduce((s, c) => s + c.weight, 0);
  const matchedWeight = evaluated
    .filter((e) => e.holds)
    .reduce((s, e) => s + e.condition.weight, 0);
  const coverage =
    total > 0
      ? matchedWeight / total
      : evaluated.length === 0
        ? 0
        : evaluated.filter((e) => e.holds).length / evaluated.length;
  return {
    matched: evaluated
      .filter((e) => e.holds)
      .map((e) => ({ condition: e.condition, evidenceIds: e.evidenceIds })),
    unmatched: evaluated.filter((e) => !e.holds).map((e) => e.condition),
    requiredUnmet: evaluated
      .filter((e) => !e.holds && e.condition.required)
      .map((e) => e.condition),
    exclusionsHit: exclusions.filter((c) => evaluateCondition(c, index).holds),
    coverage,
  };
}

export function applicabilityOf(score: TriggerScore): {
  applicability: SkillMatch['applicability'];
  score: number;
} {
  if (score.exclusionsHit.length > 0) return { applicability: 'not_applicable', score: 0 };
  if (score.requiredUnmet.length > 0) {
    return { applicability: 'not_applicable', score: round(score.coverage * 0.5, 3) };
  }
  const value = round(score.coverage, 3);
  if (value >= APPLIES_THRESHOLD) return { applicability: 'applies', score: value };
  if (value >= PARTIAL_THRESHOLD) return { applicability: 'partial', score: value };
  return { applicability: 'not_applicable', score: value };
}

const list = (conditions: readonly SkillCondition[]): string =>
  conditions.map((c) => c.description).join('; ');

function rationaleOf(
  result: { applicability: SkillMatch['applicability']; score: number },
  score: TriggerScore,
  triggerCount: number,
  asOf: string,
  lifecycle: SkillLifecycle,
): string {
  const label = {
    applies: 'Applies',
    partial: 'Partially applies',
    not_applicable: 'Does not apply',
  }[result.applicability];
  const parts = [
    `${label} (score ${pct(result.score)}): ${score.matched.length} of ${triggerCount} trigger conditions hold using only evidence available at ${asOf}.`,
  ];
  if (score.matched.length > 0) parts.push(`Met: ${list(score.matched.map((m) => m.condition))}.`);
  if (score.unmatched.length > 0) parts.push(`Not met yet: ${list(score.unmatched)}.`);
  if (score.requiredUnmet.length > 0) {
    parts.push(`A required condition is not met: ${list(score.requiredUnmet)}.`);
  }
  if (score.exclusionsHit.length > 0) {
    parts.push(`Excluded because: ${list(score.exclusionsHit)}.`);
  }
  if (lifecycle === 'pilot') parts.push('Pilot skill: not yet validated for general use.');
  parts.push('The score is a model estimate from the evidence at this moment, not a measurement.');
  return parts.join(' ');
}

/**
 * Scores matchable skills against the evidence known at `asOf`. The case is re-read through a temporal
 * view, so events after `asOf` and the final resolution can never influence a match.
 */
export function matchSkills(input: MatchSkillsInput): SkillMatchSet {
  const { skills, analysisAsOf, asOf, pack, config, ctx, caseInfo } = input;
  const view = asOfView(analysisAsOf, asOf);
  const { state, analysis } = knowledgeStateFromView(view, pack, ctx.caseId);
  const index = buildEvidenceIndex(analysis, caseInfo);
  const matches: SkillMatch[] = [];
  const plans: Record<string, GuidedPlan> = {};
  const excluded: ExcludedSkill[] = [];

  for (const { skill, version } of skills) {
    if (!MATCHABLE_LIFECYCLES.includes(skill.lifecycle)) {
      excluded.push({
        skillId: skill.id,
        versionId: version.id,
        lifecycle: skill.lifecycle,
        reason:
          skill.lifecycle === 'deprecated' || skill.lifecycle === 'retired'
            ? `The skill is ${skill.lifecycle}; deprecated and retired skills never match.`
            : `The skill is ${skill.lifecycle}; only pilot, validated or published skills are matched.`,
      });
      continue;
    }
    const content = version.content;
    const wrongScope = skill.workload !== caseInfo.workload;
    const score = wrongScope
      ? {
          matched: [],
          unmatched: [...content.triggerConditions],
          requiredUnmet: [],
          exclusionsHit: [],
          coverage: 0,
        }
      : scoreConditions(content.triggerConditions, content.exclusions, index);
    const result = wrongScope
      ? { applicability: 'not_applicable' as const, score: 0 }
      : applicabilityOf(score);
    const plan =
      result.applicability === 'not_applicable'
        ? null
        : guidedPlanFromState({ skill, version, state, asOf, caseId: ctx.caseId, pack, config });
    if (plan) plans[skill.id] = plan;
    matches.push({
      tenantId: ctx.tenantId,
      createdAt: ctx.now,
      updatedAt: ctx.now,
      createdBy: ctx.createdBy,
      version: 1,
      id: stableId('smt', ctx.caseId, skill.id),
      caseId: ctx.caseId,
      skillId: skill.id,
      versionId: version.id,
      skillName: content.name,
      skillVersion: version.version,
      lifecycle: skill.lifecycle,
      asOf,
      score: result.score,
      applicability: result.applicability,
      matchedTriggers: score.matched.map((m) => ({
        id: m.condition.id,
        description: m.condition.description,
        weight: m.condition.weight,
        evidenceIds: m.evidenceIds,
      })),
      unmatchedTriggers: score.unmatched.map((c) => ({
        id: c.id,
        description: c.description,
        weight: c.weight,
      })),
      exclusionsHit: score.exclusionsHit.map((c) => ({ id: c.id, description: c.description })),
      rationale: wrongScope
        ? `Does not apply: the skill covers the ${skill.workload} workload and this case is ${caseInfo.workload}.`
        : rationaleOf(result, score, content.triggerConditions.length, asOf, skill.lifecycle),
      recommendedSteps: plan ? toMatchSteps(plan) : [],
      conformance: null,
      applied: false,
      appliedAt: null,
      appliedBy: null,
    });
  }
  matches.sort((a, b) => b.score - a.score || (a.skillId < b.skillId ? -1 : 1));
  return { matches, plans, excluded };
}
