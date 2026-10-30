import { z } from 'zod';
import {
  ExtractionMethodSchema,
  IdSchema,
  IsoTimestampSchema,
  ProbabilitySchema,
  RecordMetaSchema,
  ReviewStateSchema,
  SourceRefSchema,
} from './common';
import {
  ActionKindSchema,
  ClaimFlagSchema,
  EffortLevelSchema,
  EvidenceCategorySchema,
  ForkCategorySchema,
  HypothesisCategorySchema,
  HypothesisStatusSchema,
  LevelSchema,
  ParticipantRoleSchema,
  RiskLevelSchema,
  StrengthSchema,
  WarningCategorySchema,
} from './enums';

export const RangeSchema = z.object({ low: z.number(), mid: z.number(), high: z.number() });
export type Range = z.infer<typeof RangeSchema>;

// ---------------------------------------------------------------- evidence & claims

/** An observation extracted from one event, tied to a knowledge-pack signal. */
export const EvidenceSchema = RecordMetaSchema.extend({
  id: IdSchema,
  caseId: IdSchema,
  analysisRunId: IdSchema,
  signalId: z.string(),
  label: z.string(),
  summary: z.string().max(600),
  kind: z.enum(['presence', 'absence']),
  strength: StrengthSchema,
  category: EvidenceCategorySchema,
  eventId: IdSchema,
  sourceRef: SourceRefSchema,
  excerpt: z.string().max(600),
  /** Equals the source event timestamp: the instant the observation became available. */
  observedAt: IsoTimestampSchema,
  confidence: ProbabilitySchema,
  method: ExtractionMethodSchema,
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const HypothesisEvidenceLinkSchema = RecordMetaSchema.extend({
  id: IdSchema,
  caseId: IdSchema,
  analysisRunId: IdSchema,
  hypothesisId: IdSchema,
  evidenceId: IdSchema,
  polarity: z.enum(['supports', 'contradicts', 'neutral']),
  /** P(evidence | hypothesis) from the knowledge pack. */
  likelihood: ProbabilitySchema,
  /** log2 of the dampened likelihood ratio versus the other hypotheses. Positive supports. */
  logLikelihoodRatio: z.number(),
  /** Change in the hypothesis posterior caused by this evidence at the time it arrived. */
  effectOnConfidence: z.number(),
  rationale: z.string().max(600),
  observedAt: IsoTimestampSchema,
});
export type HypothesisEvidenceLink = z.infer<typeof HypothesisEvidenceLinkSchema>;

export const MissingEvidenceSchema = z.object({
  id: IdSchema,
  requirementId: z.string(),
  label: z.string(),
  description: z.string(),
  criticality: z.enum(['critical', 'important', 'helpful']),
  category: WarningCategorySchema,
  firstRelevantAt: IsoTimestampSchema,
  resolvedAt: IsoTimestampSchema.nullable(),
  resolvedByEventId: IdSchema.nullable(),
  neededFor: z.array(z.string()),
  askText: z.string(),
});
export type MissingEvidence = z.infer<typeof MissingEvidenceSchema>;

/** A statement in the case (or an inferred statement) classified for the evidence ledger. */
export const ClaimSchema = RecordMetaSchema.extend({
  id: IdSchema,
  caseId: IdSchema,
  analysisRunId: IdSchema,
  text: z.string().max(1000),
  /** Effective category: the reviewer's correction when present, otherwise the AI classification. */
  category: EvidenceCategorySchema,
  /** The original classification. Never overwritten (FR-EV-03). */
  aiCategory: EvidenceCategorySchema,
  reviewedCategory: EvidenceCategorySchema.nullable(),
  reviewState: ReviewStateSchema,
  reviewReason: z.string().nullable(),
  reviewedBy: z.string().nullable(),
  reviewedAt: IsoTimestampSchema.nullable(),
  /** Attribute key used to detect conflicting statements, e.g. `affected_user_count`. */
  subject: z.string().nullable(),
  authorRole: ParticipantRoleSchema.nullable(),
  eventId: IdSchema.nullable(),
  sourceRef: SourceRefSchema.nullable(),
  timestamp: IsoTimestampSchema,
  supportingEvidenceIds: z.array(IdSchema),
  contradictingEvidenceIds: z.array(IdSchema),
  relatedHypothesisIds: z.array(IdSchema),
  confidence: ProbabilitySchema,
  explanation: z.string().max(800),
  /** Rule that produced the classification, for traceability. */
  ruleId: z.string(),
  flags: z.array(ClaimFlagSchema),
  method: ExtractionMethodSchema,
  missingEvidenceId: IdSchema.nullable(),
  simulated: z.boolean(),
});
export type Claim = z.infer<typeof ClaimSchema>;

// ---------------------------------------------------------------- hypotheses

export const HypothesisPointSchema = z.object({
  at: IsoTimestampSchema,
  eventId: IdSchema,
  confidence: ProbabilitySchema,
  low: ProbabilitySchema,
  high: ProbabilitySchema,
  status: HypothesisStatusSchema,
  delta: z.number(),
  /** Promotion / demotion reason in plain language. */
  reason: z.string().max(600),
  triggerEvidenceIds: z.array(IdSchema),
  supportingEvidenceIds: z.array(IdSchema),
  contradictingEvidenceIds: z.array(IdSchema),
  missingRequirementIds: z.array(z.string()),
  cheapestSafeActionKey: z.string().nullable(),
  expectedInformationGainBits: z.number().nullable(),
});
export type HypothesisPoint = z.infer<typeof HypothesisPointSchema>;

export const HypothesisActionRefSchema = z.object({
  actionKey: z.string(),
  label: z.string(),
  rationale: z.string(),
  expectedInformationGainBits: z.number(),
  actionValue: z.number(),
  risk: RiskLevelSchema,
  customerEffort: EffortLevelSchema,
  tokenEstimate: z.number().int(),
  timeMinutes: z.number(),
});
export type HypothesisActionRef = z.infer<typeof HypothesisActionRefSchema>;

export const HypothesisSchema = RecordMetaSchema.extend({
  id: IdSchema,
  caseId: IdSchema,
  analysisRunId: IdSchema,
  /** Knowledge-pack hypothesis id. */
  key: z.string(),
  name: z.string(),
  description: z.string(),
  category: HypothesisCategorySchema,
  prior: ProbabilitySchema,
  timeline: z.array(HypothesisPointSchema),
  currentConfidence: ProbabilitySchema,
  currentLow: ProbabilitySchema,
  currentHigh: ProbabilitySchema,
  currentStatus: HypothesisStatusSchema,
  assumptions: z.array(z.string()),
  /** Engineer explicitly anchored on this hypothesis (statement or action). */
  engineerAnchoredAt: IsoTimestampSchema.nullable(),
  cheapestSafeAction: HypothesisActionRefSchema.nullable(),
  /** Always true: confidence values are model estimates, never statistical truth. */
  modelEstimate: z.literal(true),
});
export type Hypothesis = z.infer<typeof HypothesisSchema>;

// ---------------------------------------------------------------- actions & action value

export const DiagnosticActionSchema = RecordMetaSchema.extend({
  id: IdSchema,
  caseId: IdSchema,
  analysisRunId: IdSchema,
  eventId: IdSchema,
  sequence: z.number().int().min(0),
  actionKey: z.string().nullable(),
  label: z.string(),
  kind: ActionKindSchema,
  executorRole: ParticipantRoleSchema,
  startedAt: IsoTimestampSchema,
  durationMinutes: z.number().min(0),
  customerEffort: EffortLevelSchema,
  customerEffortScore: ProbabilitySchema,
  operationalRisk: ProbabilitySchema,
  destructive: z.boolean(),
  tokenEstimate: z.number().int().min(0),
  computeUnits: z.number().min(0),
  targetHypothesisIds: z.array(IdSchema),
  statedHypothesisId: IdSchema.nullable(),
  /** Retrospective: information actually gained from results that answered this action. */
  realizedInformationGainBits: z.number().min(0),
  informationGainClass: z.enum(['high', 'moderate', 'low', 'none']),
  repeatOfActionId: IdSchema.nullable(),
  isRepeat: z.boolean(),
  lowValue: z.boolean(),
  lowValueReasons: z.array(z.string()),
  /** Relative action value (0-1) of this action versus the best safe candidate at decision time. */
  relativeValueAtDecision: ProbabilitySchema.nullable(),
});
export type DiagnosticAction = z.infer<typeof DiagnosticActionSchema>;

export const ActionValueInputsSchema = z.object({
  expectedInformationGainBits: z.number().min(0),
  relevance: ProbabilitySchema,
  confidence: ProbabilitySchema,
  timeMinutes: z.number().min(0),
  tokens: z.number().min(0),
  customerEffort: ProbabilitySchema,
  operationalRisk: ProbabilitySchema,
});
export type ActionValueInputs = z.infer<typeof ActionValueInputsSchema>;

export const ActionValueBreakdownSchema = z.object({
  actionKey: z.string(),
  label: z.string(),
  kind: ActionKindSchema,
  inputs: ActionValueInputsSchema,
  /** Every term scaled to [0, 1] before combination (unit-normalized). */
  normalized: z.object({
    information: ProbabilitySchema,
    relevance: ProbabilitySchema,
    confidence: ProbabilitySchema,
    time: ProbabilitySchema,
    token: ProbabilitySchema,
    customer: ProbabilitySchema,
    risk: ProbabilitySchema,
  }),
  numerator: z.number(),
  denominator: z.number(),
  score: z.number(),
  /** Score divided by the best safe score; 1 means "best available". */
  relativeScore: ProbabilitySchema,
  rank: z.number().int().min(1),
  safety: z.object({ allowed: z.boolean(), blockedReasons: z.array(z.string()) }),
  sensitivity: z.object({
    minRank: z.number().int().min(1),
    maxRank: z.number().int().min(1),
    rankStable: z.boolean(),
    scenarios: z.array(
      z.object({ label: z.string(), rank: z.number().int().min(1), score: z.number() }),
    ),
  }),
  requiresFirst: z.array(z.string()),
  explanation: z.string(),
  override: z
    .object({
      rank: z.number().int().min(1),
      reason: z.string(),
      by: z.string(),
      at: IsoTimestampSchema,
    })
    .nullable(),
});
export type ActionValueBreakdown = z.infer<typeof ActionValueBreakdownSchema>;

/** The most reviewer overrides one action ranking lists. */
export const ACTION_OVERRIDES_LISTED_MAX = 200;

/**
 * A reviewer's override of the action ranking as the ranking lists it, apart from the candidate it
 * concerns: which ranking it was recorded about (`instant`), the rank the reviewer preferred, why, who
 * decided and when. The machine rank and score of the action are never changed by it.
 */
export const ActionOverrideRecordSchema = z.object({
  /** The ranking instant the reviewer looked at (UTC, millisecond precision). */
  instant: IsoTimestampSchema,
  actionKey: z.string(),
  /** The knowledge pack's name for the action when it can be resolved, otherwise its key. */
  actionName: z.string(),
  rank: z.number().int().min(1),
  reason: z.string(),
  by: z.string(),
  /** When the reviewer decided. */
  at: IsoTimestampSchema,
});
export type ActionOverrideRecord = z.infer<typeof ActionOverrideRecordSchema>;

export const ActionRankingSchema = z.object({
  caseId: IdSchema,
  asOf: IsoTimestampSchema,
  configVersion: z.string(),
  /** Human-readable formula so the heuristic is never presented as a scientific law. */
  formula: z.string(),
  notice: z.string(),
  posterior: z.array(
    z.object({
      hypothesisId: IdSchema,
      key: z.string(),
      name: z.string(),
      confidence: ProbabilitySchema,
    }),
  ),
  candidates: z.array(ActionValueBreakdownSchema),
  blocked: z.array(ActionValueBreakdownSchema),
  /**
   * The reviewer overrides of the case this view may show, newest decision first, the latest decision
   * per (instant, action) only. The whole record lists every override of the case; a window (`asOf` or
   * `forkId`) lists only those decided, and about an instant, at or before its end, and carries nothing
   * of the others, not even how many there are. A candidate shows inline (`override`) only the one about
   * this ranking's own instant. Absent from servers that predate it.
   */
  reviewerOverrides: z
    .array(ActionOverrideRecordSchema)
    .max(ACTION_OVERRIDES_LISTED_MAX)
    .optional(),
});
export type ActionRanking = z.infer<typeof ActionRankingSchema>;

// ---------------------------------------------------------------- decision forks

export const ForkAlternativeSchema = z.object({
  actionKey: z.string(),
  label: z.string(),
  kind: ActionKindSchema,
  rationale: z.string(),
  /** Evidence ids available at the fork time that justify this alternative. */
  supportingEvidenceIds: z.array(IdSchema),
  expectedInformationGainBits: z.number().min(0),
  relevance: ProbabilitySchema,
  actionValue: z.number().min(0),
  relativeValue: ProbabilitySchema,
  timeMinutes: z.number().min(0),
  customerEffort: EffortLevelSchema,
  operationalRisk: ProbabilitySchema,
  tokenEstimate: z.number().int().min(0),
  safe: z.boolean(),
  blockedReasons: z.array(z.string()),
  requiresFirst: z.array(z.string()),
});
export type ForkAlternative = z.infer<typeof ForkAlternativeSchema>;

export const ConsequenceEstimateSchema = z.object({
  timeToUsefulEvidenceMinutes: RangeSchema,
  customerEffortScore: ProbabilitySchema,
  tokenEstimate: z.number().int().min(0),
  riskLevel: LevelSchema,
  /** Always true: consequences are estimates, never measurements. */
  estimated: z.literal(true),
});
export type ConsequenceEstimate = z.infer<typeof ConsequenceEstimateSchema>;

export const EligibilityCheckSchema = z.object({
  id: z.string(),
  passed: z.boolean(),
  detail: z.string(),
});
export type EligibilityCheck = z.infer<typeof EligibilityCheckSchema>;

export const DecisionForkSchema = RecordMetaSchema.extend({
  id: IdSchema,
  caseId: IdSchema,
  analysisRunId: IdSchema,
  sequence: z.number().int().min(0),
  /** The decision instant T. Everything under "available" is at or before T. */
  timestamp: IsoTimestampSchema,
  eventId: IdSchema,
  title: z.string(),
  summary: z.string(),
  category: ForkCategorySchema,
  additionalCategories: z.array(ForkCategorySchema),
  severity: LevelSchema,
  impactScore: ProbabilitySchema,
  isEarliestMeaningful: z.boolean(),
  ruleIds: z.array(z.string()),
  actual: z.object({
    actionKey: z.string().nullable(),
    label: z.string(),
    kind: ActionKindSchema.nullable(),
    eventId: IdSchema,
    customerEffort: EffortLevelSchema,
    operationalRisk: ProbabilitySchema,
    destructive: z.boolean(),
    actionValue: z.number().nullable(),
    relativeValue: ProbabilitySchema.nullable(),
  }),
  informationAvailable: z.object({
    eventIds: z.array(IdSchema),
    evidenceIds: z.array(IdSchema),
    claimIds: z.array(IdSchema),
    summary: z.string(),
  }),
  /** Plain-language names of things that did not yet exist or had not been collected at T. */
  informationUnavailable: z.array(z.string()),
  posteriorAtDecision: z.array(
    z.object({
      hypothesisId: IdSchema,
      key: z.string(),
      name: z.string(),
      confidence: ProbabilitySchema,
    }),
  ),
  alternatives: z.array(ForkAlternativeSchema).max(6),
  consequences: z.object({
    actual: ConsequenceEstimateSchema,
    bestAlternative: ConsequenceEstimateSchema.nullable(),
    deltaSummary: z.string(),
  }),
  uncertainty: z.object({
    level: LevelSchema,
    score: ProbabilitySchema,
    rationale: z.string(),
    rankStability: ProbabilitySchema,
  }),
  risk: RiskLevelSchema,
  eligibility: z.object({
    eligible: z.boolean(),
    boundary: IsoTimestampSchema,
    checks: z.array(EligibilityCheckSchema),
    reasons: z.array(z.string()),
  }),
  /** Hindsight view of the actual action. Computed after detection and never used to detect or generate. */
  retrospective: z
    .object({
      realizedInformationGainBits: z.number().min(0),
      outcomeSummary: z.string(),
      usedHindsight: z.literal(true),
    })
    .nullable(),
  reviewState: ReviewStateSchema,
  reviewReason: z.string().nullable(),
});
export type DecisionFork = z.infer<typeof DecisionForkSchema>;
