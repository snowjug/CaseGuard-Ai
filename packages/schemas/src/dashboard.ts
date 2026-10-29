import { z } from 'zod';
import { IdSchema, IsoTimestampSchema, ProbabilitySchema } from './common';
import { CaseSummarySchema } from './case';
import { MissingEvidenceSchema } from './analysis';
import { CaseWarningSchema, MetricUnitSchema } from './quality';
import { SkillDnaSchema } from './skill';
import { AppEnvironmentSchema } from './identity';
import { ProviderStatusSchema } from './ai';
import { ForkCategorySchema, ProviderKindSchema } from './enums';

// ---------------------------------------------------------------- system health

export const HealthStatusSchema = z.enum([
  'healthy',
  'degraded',
  'unhealthy',
  'unknown',
  'disabled',
]);
export type HealthStatus = z.infer<typeof HealthStatusSchema>;

export const DependencyHealthSchema = z.object({
  name: z.string(),
  kind: z.enum([
    'database',
    'migrations',
    'ai_provider',
    'search',
    'cache',
    'storage',
    'identity',
    'telemetry',
  ]),
  status: HealthStatusSchema,
  latencyMs: z.number().min(0).nullable(),
  detail: z.string().max(400),
  checkedAt: IsoTimestampSchema,
  /** True when the dependency is an in-process or synthetic stand-in (honest labelling). */
  simulated: z.boolean(),
});
export type DependencyHealth = z.infer<typeof DependencyHealthSchema>;

export const RequestMetricsSchema = z.object({
  since: IsoTimestampSchema,
  totalRequests: z.number().int().min(0),
  errorRequests: z.number().int().min(0),
  errorRate: ProbabilitySchema,
  latencyMs: z.object({ p50: z.number(), p95: z.number(), p99: z.number(), max: z.number() }),
  byRoute: z
    .array(
      z.object({
        route: z.string(),
        method: z.string(),
        count: z.number().int().min(0),
        errors: z.number().int().min(0),
        p95Ms: z.number(),
      }),
    )
    .max(100),
  modelExecutions: z.object({
    total: z.number().int().min(0),
    failures: z.number().int().min(0),
    avgLatencyMs: z.number().min(0),
  }),
  securityEvents: z.object({
    authFailures: z.number().int().min(0),
    forbidden: z.number().int().min(0),
    rateLimited: z.number().int().min(0),
    injectionFlags: z.number().int().min(0),
  }),
});
export type RequestMetrics = z.infer<typeof RequestMetricsSchema>;

export const SystemHealthSchema = z.object({
  status: HealthStatusSchema,
  service: z.string(),
  version: z.string(),
  commit: z.string().nullable(),
  environment: AppEnvironmentSchema,
  uptimeSeconds: z.number().int().min(0),
  checkedAt: IsoTimestampSchema,
  dependencies: z.array(DependencyHealthSchema),
  migrations: z.object({
    applied: z.number().int().min(0),
    pending: z.number().int().min(0),
    latest: z.string().nullable(),
  }),
  provider: ProviderStatusSchema,
  notices: z.array(z.string()),
});
export type SystemHealth = z.infer<typeof SystemHealthSchema>;

export const SystemHealthSummarySchema = z.object({
  status: HealthStatusSchema,
  healthy: z.number().int().min(0),
  degraded: z.number().int().min(0),
  unhealthy: z.number().int().min(0),
  providerKind: ProviderKindSchema,
  providerSimulated: z.boolean(),
});
export type SystemHealthSummary = z.infer<typeof SystemHealthSummarySchema>;

// ---------------------------------------------------------------- command center

export const MetricCardSchema = z.object({
  key: z.string(),
  label: z.string(),
  value: z.number().nullable(),
  display: z.string(),
  unit: MetricUnitSchema,
  status: z.enum(['good', 'watch', 'poor', 'unknown']),
  trend: z
    .object({ direction: z.enum(['up', 'down', 'flat']), delta: z.number(), label: z.string() })
    .nullable(),
  /** Plain-language definition shown in the explainer popover (required on every card). */
  definition: z.string(),
  formula: z.string().nullable(),
  range: z.object({ low: z.number(), high: z.number() }).nullable(),
  estimated: z.boolean(),
  synthetic: z.boolean(),
  /** Click-through to the underlying evidence. */
  evidenceLink: z.object({ href: z.string(), label: z.string() }).nullable(),
  caseId: IdSchema.nullable(),
});
export type MetricCard = z.infer<typeof MetricCardSchema>;

export const CommandCenterSchema = z.object({
  generatedAt: IsoTimestampSchema,
  activeCase: CaseSummarySchema.nullable(),
  metrics: z.array(MetricCardSchema),
  criticalMissingEvidence: z.array(MissingEvidenceSchema.extend({ caseId: IdSchema })),
  leadingHypothesis: z
    .object({
      hypothesisId: IdSchema,
      name: z.string(),
      confidence: ProbabilitySchema,
      low: ProbabilitySchema,
      high: ProbabilitySchema,
      caseId: IdSchema,
    })
    .nullable(),
  skillMatch: z
    .object({
      skillId: IdSchema,
      name: z.string(),
      version: z.string(),
      score: ProbabilitySchema,
      applicability: z.enum(['applies', 'partial', 'not_applicable']),
      caseId: IdSchema,
    })
    .nullable(),
  openWarnings: z.array(CaseWarningSchema),
  recentCases: z.array(CaseSummarySchema),
  skillCandidates: z.array(SkillDnaSchema),
  systemHealth: SystemHealthSummarySchema,
  notices: z.array(z.string()),
});
export type CommandCenter = z.infer<typeof CommandCenterSchema>;

// ---------------------------------------------------------------- analytics

