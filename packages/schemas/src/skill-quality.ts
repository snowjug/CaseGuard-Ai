import { z } from 'zod';
import { IdSchema, IsoTimestampSchema } from './common';

/**
 * Whether a SkillDNA skill is genuinely reusable (wave 2). A skill is assessed on twelve dimensions, each rated from what the
 * skill itself records, and checked for the seven ways a skill goes wrong. The assessment is advisory: it explains and it
 * flags, it never changes a skill and never approves or retires one, so governance stays with the people it belongs to.
 */

export const SKILL_QUALITY_DIMENSIONS = [
  'specificity',
  'evidence_basis',
  'trigger_conditions',
  'required_context',
  'prohibited_context',
  'false_positive_risk',
  'transferability',
  'expected_action',
  'outcome_evidence',
  'governance_status',
  'version',
  'effectiveness_evidence',
] as const;
export const SkillQualityDimensionSchema = z.enum(SKILL_QUALITY_DIMENSIONS);
export type SkillQualityDimension = z.infer<typeof SkillQualityDimensionSchema>;

export const SKILL_QUALITY_DIMENSION_LABELS: Record<SkillQualityDimension, string> = {
  specificity: 'Specific enough to recognise',
  evidence_basis: 'Evidence it rests on',
  trigger_conditions: 'Trigger conditions',
  required_context: 'Context it needs',
  prohibited_context: 'Context where it must not be used',
  false_positive_risk: 'Risk of matching the wrong case',
  transferability: 'Where it carries over',
  expected_action: 'The action it recommends',
  outcome_evidence: 'What shows it worked',
  governance_status: 'Review and approval',
  version: 'Version',
  effectiveness_evidence: 'Evidence it helps',
};

export const SKILL_QUALITY_RATINGS = ['strong', 'adequate', 'weak', 'missing'] as const;
export const SkillQualityRatingSchema = z.enum(SKILL_QUALITY_RATINGS);
export type SkillQualityRating = z.infer<typeof SkillQualityRatingSchema>;

export const SKILL_QUALITY_ISSUE_KINDS = [
  'too_generic',
  'case_specific_data',
  'unsupported_causal_claim',
  'duplicate',
  'contradictory',
  'stale',
  'cross_tenant',
] as const;
export const SkillQualityIssueKindSchema = z.enum(SKILL_QUALITY_ISSUE_KINDS);
export type SkillQualityIssueKind = z.infer<typeof SkillQualityIssueKindSchema>;

export const SKILL_QUALITY_ISSUE_LABELS: Record<SkillQualityIssueKind, string> = {
  too_generic: 'Too generic to be useful',
  case_specific_data: 'Contains data from one case',
  unsupported_causal_claim: 'States a cause it cannot support',
  duplicate: 'Duplicates another skill',
  contradictory: 'Gives different guidance for the same situation',
  stale: 'Not validated for a long time',
  cross_tenant: 'Belongs to another organisation',
};

export const SkillQualityIssueSchema = z.object({
  kind: SkillQualityIssueKindSchema,
  /** A blocking issue means the skill should not be suggested until it is fixed; a warning is for a reviewer to weigh. */
  severity: z.enum(['blocking', 'warning']),
  message: z.string().max(400),
  relatedSkillId: IdSchema.optional(),
});
export type SkillQualityIssue = z.infer<typeof SkillQualityIssueSchema>;

export const SkillQualityAssessmentSchema = z.object({
  skillId: IdSchema,
  versionId: IdSchema,
  assessedAt: IsoTimestampSchema,
  dimensions: z
    .array(
      z.object({
        id: SkillQualityDimensionSchema,
        label: z.string().max(80),
        rating: SkillQualityRatingSchema,
        findings: z.array(z.string().max(300)).max(8),
      }),
    )
    .length(SKILL_QUALITY_DIMENSIONS.length),
  issues: z.array(SkillQualityIssueSchema).max(40),
  /** `blocked`: a blocking issue. `needs_work`: a missing dimension, several weak ones or a warning. `ready`: none of these. */
  verdict: z.enum(['ready', 'needs_work', 'blocked']),
  summary: z.string().max(500),
});
export type SkillQualityAssessment = z.infer<typeof SkillQualityAssessmentSchema>;

export const SKILL_USE_VERDICTS = [
  'applies',
  'partially_applies',
  'does_not_apply',
  'unsafe_to_apply',
  'requires_approval',
] as const;
export const SkillUseVerdictSchema = z.enum(SKILL_USE_VERDICTS);
export type SkillUseVerdict = z.infer<typeof SkillUseVerdictSchema>;

export const SKILL_USE_VERDICT_LABELS: Record<SkillUseVerdict, string> = {
  applies: 'The skill applies',
  partially_applies: 'The skill partly applies',
  does_not_apply: 'The skill does not apply',
  unsafe_to_apply: 'The skill is unsafe to apply here',
  requires_approval: 'Applying the skill needs approval',
};

export const SkillUseAssessmentSchema = z.object({
  verdict: SkillUseVerdictSchema,
  /** Why, in the order the rules were checked; the first one decided it. */
  reasons: z.array(z.string().max(300)).min(1).max(8),
});
export type SkillUseAssessment = z.infer<typeof SkillUseAssessmentSchema>;
