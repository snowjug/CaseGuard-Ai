import { z } from 'zod';
import {
  IdSchema,
  IsoTimestampSchema,
  ProbabilitySchema,
  RecordMetaSchema,
  ReviewStateSchema,
} from './common';
import { EligibilityCheckSchema, RangeSchema } from './analysis';
import { ActionKindSchema, EffortLevelSchema, LevelSchema } from './enums';
import { ActionExecutorSchema } from './knowledge';

export const COUNTERFACTUAL_STRATEGIES = [
  'balanced',
  'lowest_customer_effort',
  'fastest_diagnosis',
] as const;
export const CounterfactualStrategySchema = z.enum(COUNTERFACTUAL_STRATEGIES);
export type CounterfactualStrategy = z.infer<typeof CounterfactualStrategySchema>;
export const STRATEGY_LABELS: Record<CounterfactualStrategy, string> = {
  balanced: 'Balanced path',
  lowest_customer_effort: 'Lowest customer effort',
  fastest_diagnosis: 'Fastest to diagnosis',
};

export const PathMetricsSchema = z.object({
  actionCount: RangeSchema,
  customerInteractions: RangeSchema,
  timeToUsefulEvidenceMinutes: RangeSchema,
  timeToDiagnosisMinutes: RangeSchema,
  diagnosticVolume: RangeSchema,
  tokenEstimate: RangeSchema,
  customerEffortMinutes: RangeSchema,
  operationalRisk: z.number().min(0).max(1),
  informationGainBits: RangeSchema,
  unsupportedBranches: z.number().int().min(0),
});
export type PathMetrics = z.infer<typeof PathMetricsSchema>;

export const PREDICTED_OUTCOME_ALT_LIMIT = 4;

// ---------------------------------------------------------------- how far to trust a counterfactual (wave 2)

/**
 * What a figure rests on. A counterfactual path never happened, so no figure of it is "measured": only the recorded side
 * (elapsed time and counts read from the case's own timestamps and events) is. The others differ in who computed the
 * figure and whether the path could support a comparison at all.
 */
export const COUNTERFACTUAL_BASES = [
  'measured',
  'deterministic_estimate',
  'model_estimate',
  'illustrative',
] as const;
export const CounterfactualBasisSchema = z.enum(COUNTERFACTUAL_BASES);
export type CounterfactualBasis = z.infer<typeof CounterfactualBasisSchema>;
export const COUNTERFACTUAL_BASIS_LABELS: Record<CounterfactualBasis, string> = {
  measured: 'Measured from the record',
  deterministic_estimate: 'Computed estimate',
  model_estimate: 'Model estimate',
  illustrative: 'Illustration only',
};
export const COUNTERFACTUAL_BASIS_DESCRIPTIONS: Record<CounterfactualBasis, string> = {
  measured: 'Read from the case itself, for example the time between two recorded events.',
  deterministic_estimate:
    "Computed by the engine from the knowledge pack's authored probabilities and times, with a fixed random seed. The same case gives the same figure. It is a range, not a measurement.",
  model_estimate:
    'Proposed by a language model. It has not been computed or checked by the engine.',
  illustrative:
    'A worked example. The path could not support a comparison, so read it as an illustration and not as an estimate.',
};

export const FEASIBILITY_LEVELS = ['feasible', 'feasible_with_conditions', 'not_feasible'] as const;
export const FeasibilityLevelSchema = z.enum(FEASIBILITY_LEVELS);
export type FeasibilityLevel = z.infer<typeof FeasibilityLevelSchema>;
export const FEASIBILITY_LABELS: Record<FeasibilityLevel, string> = {
  feasible: 'Could have been done',
  feasible_with_conditions: 'Could have been done if certain things held',
  not_feasible: 'Could not have been done as described',
};

export const StepFeasibilitySchema = z.object({
  level: FeasibilityLevelSchema,
  /** What had to be true for the step to be possible, one short sentence each; empty when nothing special. */
  conditions: z.array(z.string().max(300)).max(8),
});
export type StepFeasibility = z.infer<typeof StepFeasibilitySchema>;

