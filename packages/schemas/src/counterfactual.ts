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
