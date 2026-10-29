import { z } from 'zod';
import { IdSchema, IsoTimestampSchema, RecordMetaSchema } from './common';
import { RedactionCategorySchema } from './bundle';
import { FeatureFlagsSchema, RoleSchema, DEFAULT_FEATURE_FLAGS } from './identity';
import {
  AgentNameSchema,
  DEFAULT_EFFORT_SCALE,
  DEFAULT_PENALTY_POINTS,
  DEFAULT_QUALITY_WEIGHTS,
  EffortLevelSchema,
  JobStatusSchema,
  PenaltyKeySchema,
  ProviderKindSchema,
  QualityDimensionKeySchema,
} from './enums';

// ---------------------------------------------------------------- governed configuration

export const GOVERNANCE_SECTIONS = [
  'model',
  'quality',
  'action_value',
  'retention',
  'redaction',
  'feature_flags',
  'export_controls',
] as const;
export const GovernanceSectionSchema = z.enum(GOVERNANCE_SECTIONS);
export type GovernanceSection = z.infer<typeof GovernanceSectionSchema>;

export const AgentBudgetSchema = z.object({
  maxInputTokens: z.number().int().min(256).max(200_000),
  maxOutputTokens: z.number().int().min(64).max(32_000),
  maxRetries: z.number().int().min(0).max(5),
  timeoutMs: z.number().int().min(1000).max(300_000),
});
export type AgentBudget = z.infer<typeof AgentBudgetSchema>;

export const ModelConfigSchema = z.object({
  version: z.string(),
  provider: ProviderKindSchema,
  azureDeployment: z.string().max(120),
  azureApiVersion: z.string().max(40),
  temperature: z.number().min(0).max(1),
  maxInputTokens: z.number().int().min(256).max(200_000),
  maxOutputTokens: z.number().int().min(64).max(32_000),
  timeoutMs: z.number().int().min(1000).max(300_000),
  maxRetries: z.number().int().min(0).max(5),
  /** Maximum analysis depth (counterfactual steps and optional refinement passes). */
  maxAnalysisDepth: z.number().int().min(1).max(12),
  agentBudgets: z.record(z.string(), AgentBudgetSchema),
  costLimits: z.object({
    perRequestUsd: z.number().min(0).nullable(),
    perCaseUsd: z.number().min(0).nullable(),
    perDayUsd: z.number().min(0).nullable(),
  }),
  /** Operator-supplied unit prices. Null means "not configured": cost is shown as unknown. */
  unitPrices: z.object({
    inputPer1kUsd: z.number().min(0).nullable(),
    outputPer1kUsd: z.number().min(0).nullable(),
    cachedInputPer1kUsd: z.number().min(0).nullable(),
  }),
  circuitBreaker: z.object({
    failureThreshold: z.number().int().min(1).max(50),
    resetMs: z.number().int().min(1000).max(600_000),
  }),
  semanticCache: z.object({
    enabled: z.boolean(),
    similarityThreshold: z.number().min(0.5).max(1),
    ttlSeconds: z.number().int().min(10).max(86_400),
  }),
  routing: z.object({
    defaultModel: z.string().max(120),
    cheapModel: z.string().max(120).nullable(),
    rules: z.array(z.object({ agent: AgentNameSchema, model: z.string().max(120) })).max(20),
  }),
});
export type ModelConfig = z.infer<typeof ModelConfigSchema>;

