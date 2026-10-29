import { z } from 'zod';
import { IdSchema, IsoTimestampSchema, ProbabilitySchema, RecordMetaSchema } from './common';
import { EffortLevelSchema, LevelSchema, SkillLifecycleSchema } from './enums';

export const SemverSchema = z.string().regex(/^\d+\.\d+\.\d+$/);

export const SkillConditionSchema = z.object({
  id: z.string().max(80),
  description: z.string().max(400),
  kind: z.enum(['signal', 'attribute', 'text']),
  /** Knowledge-pack signal id when kind = signal. */
  signalId: z.string().optional(),
  /** Case attribute (e.g. `scope.multi_user`) when kind = attribute. */
  attribute: z.string().optional(),
  /** Case-insensitive regular expression when kind = text. */
  pattern: z.string().max(300).optional(),
  weight: ProbabilitySchema,
  /** A required trigger must hold for the skill to be applicable at all. */
  required: z.boolean(),
});
export type SkillCondition = z.infer<typeof SkillConditionSchema>;

export const DecisionStepSchema = z.object({
  id: z.string().max(60),
  order: z.number().int().min(1),
  title: z.string().max(200),
  instruction: z.string().max(1200),
  actionKey: z.string().nullable(),
  expectedInformationGainBits: z.number().min(0).nullable(),
  requiresInputs: z.array(z.string()),
  /** `next` is a step id, or one of `stop`, `escalate`, `success`. */
  branches: z.array(
    z.object({
      condition: z.string().max(300),
      outcomeId: z.string().optional(),
      next: z.string().max(60),
      rationale: z.string().max(400),
    }),
  ),
});
export type DecisionStep = z.infer<typeof DecisionStepSchema>;

export const QueryTemplateSchema = z.object({
  id: z.string().max(60),
  language: z.enum(['kql', 'powershell']),
  title: z.string().max(160),
  description: z.string().max(400),
  /** Parameterised with `{{name}}` placeholders; never contains customer data. */
  template: z.string().max(4000),
  parameters: z.array(z.object({ name: z.string().max(60), description: z.string().max(200) })),
  safetyNote: z.string().max(300),
});
export type QueryTemplate = z.infer<typeof QueryTemplateSchema>;

export const SkillContentSchema = z.object({
  name: z.string().min(5).max(160),
  description: z.string().max(1200),
  product: z.string().max(100),
  workload: z.string().max(80),
  triggerConditions: z.array(SkillConditionSchema).min(1),
  exclusions: z.array(SkillConditionSchema),
  requiredInputs: z.array(
    z.object({
      key: z.string().max(60),
      label: z.string().max(120),
      description: z.string().max(300),
      required: z.boolean(),
    }),
  ),
  minimumEvidence: z.array(
    z.object({
      requirementId: z.string(),
      label: z.string().max(160),
      description: z.string().max(300),
    }),
  ),
  decisionSequence: z.array(DecisionStepSchema).min(1),
  candidateActions: z.array(
    z.object({
      actionKey: z.string(),
      label: z.string().max(160),
      whenToUse: z.string().max(300),
      risk: LevelSchema,
      customerEffort: EffortLevelSchema,
      requiresApproval: z.boolean(),
    }),
  ),
  stopConditions: z.array(z.string().max(300)),
  successConditions: z.array(z.string().max(300)),
  escalationConditions: z.array(z.string().max(300)),
  safetyConstraints: z.array(z.string().max(300)).min(1),
  queryTemplates: z.array(QueryTemplateSchema),
  knownFailureModes: z.array(z.string().max(300)),
  sourceCases: z.array(
    z.object({
      caseId: IdSchema,
      reference: z.string(),
      role: z.enum(['origin', 'validation', 'mutation_source']),
    }),
  ),
  confidence: z.object({ score: ProbabilitySchema, rationale: z.string().max(500) }),
});
export type SkillContent = z.infer<typeof SkillContentSchema>;

