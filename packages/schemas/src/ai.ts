import { z } from 'zod';
import { IdSchema, IsoTimestampSchema, ProbabilitySchema, RecordMetaSchema } from './common';
import { AgentNameSchema, ProviderKindSchema } from './enums';
import { SemverSchema } from './skill';

export const PromptVersionSchema = RecordMetaSchema.extend({
  id: IdSchema,
  agent: AgentNameSchema,
  version: SemverSchema,
  /** SHA-256 of `template`; recorded on every model execution so results are reproducible. */
  templateHash: z.string().regex(/^[a-f0-9]{64}$/),
  template: z.string().max(30_000),
  outputSchemaId: z.string().max(80),
  status: z.enum(['active', 'draft', 'retired']),
  changeNote: z.string().max(500),
});
export type PromptVersion = z.infer<typeof PromptVersionSchema>;

export const ValidationOutcomeSchema = z.object({
  schemaValid: z.boolean(),
  citationsValid: z.boolean(),
  policyValid: z.boolean(),
  temporalValid: z.boolean(),
  issues: z.array(z.string().max(400)).max(50),
});
export type ValidationOutcome = z.infer<typeof ValidationOutcomeSchema>;

export const EXECUTION_STATUSES = [
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
  'cache_hit',
  'rejected_by_validation',
  'circuit_open',
  'budget_exceeded',
] as const;
export const ExecutionStatusSchema = z.enum(EXECUTION_STATUSES);
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;

export const ModelExecutionSchema = RecordMetaSchema.extend({
  id: IdSchema,
  caseId: IdSchema.nullable(),
  analysisRunId: IdSchema.nullable(),
  agent: AgentNameSchema,
  promptVersionId: IdSchema,
  promptVersion: SemverSchema,
  provider: ProviderKindSchema,
  model: z.string().max(120),
  status: ExecutionStatusSchema,
  attempts: z.number().int().min(0),
  latencyMs: z.number().int().min(0),
  startedAt: IsoTimestampSchema,
  completedAt: IsoTimestampSchema,
  inputEvidenceIds: z.array(IdSchema).max(500),
  validation: ValidationOutcomeSchema,
  /** Sanitised error code/message. Never contains prompts, secrets or stack traces. */
  error: z.string().max(400).nullable(),
  simulated: z.boolean(),
  tokenUsageId: IdSchema.nullable(),
  /**
   * Additive (optional) provenance fields. Hashes identify the exact instructions and the
   * minimised context without storing either (prompts and raw model output are not persisted).
   */
  promptHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable()
    .optional(),
  inputHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable()
    .optional(),
  /** Why the returned result came from deterministic code instead of the model; null when it did not. */
  fallbackReason: z.string().max(300).nullable().optional(),
  /** What produced the result that was returned to the caller. */
  resultSource: z.enum(['model', 'cache', 'deterministic', 'deterministic_fallback']).optional(),
  /** Transport-level retries (429/5xx/network) performed inside provider calls. */
  retries: z.number().int().min(0).optional(),
  /** Validator-feedback repair attempts (0 or 1). */
  repairAttempts: z.number().int().min(0).optional(),
});
export type ModelExecution = z.infer<typeof ModelExecutionSchema>;