const DEFAULT_AGENT_BUDGET: AgentBudget = {
  maxInputTokens: 12_000,
  maxOutputTokens: 3_000,
  maxRetries: 2,
  timeoutMs: 30_000,
};

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  version: '1.0.0',
  provider: 'deterministic',
  azureDeployment: '',
  azureApiVersion: '2024-10-21',
  temperature: 0,
  maxInputTokens: 24_000,
  maxOutputTokens: 4_000,
  timeoutMs: 30_000,
  maxRetries: 2,
  maxAnalysisDepth: 8,
  agentBudgets: {
    timeline_analyzer: { ...DEFAULT_AGENT_BUDGET, maxInputTokens: 8_000 },
    evidence_classifier: { ...DEFAULT_AGENT_BUDGET, maxInputTokens: 16_000 },
    hypothesis_generator: DEFAULT_AGENT_BUDGET,
    decision_fork_detector: DEFAULT_AGENT_BUDGET,
    counterfactual_simulator: { ...DEFAULT_AGENT_BUDGET, maxOutputTokens: 4_000 },
    quality_judge: DEFAULT_AGENT_BUDGET,
    skilldna_extractor: { ...DEFAULT_AGENT_BUDGET, maxOutputTokens: 4_000 },
    communication_coach: { ...DEFAULT_AGENT_BUDGET, maxOutputTokens: 2_000 },
    token_governor: { ...DEFAULT_AGENT_BUDGET, maxInputTokens: 2_000, maxOutputTokens: 500 },
    safety_policy_validator: {
      ...DEFAULT_AGENT_BUDGET,
      maxInputTokens: 4_000,
      maxOutputTokens: 500,
    },
  },
  costLimits: { perRequestUsd: null, perCaseUsd: null, perDayUsd: null },
  unitPrices: { inputPer1kUsd: null, outputPer1kUsd: null, cachedInputPer1kUsd: null },
  circuitBreaker: { failureThreshold: 5, resetMs: 30_000 },
  semanticCache: { enabled: true, similarityThreshold: 0.92, ttlSeconds: 3_600 },
  routing: { defaultModel: 'deterministic-knowledge-pack', cheapModel: null, rules: [] },
};

export const QualityConfigSchema = z.object({
  version: z.string(),
  weights: z.record(QualityDimensionKeySchema, z.number().min(0).max(1)),
  penaltyPoints: z.record(PenaltyKeySchema, z.number().min(0).max(30)),
  /** Maximum total penalty points deducted from the composite (keeps one failure from zeroing a case). */
  penaltyCap: z.number().min(0).max(100),
  bands: z.object({
    strong: z.number().min(0).max(100),
    adequate: z.number().min(0).max(100),
    needsAttention: z.number().min(0).max(100),
  }),
});
export type QualityConfig = z.infer<typeof QualityConfigSchema>;

export const DEFAULT_QUALITY_CONFIG: QualityConfig = {
  version: '1.0.0',
  weights: DEFAULT_QUALITY_WEIGHTS,
  penaltyPoints: DEFAULT_PENALTY_POINTS,
  penaltyCap: 40,
  bands: { strong: 85, adequate: 70, needsAttention: 50 },
};

export const ActionValueConfigSchema = z.object({
  version: z.string(),
  /** Cost-term weights; they should sum to 1 so the denominator stays interpretable. */
  weights: z.object({
    time: z.number().min(0).max(1),
    token: z.number().min(0).max(1),
    customer: z.number().min(0).max(1),
    risk: z.number().min(0).max(1),
  }),
  normalization: z.object({
    maxTimeMinutes: z.number().min(1),
    maxTokens: z.number().min(1),
    /** Information gain (bits) mapped to 1.0 after normalization. */
    maxInformationBits: z.number().min(0.1),
  }),
  effortScale: z.record(EffortLevelSchema, z.number().min(0).max(1)),
  /** Added to the denominator so near-free actions cannot produce unbounded scores. */
  epsilon: z.number().min(0.001).max(1),
  /** Actions at or above this operational risk are blocked from recommendation regardless of score. */
  riskCeiling: z.number().min(0).max(1),
  /** Relative perturbation applied to each weight for the sensitivity display. */
  sensitivityDelta: z.number().min(0.05).max(0.5),
});
export type ActionValueConfig = z.infer<typeof ActionValueConfigSchema>;

export const DEFAULT_ACTION_VALUE_CONFIG: ActionValueConfig = {
  version: '1.0.0',
  weights: { time: 0.3, token: 0.1, customer: 0.35, risk: 0.25 },
  normalization: { maxTimeMinutes: 480, maxTokens: 20_000, maxInformationBits: 2 },
  effortScale: DEFAULT_EFFORT_SCALE,
  epsilon: 0.05,
  riskCeiling: 0.5,
  sensitivityDelta: 0.25,
};