export const SkillValidationStatusSchema = z.enum([
  'unvalidated',
  'simulation_passed',
  'expert_reviewed',
  'pilot_validated',
  'validated',
]);
export type SkillValidationStatus = z.infer<typeof SkillValidationStatusSchema>;

export const SkillEffectivenessSchema = z.object({
  applications: z.number().int().min(0),
  matchedCases: z.number().int().min(0),
  avgTimeToDiagnosisMinutes: z.number().nullable(),
  baselineAvgTimeToDiagnosisMinutes: z.number().nullable(),
  conformanceAvg: ProbabilitySchema.nullable(),
  estimatedTokenSavingsPct: z.number().nullable(),
  notes: z.array(z.string()),
  /** True while every contributing case is synthetic: figures demonstrate the pipeline only. */
  synthetic: z.boolean(),
  estimated: z.literal(true),
});
export type SkillEffectiveness = z.infer<typeof SkillEffectivenessSchema>;

export const SkillDnaSchema = RecordMetaSchema.extend({
  id: IdSchema,
  key: z.string().regex(/^[a-z0-9][a-z0-9-]{2,60}$/),
  name: z.string(),
  description: z.string(),
  workload: z.string(),
  product: z.string(),
  lifecycle: SkillLifecycleSchema,
  currentVersionId: IdSchema,
  currentVersion: SemverSchema,
  owner: z.string(),
  reviewer: z.string().nullable(),
  validationStatus: SkillValidationStatusSchema,
  lastValidatedAt: IsoTimestampSchema.nullable(),
  confidence: ProbabilitySchema,
  sourceCaseIds: z.array(IdSchema),
  effectiveness: SkillEffectivenessSchema,
  hasProposedMutation: z.boolean(),
  synthetic: z.boolean(),
});
export type SkillDna = z.infer<typeof SkillDnaSchema>;

export const SkillVersionStateSchema = z.enum(['proposed', 'active', 'superseded', 'rejected']);
export type SkillVersionState = z.infer<typeof SkillVersionStateSchema>;