export const TokenUsageSchema = RecordMetaSchema.extend({
  id: IdSchema,
  modelExecutionId: IdSchema,
  caseId: IdSchema.nullable(),
  agent: AgentNameSchema,
  provider: ProviderKindSchema,
  model: z.string(),
  promptTokens: z.number().int().min(0),
  completionTokens: z.number().int().min(0),
  cachedTokens: z.number().int().min(0),
  totalTokens: z.number().int().min(0),
  /** Null when no unit prices are configured (pricing is never hard-coded; assumption A-16). */
  estimatedCostUsd: z.number().min(0).nullable(),
  contextTokensBefore: z.number().int().min(0),
  contextTokensAfter: z.number().int().min(0),
  compressionRatio: z.number().min(0).max(1),
  cacheHit: z.boolean(),
  earlyStopped: z.boolean(),
  estimatedSavingsTokens: z.number().int().min(0),
  estimatedQualityImpact: z.object({
    level: z.enum(['none', 'negligible', 'possible_minor', 'unknown']),
    note: z.string().max(300),
  }),
  latencyMs: z.number().int().min(0),
  simulated: z.boolean(),
  estimated: z.literal(true),
  /** Additive (optional): whether the token counts were reported by the provider or estimated. */
  tokenSource: z.enum(['measured', 'estimated']).optional(),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

export const ModelExecutionWithUsageSchema = ModelExecutionSchema.extend({
  usage: TokenUsageSchema.nullable(),
});
export type ModelExecutionWithUsage = z.infer<typeof ModelExecutionWithUsageSchema>;

export const ProviderStatusSchema = z.object({
  kind: ProviderKindSchema,
  configured: z.boolean(),
  healthy: z.boolean().nullable(),
  model: z.string(),
  /** True for the deterministic provider: values are synthetic and labelled as such. */
  simulated: z.boolean(),
  checkedAt: IsoTimestampSchema,
  detail: z.string().max(400),
  /** Honest statement of what has and has not been validated against a live service. */
  validationNote: z.string().max(400),
  limits: z.object({
    maxInputTokens: z.number().int(),
    maxOutputTokens: z.number().int(),
    timeoutMs: z.number().int(),
    maxRetries: z.number().int(),
  }),
});
export type ProviderStatus = z.infer<typeof ProviderStatusSchema>;

export const AgentEfficiencySchema = z.object({
  agent: AgentNameSchema,
  executions: z.number().int().min(0),
  promptTokens: z.number().int().min(0),
  completionTokens: z.number().int().min(0),
  cachedTokens: z.number().int().min(0),
  avgLatencyMs: z.number().min(0),
  cacheHitRate: ProbabilitySchema,
  failures: z.number().int().min(0),
  estimatedSavingsTokens: z.number().int().min(0),
  budgetUtilization: ProbabilitySchema,
});
export type AgentEfficiency = z.infer<typeof AgentEfficiencySchema>;

export const EfficiencyOverviewSchema = z.object({
  generatedAt: IsoTimestampSchema,
  totals: z.object({
    executions: z.number().int().min(0),
    promptTokens: z.number().int().min(0),
    completionTokens: z.number().int().min(0),
    cachedTokens: z.number().int().min(0),
    totalTokens: z.number().int().min(0),
    estimatedCostUsd: z.number().min(0).nullable(),
    avgLatencyMs: z.number().min(0),
    cacheHitRate: ProbabilitySchema,
    failureRate: ProbabilitySchema,
  }),
  byAgent: z.array(AgentEfficiencySchema),
  byModel: z.array(
    z.object({
      model: z.string(),
      provider: ProviderKindSchema,
      executions: z.number().int().min(0),
      totalTokens: z.number().int().min(0),
      avgLatencyMs: z.number().min(0),
    }),
  ),
  savings: z.object({
    contextCompressionTokens: z.number().int().min(0),
    duplicateRemovalTokens: z.number().int().min(0),
    cacheHitTokens: z.number().int().min(0),
    earlyStopTokens: z.number().int().min(0),
    totalTokens: z.number().int().min(0),
    estimatedQualityImpact: z.string(),
  }),
  /** A limit that is not configured is null: unset never reads as zero or as an invented default. */
  budgets: z.object({
    perRequestMaxTokens: z.number().int().nullable(),
    perCaseMaxTokens: z.number().int().nullable(),
    perDayMaxTokens: z.number().int().nullable(),
    consumedToday: z.number().int().min(0),
    costLimitUsdPerDay: z.number().nullable(),
  }),
  circuitBreakers: z.array(
    z.object({
      name: z.string(),
      state: z.enum(['closed', 'open', 'half_open']),
      consecutiveFailures: z.number().int().min(0),
      openedAt: IsoTimestampSchema.nullable(),
    }),
  ),
  /** Tokens spent in the original support process versus the counterfactual path (both estimated). */
  caseProcess: z.object({
    actualTokens: z.number().int().min(0),
    counterfactualTokens: z.number().int().min(0).nullable(),
    estimatedSavingsPct: z.number().nullable(),
    caseId: IdSchema.nullable(),
  }),
  labels: z.object({ simulated: z.boolean(), estimated: z.literal(true) }),
  notes: z.array(z.string()),
});
export type EfficiencyOverview = z.infer<typeof EfficiencyOverviewSchema>;
