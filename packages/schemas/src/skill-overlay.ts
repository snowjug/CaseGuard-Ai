import { z } from 'zod';
import { RangeSchema } from './analysis';
import { IdSchema, IsoTimestampSchema, ProbabilitySchema } from './common';
import { SkillLifecycleSchema } from './enums';
import { EvidenceLinkSchema } from './quality';
import {
  SemverSchema,
  SkillCheaperAlternativeSchema,
  SkillMatchSchema,
  SkillMatchStepSchema,
} from './skill';

/**
 * What a skill would have changed for one case, set beside what the case recorded.
 *
 * This is an explicit comparison, not a second analysis: the recorded analysis of the case is never altered by it
 * (`labels.recordedAnalysisUnchanged`). Every figure is computed on the server from stored data and labelled as an
 * estimate. A client shows these numbers as they are and does no arithmetic of its own.
 */
export const SKILL_OVERLAY_METRICS = [
  'time_to_useful_evidence_minutes',
  'customer_effort_minutes',
  'tokens',
] as const;
export const SkillOverlayMetricSchema = z.enum(SKILL_OVERLAY_METRICS);
export type SkillOverlayMetric = z.infer<typeof SkillOverlayMetricSchema>;

export const SkillOverlayRowSchema = z.object({
  key: SkillOverlayMetricSchema,
  label: z.string().max(120),
  unit: z.enum(['minutes', 'tokens']),
  /** What the case recorded. Null when the analysis has no figure for it. */
  recorded: RangeSchema.nullable(),
  /** The estimate had the skill been followed. Null when `recorded` or `saved` is missing. */
  withSkill: RangeSchema.nullable(),
  /** The skill's own estimated saving. Null when the skill states none. */
  saved: RangeSchema.nullable(),
  /** How `withSkill` follows from `recorded` and `saved`, in words. */
  basis: z.string().max(400),
});
export type SkillOverlayRow = z.infer<typeof SkillOverlayRowSchema>;

export const SkillOverlaySchema = z.object({
  caseId: IdSchema,
  matchId: IdSchema,
  asOf: IsoTimestampSchema,
  skill: z.object({
    id: IdSchema,
    versionId: IdSchema,
    name: z.string().max(160),
    version: SemverSchema,
    lifecycle: SkillLifecycleSchema,
  }),
  score: ProbabilitySchema,
  applicability: SkillMatchSchema.shape.applicability,
  /** Whether the engineer has already adopted this skill's plan for the case. */
  applied: z.boolean(),
  /** The decision of this case at which the skill would have mattered. Null when none of its forks relates to it. */
  decisionPoint: z
    .object({
      forkId: IdSchema,
      eventId: IdSchema,
      at: IsoTimestampSchema,
      title: z.string().max(300),
      summary: z.string().max(800),
    })
    .nullable(),
  recorded: z.object({
    actionKey: z.string().nullable(),
    actionLabel: z.string().max(300).nullable(),
    /** True when the skill's recommended step was already part of what the case did. */
    followedRecommendedStep: z.boolean(),
    note: z.string().max(600),
  }),
  withSkill: z.object({
    steps: z.array(SkillMatchStepSchema),
    cheaperAlternative: SkillCheaperAlternativeSchema.nullable(),
  }),
  comparison: z.array(SkillOverlayRowSchema),
  /** The evidence that made the skill match, and the decision point. Resolve it with `provenance.resolve`. */
  evidence: z.array(EvidenceLinkSchema),
  assumptions: z.array(z.string().max(400)),
  limitations: z.array(z.string().max(400)),
  labels: z.object({
    estimated: z.literal(true),
    simulated: z.literal(true),
    recordedAnalysisUnchanged: z.literal(true),
  }),
});
export type SkillOverlay = z.infer<typeof SkillOverlaySchema>;
