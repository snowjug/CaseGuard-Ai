import { z } from 'zod';
import {
  AsOfQuerySchema,
  IdSchema,
  IsoTimestampSchema,
  PageQuerySchema,
  ReviewStateSchema,
  pageOf,
} from './common';
import { AnalysisStateSchema, CaseSummarySchema, DigitalTwinSchema } from './case';
import {
  AuditEventSchema,
  AuditVerificationSchema,
  AssignRolesBodySchema,
  GovernanceSectionSchema,
  GovernanceSettingsSchema,
  JobKindSchema,
  JobSchema,
  UpdateGovernanceBodySchema,
  ReviewDecisionSchema,
} from './governance';
import {
  ActionRankingSchema,
  ClaimSchema,
  DecisionForkSchema,
  DiagnosticActionSchema,
} from './analysis';
import {
  AgentNameSchema,
  CaseStatusSchema,
  EvidenceCategorySchema,
  JobStatusSchema,
  SkillLifecycleSchema,
} from './enums';
import {
  CreateCaseBodySchema,
  ExampleInfoSchema,
  ExportBodySchema,
  ExportResponseSchema,
  IngestResultSchema,
  PersonasResponseSchema,
  PreviewBodySchema,
  SkillDetailSchema,
  StartAnalysisBodySchema,
  StartAnalysisResponseSchema,
} from './api-dtos';
import {
  AnalysisRunSchema,
  CaseDetailSchema,
  EventDetailSchema,
  EvidenceLedgerResponseSchema,
  ForkListResponseSchema,
  HypothesesResponseSchema,
  InvestigationGraphSchema,
  ReviewClaimBodySchema,
  TimelineResponseSchema,
} from './views';
import {
  CounterfactualScenarioSchema,
  HindsightCheckSchema,
  ReviewCounterfactualBodySchema,
  RunCounterfactualBodySchema,
} from './counterfactual';
import {
  CaseWarningSchema,
  CoachingReportSchema,
  DismissWarningBodySchema,
  MetricEstimateSchema,
  QualityAssessmentSchema,
} from './quality';
import {
  ApplySkillBodySchema,
  ExtractSkillBodySchema,
  ProposeMutationBodySchema,
  SimulateSkillBodySchema,
  SkillDiffSchema,
  SkillDnaSchema,
  SkillMatchSchema,
  SkillRollbackBodySchema,
  SkillTransitionBodySchema,
  SkillValidationSchema,
  SkillVersionDecisionBodySchema,
  SkillVersionSchema,
} from './skill';
import {
  AnalyticsOverviewSchema,
  CaseComparisonSchema,
  CommandCenterSchema,
  DemoSeedBodySchema,
  DemoStateSchema,
  RequestMetricsSchema,
  SearchResultSchema,
  SystemHealthSchema,
} from './dashboard';
import {
  EfficiencyOverviewSchema,
  ModelExecutionWithUsageSchema,
  ProviderStatusSchema,
  PromptVersionSchema,
} from './ai';
import { SessionSchema, UserSchema, type Permission } from './identity';
import { SampleBundleInfoSchema, IngestionPreviewSchema } from './bundle';

export const API_PREFIX = '/api/v1';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface RouteSpec {
  readonly method: HttpMethod;
  /** Express-style path with `:param` segments, always starting with the API prefix. */
  readonly path: string;
  readonly summary: string;
  readonly tags: readonly string[];
  /** Required permission; null means any authenticated caller. */
  readonly permission: Permission | null;
  readonly params?: z.ZodType;
  readonly query?: z.ZodType;
  readonly body?: z.ZodType;
  readonly response: z.ZodType;
  /** Success status; defaults to 200. */
  readonly status?: 200 | 201 | 202;
  readonly multipart?: boolean;
  /** Honours the Idempotency-Key header. */
  readonly idempotent?: boolean;
}

// ---------------------------------------------------------------- shared params / queries

const CaseParams = z.object({ caseId: IdSchema });
const CaseForkParams = CaseParams.extend({ forkId: IdSchema });
const CaseScenarioParams = CaseParams.extend({ scenarioId: IdSchema });
const SkillParams = z.object({ skillId: IdSchema });
const csv = z.string().max(500).optional();