export const RetentionConfigSchema = z.object({
  version: z.string(),
  caseDataDays: z.number().int().min(1).max(3650),
  auditDays: z.number().int().min(30).max(3650),
  modelExecutionDays: z.number().int().min(1).max(3650),
  analyticsDays: z.number().int().min(1).max(3650),
  legalHold: z.boolean(),
});
export type RetentionConfig = z.infer<typeof RetentionConfigSchema>;
export const DEFAULT_RETENTION_CONFIG: RetentionConfig = {
  version: '1.0.0',
  caseDataDays: 365,
  auditDays: 730,
  modelExecutionDays: 90,
  analyticsDays: 365,
  legalHold: false,
};

export const RedactionConfigSchema = z.object({
  version: z.string(),
  enabledCategories: z.array(RedactionCategorySchema),
  /** Extra tenant patterns. Validated for length and compiled with a match-time budget. */
  customPatterns: z
    .array(z.object({ name: z.string().min(1).max(60), pattern: z.string().min(1).max(200) }))
    .max(20),
  redactBeforeModelCalls: z.boolean(),
});
export type RedactionConfig = z.infer<typeof RedactionConfigSchema>;
export const DEFAULT_REDACTION_CONFIG: RedactionConfig = {
  version: '1.0.0',
  enabledCategories: [
    'bearer_token',
    'api_key',
    'connection_string',
    'private_key',
    'password_assignment',
    'jwt',
    'github_token',
    'azure_storage_key',
    'email_address',
    'ipv4_address',
    'phone_number',
  ],
  customPatterns: [],
  redactBeforeModelCalls: true,
};

export const ExportControlsSchema = z.object({
  version: z.string(),
  allowCaseExport: z.boolean(),
  allowAuditExport: z.boolean(),
  allowedFormats: z.array(z.enum(['json'])).min(1),
  requireReasonForExport: z.boolean(),
  maxRecordsPerExport: z.number().int().min(1).max(100_000),
});
export type ExportControls = z.infer<typeof ExportControlsSchema>;
export const DEFAULT_EXPORT_CONTROLS: ExportControls = {
  version: '1.0.0',
  allowCaseExport: true,
  allowAuditExport: true,
  allowedFormats: ['json'],
  requireReasonForExport: true,
  maxRecordsPerExport: 5_000,
};

const SettingEnvelope = <T extends z.ZodType>(value: T) =>
  z.object({
    value,
    /** Optimistic-lock counter incremented on every change. */
    version: z.number().int().min(1),
    updatedAt: IsoTimestampSchema,
    updatedBy: z.string(),
    changeNote: z.string().max(500),
  });

export const GovernanceSettingsSchema = z.object({
  model: SettingEnvelope(ModelConfigSchema),
  quality: SettingEnvelope(QualityConfigSchema),
  action_value: SettingEnvelope(ActionValueConfigSchema),
  retention: SettingEnvelope(RetentionConfigSchema),
  redaction: SettingEnvelope(RedactionConfigSchema),
  feature_flags: SettingEnvelope(FeatureFlagsSchema),
  export_controls: SettingEnvelope(ExportControlsSchema),
});
export type GovernanceSettings = z.infer<typeof GovernanceSettingsSchema>;

export const DEFAULT_GOVERNANCE_VALUES = {
  model: DEFAULT_MODEL_CONFIG,
  quality: DEFAULT_QUALITY_CONFIG,
  action_value: DEFAULT_ACTION_VALUE_CONFIG,
  retention: DEFAULT_RETENTION_CONFIG,
  redaction: DEFAULT_REDACTION_CONFIG,
  feature_flags: DEFAULT_FEATURE_FLAGS,
  export_controls: DEFAULT_EXPORT_CONTROLS,
} as const;

export const UpdateGovernanceBodySchema = z.object({
  /** Validated against the section schema server-side so errors name the exact field. */
  value: z.unknown(),
  expectedVersion: z.number().int().min(1),
  changeNote: z.string().min(5).max(500),
});
export type UpdateGovernanceBody = z.infer<typeof UpdateGovernanceBodySchema>;