export const SKILL_APPLICABILITY_STATUSES = [
  'not_assessed',
  'no_matching_skill',
  'applies',
  'partially_applies',
] as const;
export const ScenarioSkillApplicabilitySchema = z.object({
  /**
   * `applies`: a governed skill's triggers held at the decision moment and it recommends the path's first step.
   * `partially_applies`: a skill resembled the case at that moment but does not recommend that step, or only some of its
   * triggers held. `no_matching_skill`: skills were checked and none resembled the case then. `not_assessed`: no skill
   * information was available when the scenario was written.
   */
  status: z.enum(SKILL_APPLICABILITY_STATUSES),
  skills: z
    .array(
      z.object({
        skillId: IdSchema,
        name: z.string().max(160),
        /** Share of the skill's trigger weight that held with what was known at the decision moment. */
        triggerCoverage: ProbabilitySchema,
        /** The skill recommends the same first step as the path. */
        recommendsFirstStep: z.boolean(),
      }),
    )
    .max(5),
  note: z.string().max(400),
});
export type ScenarioSkillApplicability = z.infer<typeof ScenarioSkillApplicabilitySchema>;

export const CounterfactualQualitySchema = z.object({
  basis: z.object({
    /** What the figures of the alternative path rest on. */
    scenario: CounterfactualBasisSchema,
    summary: z.string().max(600),
    /** Each part of the comparison and what it rests on (the recorded side is measured, the alternative is not). */
    parts: z
      .array(
        z.object({
          what: z.string().max(160),
          basis: CounterfactualBasisSchema,
          note: z.string().max(360),
        }),
      )
      .min(2)
      .max(6),
  }),
  /** The worst of the steps: whether the path could have been followed at the time. */
  feasibility: z.object({
    level: FeasibilityLevelSchema,
    reasons: z.array(z.string().max(320)).max(12),
  }),
  /** What limits the alternative: who must act, what is not known, what the strategy excludes. */
  constraints: z.array(z.string().max(320)).max(12),
  skillApplicability: ScenarioSkillApplicabilitySchema,
  /** What a reviewer has to confirm before relying on the path. */
  validation: z.array(z.string().max(320)).min(1).max(12),
  /** `estimated_range`: a range is shown and never a single saving. `none`: no saving is claimed at all. */
  timeSavedClaim: z.enum(['estimated_range', 'none']),
});
export type CounterfactualQuality = z.infer<typeof CounterfactualQualitySchema>;

export const CounterfactualStepSchema = z.object({
  id: IdSchema,
  scenarioId: IdSchema,
  index: z.number().int().min(0),
  /** Minutes after the fork instant at which this step is expected to complete. */
  offsetMinutes: RangeSchema,
  simulatedAt: IsoTimestampSchema,
  actionKey: z.string(),
  label: z.string(),
  kind: ActionKindSchema,
  executor: ActionExecutorSchema,
  rationale: z.string().max(900),
  /** Evidence available at or before the fork instant that justifies the step. */
  evidenceUsedIds: z.array(IdSchema),
  /** Earlier simulated steps whose (simulated) output this step builds on. */
  priorStepIds: z.array(IdSchema),
  predictedOutcome: z.object({
    outcomeId: z.string(),
    label: z.string(),
    probability: ProbabilitySchema,
    simulatedResult: z.string(),
    alternatives: z
      .array(z.object({ outcomeId: z.string(), label: z.string(), probability: ProbabilitySchema }))
      .max(PREDICTED_OUTCOME_ALT_LIMIT),
  }),
  expectedInformationGainBits: z.number().min(0),
  posteriorAfter: z.array(
    z.object({
      hypothesisId: IdSchema,
      key: z.string(),
      name: z.string(),
      confidence: ProbabilitySchema,
    }),
  ),
  customerEffort: EffortLevelSchema,
  operationalRisk: ProbabilitySchema,
  tokenEstimate: z.number().int().min(0),
  safe: z.boolean(),
  safetyNotes: z.array(z.string()),
  assumptions: z.array(z.string()),
  supported: z.boolean(),
  unsupportedReasons: z.array(z.string()),
  uncertainty: LevelSchema,
  /** Whether the step could have been taken at the time. Absent on scenarios stored before engine 2026.4.0. */
  feasibility: StepFeasibilitySchema.optional(),
  /** Every step is simulated, always. */
  simulated: z.literal(true),
});
export type CounterfactualStep = z.infer<typeof CounterfactualStepSchema>;