const CasesListQuery = PageQuerySchema.extend({
  status: CaseStatusSchema.optional(),
  workload: z.string().max(80).optional(),
  analysisState: AnalysisStateSchema.optional(),
  q: z.string().max(200).optional(),
});
const TimelineQuery = PageQuerySchema.extend({
  asOf: IsoTimestampSchema.optional(),
  /** Comma-separated event types. */
  types: csv,
  /** Comma-separated participant roles. */
  roles: csv,
  hypothesisId: IdSchema.optional(),
  category: EvidenceCategorySchema.optional(),
  /** Overlay the simulated events of this counterfactual scenario. */
  scenarioId: IdSchema.optional(),
  /** Zoom window (inclusive). Both bounds are still clamped to `asOf`. */
  from: IsoTimestampSchema.optional(),
  to: IsoTimestampSchema.optional(),
});
const LedgerQuery = PageQuerySchema.extend({
  asOf: IsoTimestampSchema.optional(),
  category: EvidenceCategorySchema.optional(),
  reviewState: ReviewStateSchema.optional(),
  hypothesisId: IdSchema.optional(),
  q: z.string().max(200).optional(),
});
const WarningsQuery = AsOfQuerySchema.extend({
  state: z.enum(['open', 'resolved', 'dismissed', 'all']).default('all'),
});
const ActionValueQuery = AsOfQuerySchema.extend({
  /** Evaluate at the instant just before this fork's decision. Takes precedence over `asOf`. */
  forkId: IdSchema.optional(),
});
const GraphQuery = AsOfQuerySchema.extend({ scenarioId: IdSchema.optional() });
const SkillsListQuery = PageQuerySchema.extend({
  lifecycle: SkillLifecycleSchema.optional(),
  q: z.string().max(200).optional(),
});
const SkillDiffQuery = z.object({ fromVersionId: IdSchema, toVersionId: IdSchema });
const AuditQuery = PageQuerySchema.extend({
  action: z.string().max(80).optional(),
  actorId: z.string().max(120).optional(),
  caseId: IdSchema.optional(),
  outcome: z.enum(['success', 'denied', 'failure']).optional(),
  from: IsoTimestampSchema.optional(),
  to: IsoTimestampSchema.optional(),
});
const ExecutionsQuery = PageQuerySchema.extend({
  caseId: IdSchema.optional(),
  agent: AgentNameSchema.optional(),
});
const JobsQuery = PageQuerySchema.extend({
  caseId: IdSchema.optional(),
  status: JobStatusSchema.optional(),
  kind: JobKindSchema.optional(),
});
const OverrideActionBody = z.object({
  asOf: IsoTimestampSchema,
  actionKey: z.string().max(80),
  rank: z.number().int().min(1).max(50),
  reason: z.string().min(5).max(500),
});

const Items = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item) });

// ---------------------------------------------------------------- the registry