export const AssignRolesBodySchema = z.object({
  roles: z.array(RoleSchema).min(1).max(5),
  expectedVersion: z.number().int().min(1),
  reason: z.string().min(5).max(500),
});
export type AssignRolesBody = z.infer<typeof AssignRolesBodySchema>;

// ---------------------------------------------------------------- audit & review

export const AuditEventSchema = z.object({
  id: IdSchema,
  tenantId: IdSchema,
  /** Strictly increasing per tenant; gaps indicate tampering. */
  sequence: z.number().int().min(1),
  occurredAt: IsoTimestampSchema,
  actorId: z.string().max(120),
  actorRole: z.union([RoleSchema, z.literal('system'), z.literal('anonymous')]),
  /** Dot-separated verb, e.g. `case.ingested`, `claim.reclassified`, `skill.published`. */
  action: z.string().max(80),
  targetType: z.string().max(60),
  targetId: z.string().max(120).nullable(),
  caseId: IdSchema.nullable(),
  outcome: z.enum(['success', 'denied', 'failure']),
  /** Redacted structured details. Never contains secrets or raw case content. */
  details: z.record(z.string(), z.unknown()),
  correlationId: z.string().max(80),
  /** Hash chain: sha256(prevHash + canonical JSON of this event without `hash`). */
  prevHash: z.string().max(64),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export const AuditVerificationSchema = z.object({
  valid: z.boolean(),
  eventsChecked: z.number().int().min(0),
  firstInvalidSequence: z.number().int().nullable(),
  checkedAt: IsoTimestampSchema,
  detail: z.string(),
});
export type AuditVerification = z.infer<typeof AuditVerificationSchema>;

export const REVIEW_TARGETS = [
  'claim',
  'fork',
  'counterfactual',
  'warning',
  'skill',
  'skill_version',
  'action_value',
  'hypothesis',
  'twin_field',
] as const;
export const ReviewDecisionSchema = RecordMetaSchema.extend({
  id: IdSchema,
  caseId: IdSchema.nullable(),
  targetType: z.enum(REVIEW_TARGETS),
  targetId: z.string().max(120),
  decision: z.enum([
    'confirm',
    'correct',
    'reject',
    'approve',
    'dismiss',
    'override',
    'request_changes',
  ]),
  originalValue: z.unknown(),
  newValue: z.unknown(),
  reason: z.string().max(1000),
  reviewerId: z.string().max(120),
  reviewerRole: RoleSchema,
  decidedAt: IsoTimestampSchema,
});
export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;

// ---------------------------------------------------------------- jobs

export const JOB_KINDS = [
  'case_analysis',
  'counterfactual',
  'skill_extraction',
  'skill_mutation',
  'demo_seed',
] as const;
export const JobKindSchema = z.enum(JOB_KINDS);
export type JobKind = z.infer<typeof JobKindSchema>;

export const JobStageSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(['pending', 'running', 'done', 'failed', 'skipped']),
  startedAt: IsoTimestampSchema.nullable(),
  completedAt: IsoTimestampSchema.nullable(),
  detail: z.string().max(300).nullable(),
});
export type JobStage = z.infer<typeof JobStageSchema>;

export const JobSchema = z.object({
  id: IdSchema,
  tenantId: IdSchema,
  kind: JobKindSchema,
  status: JobStatusSchema,
  caseId: IdSchema.nullable(),
  targetId: z.string().nullable(),
  progress: z.object({
    percent: z.number().min(0).max(100),
    stage: z.string(),
    stages: z.array(JobStageSchema),
  }),
  error: z.object({ code: z.string(), message: z.string().max(400) }).nullable(),
  resultRef: z.object({ type: z.string(), id: z.string() }).nullable(),
  idempotencyKey: z.string().max(120).nullable(),
  createdAt: IsoTimestampSchema,
  startedAt: IsoTimestampSchema.nullable(),
  completedAt: IsoTimestampSchema.nullable(),
  createdBy: z.string(),
  cancellable: z.boolean(),
});
export type Job = z.infer<typeof JobSchema>;