export const AnalyticsOverviewSchema = z.object({
  generatedAt: IsoTimestampSchema,
  cohort: z.object({
    caseCount: z.number().int().min(0),
    analyzedCaseCount: z.number().int().min(0),
    syntheticCaseCount: z.number().int().min(0),
    /** Sample-size caveat, e.g. "n=2: trends are illustrative only". */
    note: z.string(),
  }),
  qualityTrend: z.array(
    z.object({
      period: z.string(),
      caseCount: z.number().int().min(0),
      avgQuality: z.number().nullable(),
      avgEvidenceIntegrity: z.number().nullable(),
    }),
  ),
  forkCategories: z.array(
    z.object({ category: ForkCategorySchema, count: z.number().int(), share: ProbabilitySchema }),
  ),
  missingEvidence: z.array(
    z.object({ requirementId: z.string(), label: z.string(), count: z.number().int() }),
  ),
  avoidableEffortPatterns: z.array(
    z.object({
      component: z.string(),
      label: z.string(),
      avgAvoidablePct: z.number(),
      caseCount: z.number().int(),
    }),
  ),
  skillAdoption: z.object({
    totalSkills: z.number().int(),
    published: z.number().int(),
    pilotOrValidated: z.number().int(),
    matchedCases: z.number().int(),
    appliedCases: z.number().int(),
  }),
  skillEffectiveness: z.array(
    z.object({
      skillId: IdSchema,
      name: z.string(),
      applications: z.number().int(),
      timeToDiagnosisDeltaPct: z.number().nullable(),
      synthetic: z.boolean(),
    }),
  ),
  tokenEfficiency: z.object({
    avgBitsPer1kTokens: z.number().nullable(),
    avgEstimatedSavingsPct: z.number().nullable(),
  }),
  counterfactualAcceptance: z.object({
    reviewed: z.number().int(),
    accepted: z.number().int(),
    rejected: z.number().int(),
    rate: ProbabilitySchema.nullable(),
  }),
  reviewerDisagreement: z.object({
    reviewedClaims: z.number().int(),
    corrected: z.number().int(),
    rate: ProbabilitySchema.nullable(),
  }),
  frequentUnsupportedAssumptions: z.array(
    z.object({ subject: z.string(), count: z.number().int() }),
  ),
  /** Mandatory: analytics never rank or evaluate individual employees. */
  responsibleUseNotice: z.string(),
  privacyNotes: z.array(z.string()),
});
export type AnalyticsOverview = z.infer<typeof AnalyticsOverviewSchema>;

// ---------------------------------------------------------------- compare two cases

export const CaseComparisonRowSchema = z.object({
  metric: z.string(),
  label: z.string(),
  unit: z.string(),
  values: z.array(
    z.object({ caseId: IdSchema, value: z.number().nullable(), display: z.string() }),
  ),
  betterCaseId: IdSchema.nullable(),
  deltaPct: z.number().nullable(),
  note: z.string(),
});
export type CaseComparisonRow = z.infer<typeof CaseComparisonRowSchema>;

export const CaseComparisonSchema = z.object({
  generatedAt: IsoTimestampSchema,
  cases: z.array(CaseSummarySchema).min(2).max(2),
  rows: z.array(CaseComparisonRowSchema),
  narrative: z.array(z.string()),
  skillReuse: z
    .object({
      skillId: IdSchema,
      skillName: z.string(),
      skillVersion: z.string(),
      matchScore: ProbabilitySchema,
      conformance: ProbabilitySchema.nullable(),
      stepsFollowed: z.number().int(),
      stepsTotal: z.number().int(),
    })
    .nullable(),
  /** Honest label required wherever improvement is shown (assumption A-10). */
  notice: z.string(),
  labels: z.object({ synthetic: z.boolean(), estimated: z.literal(true) }),
});
export type CaseComparison = z.infer<typeof CaseComparisonSchema>;

// ---------------------------------------------------------------- global search

export const SearchResultSchema = z.object({
  type: z.enum(['case', 'claim', 'hypothesis', 'skill', 'warning', 'event']),
  id: z.string(),
  caseId: IdSchema.nullable(),
  title: z.string(),
  snippet: z.string().max(300),
  href: z.string(),
  score: z.number(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

// ---------------------------------------------------------------- demo / presentation mode

export const DemoStepSchema = z.object({
  id: z.string(),
  order: z.number().int().min(1),
  title: z.string(),
  description: z.string(),
  presenterNotes: z.string(),
  /** Role the presenter should be acting as for this step. */
  persona: z.enum(['engineer', 'reviewer', 'manager', 'skill_curator', 'administrator']),
  actionLabel: z.string(),
  /** Route the primary action leads to (deep link). */
  route: z.string(),
  completed: z.boolean(),
  /** Steps unlock in order; a locked step explains why. */
  enabled: z.boolean(),
  lockedReason: z.string().nullable(),
  isNextAction: z.boolean(),
});
export type DemoStep = z.infer<typeof DemoStepSchema>;

export const DemoStateSchema = z.object({
  steps: z.array(DemoStepSchema),
  seededAt: IsoTimestampSchema.nullable(),
  datasetLabel: z.string(),
  provider: ProviderKindSchema,
  providerSimulated: z.boolean(),
  caseOneId: IdSchema.nullable(),
  caseTwoId: IdSchema.nullable(),
  skillId: IdSchema.nullable(),
  notices: z.array(z.string()),
});
export type DemoState = z.infer<typeof DemoStateSchema>;

export const DemoSeedBodySchema = z.object({
  profile: z.enum(['base', 'portfolio']).default('base'),
});
export type DemoSeedBody = z.infer<typeof DemoSeedBodySchema>;
