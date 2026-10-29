import { z } from 'zod';
import { IdSchema, IsoTimestampSchema, ProbabilitySchema, RecordMetaSchema } from './common';
import {
  LevelSchema,
  PenaltyKeySchema,
  PrioritySchema,
  QualityDimensionKeySchema,
  WarningCategorySchema,
} from './enums';

/** Link from a derived statement back to the thing that justifies it (FR: every score is evidence-linked). */
export const EvidenceLinkSchema = z.object({
  type: z.enum([
    'event',
    'claim',
    'evidence',
    'fork',
    'action',
    'hypothesis',
    'requirement',
    'scenario',
  ]),
  id: z.string().max(120),
  label: z.string().max(200).optional(),
});
export type EvidenceLink = z.infer<typeof EvidenceLinkSchema>;

// ---------------------------------------------------------------- quality index

export const SubCheckSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** 0-1 outcome of the check. */
  score: ProbabilitySchema,
  weight: z.number().min(0),
  note: z.string().max(600),
  evidence: z.array(EvidenceLinkSchema),
  /** False when the available data could not decide the check (widens uncertainty). */
  determinable: z.boolean(),
});
export type SubCheck = z.infer<typeof SubCheckSchema>;

export const QualityDimensionSchema = z.object({
  key: QualityDimensionKeySchema,
  label: z.string(),
  weight: z.number().min(0).max(1),
  rawScore: z.number().min(0).max(100),
  penaltyPoints: z.number().min(0),
  score: z.number().min(0).max(100),
  low: z.number().min(0).max(100),
  high: z.number().min(0).max(100),
  subChecks: z.array(SubCheckSchema),
  rationale: z.string().max(800),
});
export type QualityDimension = z.infer<typeof QualityDimensionSchema>;

export const AppliedPenaltySchema = z.object({
  id: IdSchema,
  key: PenaltyKeySchema,
  label: z.string(),
  points: z.number().min(0),
  dimension: QualityDimensionKeySchema.nullable(),
  evidence: z.array(EvidenceLinkSchema),
  rationale: z.string().max(800),
});
export type AppliedPenalty = z.infer<typeof AppliedPenaltySchema>;

export const ImprovementSchema = z.object({
  id: IdSchema,
  title: z.string(),
  description: z.string().max(800),
  expectedScoreGain: z.number().min(0),
  priority: PrioritySchema,
  linkedPenaltyKey: PenaltyKeySchema.nullable(),
  linkedForkId: IdSchema.nullable(),
  evidence: z.array(EvidenceLinkSchema),
});
export type Improvement = z.infer<typeof ImprovementSchema>;

export const QualityBandSchema = z.enum(['strong', 'adequate', 'needs_attention', 'poor']);
export type QualityBand = z.infer<typeof QualityBandSchema>;

export const QualityAssessmentSchema = RecordMetaSchema.extend({
  id: IdSchema,
  caseId: IdSchema,
  analysisRunId: IdSchema,
  asOf: IsoTimestampSchema.nullable(),
  compositeScore: z.number().min(0).max(100),
  compositeLow: z.number().min(0).max(100),
  compositeHigh: z.number().min(0).max(100),
  band: QualityBandSchema,
  dimensions: z.array(QualityDimensionSchema).length(6),
  penalties: z.array(AppliedPenaltySchema),
  totalPenaltyPoints: z.number().min(0),
  penaltyCapApplied: z.boolean(),
  improvements: z.array(ImprovementSchema),
  estimatedScoreAfterImprovements: z.object({
    score: z.number().min(0).max(100),
    low: z.number().min(0).max(100),
    high: z.number().min(0).max(100),
    method: z.string(),
  }),
  configVersion: z.string(),
  weights: z.record(z.string(), z.number()),
  uncertaintyNote: z.string(),
  estimated: z.literal(true),
});
export type QualityAssessment = z.infer<typeof QualityAssessmentSchema>;

// ---------------------------------------------------------------- metric estimates (incl. ASE)

export const METRIC_KEYS = [
  'case_quality_index',
  'evidence_integrity',
  'avoidable_support_effort',
  'reasoning_efficiency',
  'customer_effort',
  'resolution_confidence',
  'token_efficiency',
] as const;
export const MetricKeySchema = z.enum(METRIC_KEYS);
export type MetricKey = z.infer<typeof MetricKeySchema>;

export const AVOIDABLE_EFFORT_COMPONENTS = [
  'engineer_effort',
  'customer_effort',
  'repeated_interactions',
  'diagnostic_executions',
  'escalations',
  'waiting_time',
  'token_usage',
  'compute_usage',
  'low_information_actions',
] as const;
export const AvoidableEffortComponentKeySchema = z.enum(AVOIDABLE_EFFORT_COMPONENTS);
export type AvoidableEffortComponentKey = z.infer<typeof AvoidableEffortComponentKeySchema>;

export const AvoidableEffortComponentSchema = z.object({
  key: AvoidableEffortComponentKeySchema,
  label: z.string(),
  unit: z.string(),
  total: z.number().min(0),
  avoidable: z.number().min(0),
  avoidablePct: z.number().min(0).max(100),
  /** Weight of this component in the overall estimate (weights sum to 1). */
  weight: z.number().min(0).max(1),
  assumption: z.string(),
  evidence: z.array(EvidenceLinkSchema),
});
export type AvoidableEffortComponent = z.infer<typeof AvoidableEffortComponentSchema>;