export const CounterfactualScenarioSchema = RecordMetaSchema.extend({
  id: IdSchema,
  caseId: IdSchema,
  forkId: IdSchema,
  analysisRunId: IdSchema,
  modelExecutionId: IdSchema.nullable(),
  status: z.enum(['completed', 'rejected', 'failed']),
  strategy: CounterfactualStrategySchema,
  label: z.string(),
  summary: z.string(),
  boundary: z.object({
    asOf: IsoTimestampSchema,
    eventIds: z.array(IdSchema),
    evidenceIds: z.array(IdSchema),
    eventCount: z.number().int().min(0),
    leakCheck: z.object({
      passed: z.boolean(),
      checkedAt: IsoTimestampSchema,
      futureReferencesFound: z.number().int().min(0),
      resolutionExcluded: z.boolean(),
      details: z.array(z.string()),
    }),
  }),
  steps: z.array(CounterfactualStepSchema),
  branchNotes: z.array(
    z.object({
      afterStepIndex: z.number().int().min(0),
      condition: z.string(),
      thenAction: z.string(),
      probability: ProbabilitySchema,
    }),
  ),
  assumptions: z.array(z.string()),
  rollouts: z.object({
    count: z.number().int().min(1),
    seed: z.string(),
    modalPathShare: ProbabilitySchema,
    diagnosisReachedShare: ProbabilitySchema,
  }),
  actualMetrics: PathMetricsSchema,
  counterfactualMetrics: PathMetricsSchema,
  /** Signed improvement per metric: positive means the counterfactual is better (less cost). */
  improvements: z.record(z.string(), z.number().nullable()),
  comparisonConfidence: z.object({
    level: LevelSchema,
    score: ProbabilitySchema,
    rationale: z.string(),
  }),
  /** Counterfactual validity rules (section 10 of the specification). */
  validity: z.object({ valid: z.boolean(), checks: z.array(EligibilityCheckSchema) }),
  labels: z.object({ simulated: z.literal(true), estimated: z.literal(true) }),
  /** How far to trust the path. Absent on scenarios stored before engine 2026.4.0. */
  quality: CounterfactualQualitySchema.optional(),
  reviewState: ReviewStateSchema,
  reviewReason: z.string().nullable(),
  reviewedBy: z.string().nullable(),
  reviewedAt: IsoTimestampSchema.nullable(),
});
export type CounterfactualScenario = z.infer<typeof CounterfactualScenarioSchema>;

/** Post-hoc evaluation. May use the final resolution; never feeds generation. */
export const HindsightCheckSchema = z.object({
  scenarioId: IdSchema,
  caseId: IdSchema,
  computedAt: IsoTimestampSchema,
  usedFinalResolution: z.literal(true),
  notice: z.string(),
  resolutionHypothesisKey: z.string().nullable(),
  leadingHypothesisAtEndOfPath: z
    .object({ key: z.string(), name: z.string(), confidence: ProbabilitySchema })
    .nullable(),
  consistentWithResolution: z.boolean().nullable(),
  simulatedTimeToDiagnosisMinutes: RangeSchema.nullable(),
  actualTimeToDiagnosisMinutes: z.number().nullable(),
  explanation: z.string(),
});
export type HindsightCheck = z.infer<typeof HindsightCheckSchema>;

export const RunCounterfactualBodySchema = z.object({
  strategies: z
    .array(CounterfactualStrategySchema)
    .min(1)
    .max(3)
    .default([...COUNTERFACTUAL_STRATEGIES]),
});
export type RunCounterfactualBody = z.infer<typeof RunCounterfactualBodySchema>;

export const ReviewCounterfactualBodySchema = z.object({
  decision: z.enum(['accept', 'reject']),
  reason: z.string().min(5).max(1000),
  expectedVersion: z.number().int().min(1),
});
export type ReviewCounterfactualBody = z.infer<typeof ReviewCounterfactualBodySchema>;