export const ROUTES = {
  // identity ---------------------------------------------------------------
  'session.me': {
    method: 'GET',
    path: `${API_PREFIX}/me`,
    summary: 'Current user, tenant, permissions and honesty notices',
    tags: ['Identity'],
    permission: null,
    response: SessionSchema,
  },
  'dev.personas': {
    method: 'GET',
    path: `${API_PREFIX}/dev/personas`,
    summary: 'Development personas (only when development identity is enabled)',
    tags: ['Identity'],
    permission: null,
    response: PersonasResponseSchema,
  },

  // ingestion ---------------------------------------------------------------
  'samples.list': {
    method: 'GET',
    path: `${API_PREFIX}/samples`,
    summary: 'Built-in synthetic sample cases',
    tags: ['Ingestion'],
    permission: 'case:read',
    response: Items(SampleBundleInfoSchema),
  },
  'ingestion.preview': {
    method: 'POST',
    path: `${API_PREFIX}/ingestion/preview`,
    summary: 'Validate, redact and preview a case payload without persisting it',
    tags: ['Ingestion'],
    permission: 'case:ingest',
    body: PreviewBodySchema,
    response: IngestionPreviewSchema,
  },
  'ingestion.previewFile': {
    method: 'POST',
    path: `${API_PREFIX}/ingestion/preview-file`,
    summary: 'Preview an uploaded file (multipart/form-data, field "file")',
    tags: ['Ingestion'],
    permission: 'case:ingest',
    multipart: true,
    response: IngestionPreviewSchema,
  },
  'cases.create': {
    method: 'POST',
    path: `${API_PREFIX}/cases`,
    summary: 'Ingest a case (idempotent) and optionally start analysis',
    tags: ['Cases'],
    permission: 'case:ingest',
    body: CreateCaseBodySchema,
    response: IngestResultSchema,
    status: 201,
    idempotent: true,
  },
  'cases.createFromFile': {
    method: 'POST',
    path: `${API_PREFIX}/cases/upload`,
    summary: 'Ingest an uploaded file (multipart/form-data, field "file")',
    tags: ['Cases'],
    permission: 'case:ingest',
    multipart: true,
    response: IngestResultSchema,
    status: 201,
    idempotent: true,
  },
  'schemas.caseBundle': {
    method: 'GET',
    path: `${API_PREFIX}/schemas/case-bundle.schema.json`,
    summary: 'JSON Schema for case bundles',
    tags: ['Ingestion'],
    permission: 'case:read',
    response: z.record(z.string(), z.unknown()),
  },
  'schemas.knowledgePack': {
    method: 'GET',
    path: `${API_PREFIX}/schemas/knowledge-pack.schema.json`,
    summary: 'JSON Schema for workload knowledge packs',
    tags: ['Ingestion'],
    permission: 'case:read',
    response: z.record(z.string(), z.unknown()),
  },
  'examples.list': {
    method: 'GET',
    path: `${API_PREFIX}/examples`,
    summary: 'Downloadable example case bundles (synthetic)',
    tags: ['Ingestion'],
    permission: 'case:read',
    response: Items(ExampleInfoSchema),
  },
  'examples.get': {
    method: 'GET',
    path: `${API_PREFIX}/examples/:exampleId`,
    summary: 'Download one example case bundle',
    tags: ['Ingestion'],
    permission: 'case:read',
    params: z.object({ exampleId: IdSchema }),
    response: z.record(z.string(), z.unknown()),
  },

  // cases -------------------------------------------------------------------
  'cases.list': {
    method: 'GET',
    path: `${API_PREFIX}/cases`,
    summary: 'List cases (paginated)',
    tags: ['Cases'],
    permission: 'case:read',
    query: CasesListQuery,
    response: pageOf(CaseSummarySchema),
  },
  'cases.get': {
    method: 'GET',
    path: `${API_PREFIX}/cases/:caseId`,
    summary: 'Case detail',
    tags: ['Cases'],
    permission: 'case:read',
    params: CaseParams,
    response: CaseDetailSchema,
  },
  'cases.delete': {
    method: 'DELETE',
    path: `${API_PREFIX}/cases/:caseId`,
    summary: 'Delete a case and all derived data (administrator)',
    tags: ['Cases'],
    permission: 'case:delete',
    params: CaseParams,
    response: z.object({ deleted: z.literal(true) }),
  },

  // analysis jobs -----------------------------------------------------------
  'analysis.start': {
    method: 'POST',
    path: `${API_PREFIX}/cases/:caseId/analysis`,
    summary: 'Start (or reuse) the case analysis. Identical input never re-runs.',
    tags: ['Analysis'],
    permission: 'case:analyze',
    params: CaseParams,
    body: StartAnalysisBodySchema,
    response: StartAnalysisResponseSchema,
    status: 202,
    idempotent: true,
  },
  'analysis.latest': {
    method: 'GET',
    path: `${API_PREFIX}/cases/:caseId/analysis`,
    summary: 'Latest analysis run summary',
    tags: ['Analysis'],
    permission: 'case:read',
    params: CaseParams,
    response: z.object({ run: AnalysisRunSchema.nullable() }),
  },
  'jobs.get': {
    method: 'GET',
    path: `${API_PREFIX}/jobs/:jobId`,
    summary: 'Job status and progress',
    tags: ['Jobs'],
    permission: 'case:read',
    params: z.object({ jobId: IdSchema }),
    response: JobSchema,
  },
  'jobs.cancel': {
    method: 'POST',
    path: `${API_PREFIX}/jobs/:jobId/cancel`,
    summary: 'Cancel a queued or running job',
    tags: ['Jobs'],
    // Any signed-in user may ask; the job service then requires the permission that starts that kind of job.
    permission: null,
    params: z.object({ jobId: IdSchema }),
    response: JobSchema,
  },
  'jobs.list': {
    method: 'GET',
    path: `${API_PREFIX}/jobs`,
    summary: 'List jobs (paginated)',
    tags: ['Jobs'],
    permission: 'case:read',
    query: JobsQuery,
    response: pageOf(JobSchema),
  },

  // case artefacts (all honour asOf where relevant) --------------------------
  'twin.get': {
    method: 'GET',
    path: `${API_PREFIX}/cases/:caseId/twin`,
    summary: 'Digital twin, optionally as of a past instant',
    tags: ['Case analysis'],
    permission: 'case:read',
    params: CaseParams,
    query: AsOfQuerySchema,
    response: DigitalTwinSchema,
  },
  'timeline.get': {
    method: 'GET',
    path: `${API_PREFIX}/cases/:caseId/timeline`,
    summary: 'Chronological timeline with filters, delays, repeats and hypothesis series',
    tags: ['Case analysis'],
    permission: 'case:read',
    params: CaseParams,
    query: TimelineQuery,
    response: TimelineResponseSchema,
  },
  'events.get': {
    method: 'GET',
    path: `${API_PREFIX}/cases/:caseId/events/:eventId`,
    summary: 'Source event with derived claims and evidence',
    tags: ['Case analysis'],
    permission: 'case:read',
    params: CaseParams.extend({ eventId: IdSchema }),
    query: AsOfQuerySchema,
    response: EventDetailSchema,
  },
  'evidence.list': {
    method: 'GET',
    path: `${API_PREFIX}/cases/:caseId/evidence`,
    summary: 'Evidence ledger (claims classified into eight categories)',
    tags: ['Case analysis'],
    permission: 'case:read',
    params: CaseParams,
    query: LedgerQuery,
    response: EvidenceLedgerResponseSchema,
  },
  'claims.review': {
    method: 'POST',
    path: `${API_PREFIX}/cases/:caseId/claims/:claimId/review`,
    summary: 'Correct a claim classification (original AI classification is preserved and audited)',
    tags: ['Case analysis'],
    permission: 'evidence:review',
    params: CaseParams.extend({ claimId: IdSchema }),
    body: ReviewClaimBodySchema,
    response: ClaimSchema,
  },
  'hypotheses.list': {
    method: 'GET',
    path: `${API_PREFIX}/cases/:caseId/hypotheses`,
    summary: 'Competing hypotheses with time-indexed confidence',
    tags: ['Case analysis'],
    permission: 'case:read',
    params: CaseParams,
    query: AsOfQuerySchema,
    response: HypothesesResponseSchema,
  },
  'actions.list': {
    method: 'GET',
    path: `${API_PREFIX}/cases/:caseId/actions`,
    summary: 'Diagnostic actions taken in the case',
    tags: ['Case analysis'],
    permission: 'case:read',
    params: CaseParams,
    query: AsOfQuerySchema,
    response: Items(DiagnosticActionSchema),
  },
  'actionValue.rank': {
    method: 'GET',
    path: `${API_PREFIX}/cases/:caseId/action-values`,
    summary: 'Rank next actions: transparent calculation, sensitivity, reviewer overrides',
    tags: ['Case analysis'],
    permission: 'case:read',
    params: CaseParams,
    query: ActionValueQuery,
    response: ActionRankingSchema,
  },
  'actionValue.override': {
    method: 'POST',
    path: `${API_PREFIX}/cases/:caseId/action-values/override`,
    summary: 'Record a reviewer override of the action ranking (audited)',
    tags: ['Case analysis'],
    permission: 'actionvalue:override',
    params: CaseParams,
    body: OverrideActionBody,
    response: ActionRankingSchema,
  },
  'forks.list': {
    method: 'GET',
    path: `${API_PREFIX}/cases/:caseId/forks`,
    summary: 'Decision forks (decision-time view when asOf is given)',
    tags: ['Case analysis'],
    permission: 'case:read',
    params: CaseParams,
    query: AsOfQuerySchema,
    response: ForkListResponseSchema,
  },
  'forks.get': {
    method: 'GET',
    path: `${API_PREFIX}/cases/:caseId/forks/:forkId`,
    summary: 'One decision fork (decision-time view when asOf is given)',
    tags: ['Case analysis'],
    permission: 'case:read',
    params: CaseForkParams,
    query: AsOfQuerySchema,
    response: DecisionForkSchema,
  },
  'counterfactuals.run': {
    method: 'POST',
    path: `${API_PREFIX}/cases/:caseId/forks/:forkId/counterfactuals`,
    summary: 'Generate counterfactual paths for a fork (temporal boundary enforced)',
    tags: ['Counterfactual lab'],
    permission: 'counterfactual:run',
    params: CaseForkParams,
    body: RunCounterfactualBodySchema,
    response: z.object({ job: JobSchema }),
    status: 202,
    idempotent: true,
  },
  'counterfactuals.list': {
    method: 'GET',
    path: `${API_PREFIX}/cases/:caseId/counterfactuals`,
    summary: 'Counterfactual scenarios',
    tags: ['Counterfactual lab'],
    permission: 'case:read',
    params: CaseParams,
    query: z.object({ forkId: IdSchema.optional() }),
    response: Items(CounterfactualScenarioSchema),
  },
  'counterfactuals.get': {
    method: 'GET',
    path: `${API_PREFIX}/cases/:caseId/counterfactuals/:scenarioId`,
    summary: 'One counterfactual scenario',
    tags: ['Counterfactual lab'],
    permission: 'case:read',
    params: CaseScenarioParams,
    response: CounterfactualScenarioSchema,
  },
  'counterfactuals.review': {
    method: 'POST',
    path: `${API_PREFIX}/cases/:caseId/counterfactuals/:scenarioId/review`,
    summary: 'Accept or reject a counterfactual path with a reason (audited)',
    tags: ['Counterfactual lab'],
    permission: 'counterfactual:review',
    params: CaseScenarioParams,
    body: ReviewCounterfactualBodySchema,
    response: CounterfactualScenarioSchema,
  },
  'counterfactuals.hindsight': {
    method: 'GET',
    path: `${API_PREFIX}/cases/:caseId/counterfactuals/:scenarioId/hindsight`,
    summary: 'Post-hoc hindsight check (uses the final resolution; never feeds generation)',
    tags: ['Counterfactual lab'],
    permission: 'quality:review',
    params: CaseScenarioParams,
    response: HindsightCheckSchema,
  },
  'graph.get': {
    method: 'GET',
    path: `${API_PREFIX}/cases/:caseId/graph`,
    summary: 'Investigation graph model (bounded)',
    tags: ['Case analysis'],
    permission: 'case:read',
    params: CaseParams,
    query: GraphQuery,
    response: InvestigationGraphSchema,
  },
  'quality.get': {
    method: 'GET',
    path: `${API_PREFIX}/cases/:caseId/quality`,
    summary: 'Case Quality Index assessment',
    tags: ['Quality'],
    permission: 'quality:read',
    params: CaseParams,
    query: AsOfQuerySchema,
    response: QualityAssessmentSchema,
  },
  'metrics.get': {
    method: 'GET',
    path: `${API_PREFIX}/cases/:caseId/metrics`,
    summary: 'Metric estimates including Avoidable Support Effort',
    tags: ['Quality'],
    permission: 'quality:read',
    params: CaseParams,
    query: AsOfQuerySchema,
    response: Items(MetricEstimateSchema),
  },
  'warnings.list': {
    method: 'GET',
    path: `${API_PREFIX}/cases/:caseId/warnings`,
    summary: 'Live quality warnings as of a time cursor',
    tags: ['Quality'],
    permission: 'case:read',
    params: CaseParams,
    query: WarningsQuery,
    response: Items(CaseWarningSchema),
  },
  'warnings.dismiss': {
    method: 'POST',
    path: `${API_PREFIX}/cases/:caseId/warnings/:warningId/dismiss`,
    summary: 'Dismiss a warning with a reason (audited)',
    tags: ['Quality'],
    permission: 'warning:dismiss',
    params: CaseParams.extend({ warningId: IdSchema }),
    body: DismissWarningBodySchema,
    response: CaseWarningSchema,
  },
  'coaching.get': {
    method: 'GET',
    path: `${API_PREFIX}/cases/:caseId/coaching`,
    summary: 'Constructive coaching report',
    tags: ['Quality'],
    permission: 'quality:read',
    params: CaseParams,
    response: CoachingReportSchema,
  },
  'skillMatches.list': {
    method: 'GET',
    path: `${API_PREFIX}/cases/:caseId/skill-matches`,
    summary: 'SkillDNA matches using only evidence available as of the cursor',
    tags: ['SkillDNA'],
    permission: 'skill:read',
    params: CaseParams,
    query: AsOfQuerySchema,
    response: Items(SkillMatchSchema),
  },
  'skillMatches.apply': {
    method: 'POST',
    path: `${API_PREFIX}/cases/:caseId/skill-matches/:matchId/apply`,
    summary: 'Apply a matched skill to the case (records the application)',
    tags: ['SkillDNA'],
    permission: 'skill:apply',
    params: CaseParams.extend({ matchId: IdSchema }),
    response: SkillMatchSchema,
  },
  'compare.cases': {
    method: 'GET',
    path: `${API_PREFIX}/compare`,
    summary: 'Compare outcomes between two cases',
    tags: ['Quality'],
    permission: 'analytics:read',
    query: z.object({ caseIds: z.string().min(3).max(300) }),
    response: CaseComparisonSchema,
  },

  // skills ------------------------------------------------------------------
  'skills.list': {
    method: 'GET',
    path: `${API_PREFIX}/skills`,
    summary: 'SkillDNA library (paginated)',
    tags: ['SkillDNA'],
    permission: 'skill:read',
    query: SkillsListQuery,
    response: pageOf(SkillDnaSchema),
  },
  'skills.get': {
    method: 'GET',
    path: `${API_PREFIX}/skills/:skillId`,
    summary: 'Skill detail with allowed lifecycle transitions',
    tags: ['SkillDNA'],
    permission: 'skill:read',
    params: SkillParams,
    response: SkillDetailSchema,
  },
  'skills.versions': {
    method: 'GET',
    path: `${API_PREFIX}/skills/:skillId/versions`,
    summary: 'Version history',
    tags: ['SkillDNA'],
    permission: 'skill:read',
    params: SkillParams,
    response: Items(SkillVersionSchema),
  },
  'skills.diff': {
    method: 'GET',
    path: `${API_PREFIX}/skills/:skillId/diff`,
    summary: 'Human-readable diff between two versions',
    tags: ['SkillDNA'],
    permission: 'skill:read',
    params: SkillParams,
    query: SkillDiffQuery,
    response: SkillDiffSchema,
  },
  'skills.extract': {
    method: 'POST',
    path: `${API_PREFIX}/cases/:caseId/skills/extract`,
    summary: 'Extract a draft SkillDNA from an accepted counterfactual path',
    tags: ['SkillDNA'],
    permission: 'skill:extract',
    params: CaseParams,
    body: ExtractSkillBodySchema,
    response: z.object({ job: JobSchema }),
    status: 202,
    idempotent: true,
  },
  'skills.transition': {
    method: 'POST',
    path: `${API_PREFIX}/skills/:skillId/transition`,
    summary: 'Move a skill through its lifecycle (role-gated, optimistic lock, audited)',
    tags: ['SkillDNA'],
    permission: 'skill:review',
    params: SkillParams,
    body: SkillTransitionBodySchema,
    response: SkillDetailSchema,
  },
  'skills.simulationTest': {
    method: 'POST',
    path: `${API_PREFIX}/skills/:skillId/simulation-test`,
    summary: 'Replay the skill against its source case at the original decision point',
    tags: ['SkillDNA'],
    permission: 'skill:validate',
    params: SkillParams,
    body: SimulateSkillBodySchema,
    response: SkillValidationSchema,
  },
  'skills.proposeMutation': {
    method: 'POST',
    path: `${API_PREFIX}/skills/:skillId/mutations`,
    summary: 'Propose a new skill version from another case (never auto-applied)',
    tags: ['SkillDNA'],
    permission: 'skill:mutate',
    params: SkillParams,
    body: ProposeMutationBodySchema,
    response: z.object({ job: JobSchema }),
    status: 202,
    idempotent: true,
  },
  'skills.versionDecision': {
    method: 'POST',
    path: `${API_PREFIX}/skills/:skillId/versions/:versionId/decision`,
    summary: 'Approve or reject a proposed skill version',
    tags: ['SkillDNA'],
    permission: 'skill:approve',
    params: SkillParams.extend({ versionId: IdSchema }),
    body: SkillVersionDecisionBodySchema,
    response: SkillDetailSchema,
  },
  'skills.rollback': {
    method: 'POST',
    path: `${API_PREFIX}/skills/:skillId/rollback`,
    summary: 'Roll back to an earlier version by creating a new version with that content',
    tags: ['SkillDNA'],
    permission: 'skill:rollback',
    params: SkillParams,
    body: SkillRollbackBodySchema,
    response: SkillDetailSchema,
  },
  'skills.apply': {
    method: 'POST',
    path: `${API_PREFIX}/cases/:caseId/skills/apply`,
    summary: 'Apply a skill to a case (creates or updates the match)',
    tags: ['SkillDNA'],
    permission: 'skill:apply',
    params: CaseParams,
    body: ApplySkillBodySchema,
    response: SkillMatchSchema,
  },

  // dashboards, efficiency, analytics ---------------------------------------
  'dashboard.commandCenter': {
    method: 'GET',
    path: `${API_PREFIX}/command-center`,
    summary: 'Command center aggregate',
    tags: ['Dashboards'],
    permission: 'case:read',
    query: z.object({ caseId: IdSchema.optional() }),
    response: CommandCenterSchema,
  },
  'efficiency.overview': {
    method: 'GET',
    path: `${API_PREFIX}/efficiency/overview`,
    summary: 'Token and compute efficiency (estimated / simulated values are labelled)',
    tags: ['Dashboards'],
    permission: 'telemetry:read',
    query: z.object({ caseId: IdSchema.optional() }),
    response: EfficiencyOverviewSchema,
  },
  'efficiency.executions': {
    method: 'GET',
    path: `${API_PREFIX}/model-executions`,
    summary: 'Model executions with token usage (paginated)',
    tags: ['Dashboards'],
    permission: 'telemetry:read',
    query: ExecutionsQuery,
    response: pageOf(ModelExecutionWithUsageSchema),
  },
  'analytics.overview': {
    method: 'GET',
    path: `${API_PREFIX}/analytics/overview`,
    summary: 'Privacy-safe quality analytics (never ranks individuals)',
    tags: ['Dashboards'],
    permission: 'analytics:read',
    response: AnalyticsOverviewSchema,
  },
  'search.global': {
    method: 'GET',
    path: `${API_PREFIX}/search`,
    summary: 'Global search across cases, claims, hypotheses and skills (tenant-scoped)',
    tags: ['Dashboards'],
    permission: 'case:read',
    query: z.object({
      q: z.string().min(2).max(200),
      limit: z.coerce.number().int().min(1).max(25).default(10),
    }),
    response: Items(SearchResultSchema),
  },

  // governance --------------------------------------------------------------
  'governance.get': {
    method: 'GET',
    path: `${API_PREFIX}/governance/settings`,
    summary: 'All governed configuration sections',
    tags: ['Governance'],
    permission: 'governance:read',
    response: GovernanceSettingsSchema,
  },
  'governance.update': {
    method: 'PUT',
    path: `${API_PREFIX}/governance/settings/:section`,
    summary: 'Update one configuration section (versioned, validated, audited)',
    tags: ['Governance'],
    permission: 'governance:write',
    params: z.object({ section: GovernanceSectionSchema }),
    body: UpdateGovernanceBodySchema,
    response: GovernanceSettingsSchema,
  },
  'governance.prompts': {
    method: 'GET',
    path: `${API_PREFIX}/governance/prompts`,
    summary: 'Versioned prompts',
    tags: ['Governance'],
    permission: 'governance:read',
    response: Items(PromptVersionSchema),
  },
  'governance.users': {
    method: 'GET',
    path: `${API_PREFIX}/governance/users`,
    summary: 'Users and role assignments',
    tags: ['Governance'],
    permission: 'governance:read',
    response: Items(UserSchema),
  },
  'governance.assignRoles': {
    method: 'PUT',
    path: `${API_PREFIX}/governance/users/:userId/roles`,
    summary: 'Assign roles to a user (audited)',
    tags: ['Governance'],
    permission: 'roles:manage',
    params: z.object({ userId: IdSchema }),
    body: AssignRolesBodySchema,
    response: UserSchema,
  },
  'governance.audit': {
    method: 'GET',
    path: `${API_PREFIX}/audit`,
    summary: 'Audit log (paginated, append-only, hash-chained)',
    tags: ['Governance'],
    permission: 'audit:read',
    query: AuditQuery,
    response: pageOf(AuditEventSchema),
  },
  'governance.auditVerify': {
    method: 'GET',
    path: `${API_PREFIX}/audit/verify`,
    summary: 'Verify the audit hash chain',
    tags: ['Governance'],
    permission: 'audit:read',
    response: AuditVerificationSchema,
  },
  'governance.reviews': {
    method: 'GET',
    path: `${API_PREFIX}/governance/reviews`,
    summary: 'Recorded reviewer decisions (paginated)',
    tags: ['Governance'],
    permission: 'audit:read',
    query: PageQuerySchema.extend({ caseId: IdSchema.optional() }),
    response: pageOf(ReviewDecisionSchema),
  },
  'governance.export': {
    method: 'POST',
    path: `${API_PREFIX}/governance/export`,
    summary: 'Export case or audit data (guarded by export controls; audited)',
    tags: ['Governance'],
    permission: 'export:data',
    body: ExportBodySchema,
    response: ExportResponseSchema,
  },

  // demo --------------------------------------------------------------------
  'demo.state': {
    method: 'GET',
    path: `${API_PREFIX}/demo/state`,
    summary: 'Guided demo progress derived from real data',
    tags: ['Demo'],
    permission: 'case:read',
    response: DemoStateSchema,
  },
  'demo.seed': {
    method: 'POST',
    path: `${API_PREFIX}/demo/seed`,
    summary: 'Seed synthetic demo data (idempotent)',
    tags: ['Demo'],
    permission: 'demo:manage',
    body: DemoSeedBodySchema,
    response: DemoStateSchema,
  },
  'demo.reset': {
    method: 'POST',
    path: `${API_PREFIX}/demo/reset`,
    summary: 'Reset synthetic demo data to its initial state',
    tags: ['Demo'],
    permission: 'demo:manage',
    response: DemoStateSchema,
  },

  // system ------------------------------------------------------------------
  'system.health': {
    method: 'GET',
    path: `${API_PREFIX}/system/health`,
    summary: 'Dependency health, migrations and AI provider status',
    tags: ['System'],
    permission: 'telemetry:read',
    response: SystemHealthSchema,
  },
  'system.metrics': {
    method: 'GET',
    path: `${API_PREFIX}/system/metrics`,
    summary: 'In-process request, model and security metrics',
    tags: ['System'],
    permission: 'telemetry:read',
    response: RequestMetricsSchema,
  },
  'system.provider': {
    method: 'GET',
    path: `${API_PREFIX}/system/provider`,
    summary: 'AI provider status and validation note',
    tags: ['System'],
    permission: 'telemetry:read',
    response: ProviderStatusSchema,
  },
} as const satisfies Record<string, RouteSpec>;