export const AvoidableEffortDetailsSchema = z.object({
  components: z.array(AvoidableEffortComponentSchema),
  /** Method text shown verbatim in the UI ("How the estimate was calculated"). */
  method: z.string(),
  counterfactual: z
    .object({
      scenarioId: IdSchema,
      actualPct: z.number(),
      counterfactualPct: z.number(),
      counterfactualLowPct: z.number(),
      counterfactualHighPct: z.number(),
    })
    .nullable(),
});
export type AvoidableEffortDetails = z.infer<typeof AvoidableEffortDetailsSchema>;

export const MetricUnitSchema = z.enum([
  'score',
  'percent',
  'minutes',
  'hours',
  'bits_per_1k_tokens',
  'ratio',
  'count',
]);
export type MetricUnit = z.infer<typeof MetricUnitSchema>;

export const MetricEstimateSchema = RecordMetaSchema.extend({
  id: IdSchema,
  caseId: IdSchema,
  analysisRunId: IdSchema,
  key: MetricKeySchema,
  label: z.string(),
  value: z.number().nullable(),
  unit: MetricUnitSchema,
  display: z.string(),
  low: z.number().nullable(),
  high: z.number().nullable(),
  confidence: LevelSchema,
  status: z.enum(['good', 'watch', 'poor', 'unknown']),
  definition: z.string(),
  method: z.string(),
  assumptions: z.array(z.string()),
  contributors: z.array(
    z.object({
      label: z.string(),
      value: z.number(),
      unit: z.string(),
      share: z.number().min(0).max(1).nullable(),
      evidence: z.array(EvidenceLinkSchema),
    }),
  ),
  comparison: z
    .object({
      actual: z.number().nullable(),
      counterfactual: z.number().nullable(),
      counterfactualLow: z.number().nullable(),
      counterfactualHigh: z.number().nullable(),
      scenarioId: IdSchema.nullable(),
    })
    .nullable(),
  ase: AvoidableEffortDetailsSchema.nullable(),
  /** Always true: nothing here is a measured production value. */
  estimated: z.literal(true),
  synthetic: z.boolean(),
});
export type MetricEstimate = z.infer<typeof MetricEstimateSchema>;

// ---------------------------------------------------------------- live quality warnings

export const CaseWarningSchema = RecordMetaSchema.extend({
  id: IdSchema,
  caseId: IdSchema,
  analysisRunId: IdSchema,
  ruleId: z.string(),
  category: WarningCategorySchema,
  priority: PrioritySchema,
  /** 1 = show first. Ranking is stable for identical inputs. */
  rank: z.number().int().min(1),
  title: z.string().max(200),
  message: z.string().max(800),
  suggestedAction: z.string().max(400),
  evidence: z.array(EvidenceLinkSchema),
  /** Dedupe key: one warning per (rule, subject) regardless of how often the condition re-fires. */
  fingerprint: z.string(),
  raisedAt: IsoTimestampSchema,
  resolvedAt: IsoTimestampSchema.nullable(),
  resolvedReason: z.string().nullable(),
  state: z.enum(['open', 'resolved', 'dismissed']),
  dismissal: z
    .object({ by: z.string(), at: IsoTimestampSchema, reason: z.string().min(5).max(500) })
    .nullable(),
});
export type CaseWarning = z.infer<typeof CaseWarningSchema>;

export const DismissWarningBodySchema = z.object({
  reason: z.string().min(5).max(500),
  expectedVersion: z.number().int().min(1),
});
export type DismissWarningBody = z.infer<typeof DismissWarningBodySchema>;

// ---------------------------------------------------------------- coaching

export const CoachingItemSchema = z.object({
  title: z.string().max(200),
  detail: z.string().max(1200),
  evidence: z.array(EvidenceLinkSchema),
  skillId: IdSchema.nullable(),
});
export type CoachingItem = z.infer<typeof CoachingItemSchema>;

export const CoachingReportSchema = z.object({
  caseId: IdSchema,
  analysisRunId: IdSchema,
  generatedAt: IsoTimestampSchema,
  summary: z.string().max(1500),
  wentWell: z.array(CoachingItemSchema),
  missedOpportunity: CoachingItemSchema.nullable(),
  evidenceQuality: z.array(CoachingItemSchema),
  reasoningImprovements: z.array(CoachingItemSchema),
  communicationImprovements: z.array(CoachingItemSchema),
  customerEffortImprovements: z.array(CoachingItemSchema),
  recommendedNextAction: CoachingItemSchema.nullable(),
  relevantSkills: z.array(
    z.object({ skillId: IdSchema, name: z.string(), matchScore: ProbabilitySchema }),
  ),
  confidence: z.object({ level: LevelSchema, rationale: z.string() }),
  limitations: z.array(z.string()),
  /** Mandatory framing: supportive decision support, never a performance rating. */
  notice: z.string(),
});
export type CoachingReport = z.infer<typeof CoachingReportSchema>;