export const SkillVersionSchema = RecordMetaSchema.extend({
  id: IdSchema,
  skillId: IdSchema,
  version: SemverSchema,
  sequence: z.number().int().min(1),
  parentVersionId: IdSchema.nullable(),
  changeType: z.enum(['initial', 'mutation', 'rollback', 'edit']),
  changeSummary: z.string().max(600),
  state: SkillVersionStateSchema,
  lifecycleAtCreation: SkillLifecycleSchema,
  content: SkillContentSchema,
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type SkillVersion = z.infer<typeof SkillVersionSchema>;

export const SkillValidationSchema = RecordMetaSchema.extend({
  id: IdSchema,
  skillId: IdSchema,
  versionId: IdSchema,
  kind: z.enum(['simulation_test', 'expert_review', 'pilot_application', 'regression']),
  outcome: z.enum(['passed', 'failed', 'inconclusive']),
  caseId: IdSchema.nullable(),
  checks: z.array(z.object({ id: z.string(), passed: z.boolean(), detail: z.string() })),
  executedBy: z.string(),
  executedAt: IsoTimestampSchema,
  synthetic: z.boolean(),
});
export type SkillValidation = z.infer<typeof SkillValidationSchema>;

export const SkillApprovalSchema = RecordMetaSchema.extend({
  id: IdSchema,
  skillId: IdSchema,
  versionId: IdSchema,
  fromState: SkillLifecycleSchema,
  toState: SkillLifecycleSchema,
  decision: z.enum(['approved', 'rejected', 'changes_requested']),
  approver: z.string(),
  requestedBy: z.string(),
  reason: z.string().max(1000),
  decidedAt: IsoTimestampSchema,
});
export type SkillApproval = z.infer<typeof SkillApprovalSchema>;

export const SkillMatchStepSchema = z.object({
  stepId: z.string(),
  title: z.string(),
  instruction: z.string(),
  actionKey: z.string().nullable(),
  status: z.enum(['recommended_next', 'done', 'skipped', 'pending']),
  rationale: z.string(),
  actionValue: z.number().nullable(),
});
export type SkillMatchStep = z.infer<typeof SkillMatchStepSchema>;

export const SkillMatchSchema = RecordMetaSchema.extend({
  id: IdSchema,
  caseId: IdSchema,
  skillId: IdSchema,
  versionId: IdSchema,
  skillName: z.string(),
  skillVersion: SemverSchema,
  lifecycle: SkillLifecycleSchema,
  /** Matching only used evidence available at or before this instant. */
  asOf: IsoTimestampSchema,
  score: ProbabilitySchema,
  applicability: z.enum(['applies', 'partial', 'not_applicable']),
  matchedTriggers: z.array(
    z.object({
      id: z.string(),
      description: z.string(),
      weight: ProbabilitySchema,
      evidenceIds: z.array(IdSchema),
    }),
  ),
  unmatchedTriggers: z.array(
    z.object({ id: z.string(), description: z.string(), weight: ProbabilitySchema }),
  ),
  exclusionsHit: z.array(z.object({ id: z.string(), description: z.string() })),
  rationale: z.string(),
  recommendedSteps: z.array(SkillMatchStepSchema),
  conformance: z
    .object({
      stepsFollowed: z.number().int().min(0),
      stepsTotal: z.number().int().min(0),
      score: ProbabilitySchema,
    })
    .nullable(),
  applied: z.boolean(),
  appliedAt: IsoTimestampSchema.nullable(),
  appliedBy: z.string().nullable(),
});
export type SkillMatch = z.infer<typeof SkillMatchSchema>;

export const SkillDiffChangeSchema = z.object({
  section: z.string(),
  type: z.enum(['added', 'removed', 'modified']),
  path: z.string(),
  before: z.string().nullable(),
  after: z.string().nullable(),
  /** Human-readable sentence, e.g. "Added step 3: Compare proxy nodes one by one". */
  summary: z.string(),
});
export type SkillDiffChange = z.infer<typeof SkillDiffChangeSchema>;

export const SkillDiffSchema = z.object({
  skillId: IdSchema,
  fromVersion: SemverSchema,
  toVersion: SemverSchema,
  changes: z.array(SkillDiffChangeSchema),
  summaryLines: z.array(z.string()),
});
export type SkillDiff = z.infer<typeof SkillDiffSchema>;

// ---------------------------------------------------------------- request bodies

export const ExtractSkillBodySchema = z.object({
  /** Accepted counterfactual scenario the skill is distilled from. */
  scenarioId: IdSchema,
});
export type ExtractSkillBody = z.infer<typeof ExtractSkillBodySchema>;

export const SkillTransitionBodySchema = z.object({
  toState: SkillLifecycleSchema,
  reason: z.string().min(5).max(1000),
  /** Optimistic lock: the skill `version` the caller last saw. */
  expectedVersion: z.number().int().min(1),
});
export type SkillTransitionBody = z.infer<typeof SkillTransitionBodySchema>;

export const ProposeMutationBodySchema = z.object({
  sourceCaseId: IdSchema,
});
export type ProposeMutationBody = z.infer<typeof ProposeMutationBodySchema>;

export const SkillVersionDecisionBodySchema = z.object({
  decision: z.enum(['approve', 'reject']),
  reason: z.string().min(5).max(1000),
  expectedVersion: z.number().int().min(1),
});
export type SkillVersionDecisionBody = z.infer<typeof SkillVersionDecisionBodySchema>;

export const SkillRollbackBodySchema = z.object({
  toVersionId: IdSchema,
  reason: z.string().min(5).max(1000),
  expectedVersion: z.number().int().min(1),
});
export type SkillRollbackBody = z.infer<typeof SkillRollbackBodySchema>;

export const ApplySkillBodySchema = z.object({
  skillId: IdSchema,
});
export type ApplySkillBody = z.infer<typeof ApplySkillBodySchema>;