export type RouteId = keyof typeof ROUTES;
type SchemaOf<R, K extends string> =
  R extends Record<K, infer S> ? (S extends z.ZodType ? S : never) : never;

export type RouteParams<K extends RouteId> = [SchemaOf<(typeof ROUTES)[K], 'params'>] extends [
  never,
]
  ? undefined
  : z.input<SchemaOf<(typeof ROUTES)[K], 'params'>>;
export type RouteQuery<K extends RouteId> = [SchemaOf<(typeof ROUTES)[K], 'query'>] extends [never]
  ? undefined
  : z.input<SchemaOf<(typeof ROUTES)[K], 'query'>>;
export type RouteBody<K extends RouteId> = [SchemaOf<(typeof ROUTES)[K], 'body'>] extends [never]
  ? undefined
  : z.input<SchemaOf<(typeof ROUTES)[K], 'body'>>;
export type RouteResponse<K extends RouteId> = z.output<SchemaOf<(typeof ROUTES)[K], 'response'>>;

/** Substitutes `:name` segments with URL-encoded params. Throws on a missing param. */
export function buildPath(path: string, params?: Record<string, string | number>): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
    const value = params?.[name];
    if (value === undefined) throw new Error(`Missing path parameter "${name}" for ${path}`);
    return encodeURIComponent(String(value));
  });
}

/** Serialises a query object, skipping undefined/null values. */
export function buildQueryString(query?: Record<string, unknown>): string {
  if (!query) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    const text =
      typeof value === 'string'
        ? value
        : typeof value === 'number' || typeof value === 'boolean'
          ? String(value)
          : JSON.stringify(value);
    search.set(key, text);
  }
  const queryText = search.toString();
  return queryText ? `?${queryText}` : '';
}
