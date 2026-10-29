/**
 * Persistence contract for the CaseGuard API.
 *
 * Rules every implementation MUST follow (verified by integration tests):
 *  1. Tenant isolation: `Repositories.forTenant(scope)` returns repositories that cannot read or write
 *     another tenant's rows - at the application layer (every statement filters by tenant_id) AND in
 *     the database (composite keys + row-level security keyed on the `app.tenant_id` setting).
 *  2. Pagination: list methods take `limit` (max 200) and an opaque keyset `cursor`; they return
 *     `nextCursor` (null at the end). Nothing returns an unbounded set except where documented as
 *     bounded by design (events per case <= 2000).
 *  3. Optimistic locking: mutating methods that take `expectedVersion` throw VersionConflictError when
 *     the stored `version` differs, and increment `version` otherwise.
 *  4. Immutability: case sources, events, resolutions and audit events can never be updated; they can
 *     only be removed by the administrator erasure path (`CaseRepository.delete`), and audit events never.
 *  5. Temporal filters: every `asOf` parameter means "only rows whose availability instant is <= asOf".
 *  6. All JSON read from the database is validated with the Zod schema before it is returned, and all
 *     JSON written is validated before it is persisted (no unvalidated model output reaches storage).
 *  7. Timestamps are exchanged as UTC ISO-8601 strings ending in `Z`.
 */
import type {
  AgentName,
  AnalysisRun,
  AnalysisState,
  AuditEvent,
  AuditVerification,
  Case,
  CaseEvent,
  CaseParticipant,
  CaseResolution,
  CaseSource,
  CaseStatus,
  CaseSummary,
  CaseWarning,
  Claim,
  CoachingReport,
  CounterfactualScenario,
  DecisionFork,
  DiagnosticAction,
  DigitalTwin,
  Evidence,
  EvidenceCategory,
  GovernanceSection,
  GovernanceSettings,
  Hypothesis,
  HypothesisEvidenceLink,
  Job,
  JobKind,
  JobStatus,
  MetricEstimate,
  MissingEvidence,
  ModelExecutionWithUsage,
  Page,
  PromptVersion,
  QualityAssessment,
  ReviewDecision,
  ReviewState,
  Role,
  SkillApproval,
  SkillDna,
  SkillLifecycle,
  SkillMatch,
  SkillValidation,
  SkillVersion,
  SkillVersionState,
  Tenant,
  User,
} from '@caseguard/schemas';

// ---------------------------------------------------------------- scope & database

/** Identity of the caller as far as persistence is concerned. Derived only from a validated token. */
export interface TenantScope {
  readonly tenantId: string;
  /** Written to `created_by` / `updated_by`. A user id or `system:<component>`. */
  readonly actorId: string;
}

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface SqlExecutor {
  query<T = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<T>>;
}

export interface Database extends SqlExecutor {
  readonly kind: 'pg' | 'pglite';
  /** Runs `fn` in a transaction on one connection. Rolls back when `fn` throws. */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  /**
   * Runs `fn` in a transaction with the tenant row-level-security context applied
   * (`SET LOCAL ROLE caseguard_app` and `set_config('app.tenant_id', ..., true)`).
   */
  withTenant<T>(scope: TenantScope, fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  ping(): Promise<{ ok: boolean; latencyMs: number; detail: string }>;
  close(): Promise<void>;
}

export interface MigrationStatus {
  applied: { name: string; checksum: string; appliedAt: string }[];
  pending: string[];
  latest: string | null;
  /** Names of applied migrations whose file content changed after they were applied. */
  checksumMismatch: string[];
}

// ---------------------------------------------------------------- cases

export interface IngestCaseInput {
  case: Case;
  source: CaseSource;
  participants: CaseParticipant[];
  events: CaseEvent[];
  resolution: CaseResolution | null;
  /** The redacted payload exactly as stored (also written to the object store by the caller). */
  storedPayload: string;
}

export interface CaseListQuery {
  limit: number;
  cursor?: string | undefined;
  status?: CaseStatus | undefined;
  workload?: string | undefined;
  analysisState?: AnalysisState | undefined;
  q?: string | undefined;
}

/** CaseSummary without analysis-derived metrics; the service layer fills those in. */
export type CaseListItem = Omit<
  CaseSummary,
  'qualityIndex' | 'avoidableEffortPct' | 'leadingHypothesis' | 'openWarningCount'
>;

export interface EventQuery {
  /** Only events with timestamp <= asOf. */
  asOf?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

/** How many cases the tenant holds, for dashboard cards. */
export interface CaseCounts {
  total: number;
  /** Cases flagged `synthetic`. */
  synthetic: number;
  /** Every analysis state is present, with 0 when no case is in it. */
  byAnalysisState: Record<AnalysisState, number>;
}

export interface CaseRepository {
  /**
   * Atomically stores case + source + participants + events + resolution.
   * Idempotent on (tenant, source.receivedSha256): a repeat returns the existing case with created=false.
   */
  ingest(input: IngestCaseInput): Promise<{ case: Case; created: boolean }>;
  findByContentHash(contentHash: string): Promise<Case | null>;
  list(query: CaseListQuery): Promise<Page<CaseListItem>>;
  get(caseId: string): Promise<Case | null>;
  getSource(caseId: string): Promise<CaseSource | null>;
  getParticipants(caseId: string): Promise<CaseParticipant[]>;
  getResolution(caseId: string): Promise<CaseResolution | null>;
  /** Paginated event listing ordered by (timestamp, sequence). */
  listEvents(caseId: string, query: EventQuery & { limit: number }): Promise<Page<CaseEvent>>;
  /** All events (bounded: <= 2000 per case), ordered by (timestamp, sequence), honouring asOf. */
  getAllEvents(caseId: string, query?: { asOf?: string | undefined }): Promise<CaseEvent[]>;
  getEvent(caseId: string, eventId: string): Promise<CaseEvent | null>;
  countEventsAfter(caseId: string, asOf: string): Promise<number>;
  /** Exact totals for the tenant in one query: all cases, the synthetic ones, and cases per analysis state. */
  counts(): Promise<CaseCounts>;
  setAnalysisState(
    caseId: string,
    state: AnalysisState,
    extra?: { runId?: string | undefined; analyzedAt?: string | undefined },
  ): Promise<void>;
  /** Administrator erasure: removes the case and every derived row. Audit events remain. */
  delete(caseId: string): Promise<boolean>;
  /** Case rows for lexical search indexing (bounded by `limit`). */
  listForIndexing(
    limit: number,
  ): Promise<{ id: string; reference: string; title: string; product: string; workload: string }[]>;
}

// ---------------------------------------------------------------- analysis artefacts

/**
 * Everything one analysis run produces. Artefact ids are deterministic (derived from the case id and
 * stable keys) so re-running an analysis replaces the previous artefacts and carries forward reviewer
 * corrections (claim review, warning dismissal, fork review) for rows that keep the same id.
 */
export interface AnalysisSnapshot {
  run: AnalysisRun;
  twin: DigitalTwin;
  evidence: Evidence[];
  links: HypothesisEvidenceLink[];
  claims: Claim[];
  missing: MissingEvidence[];
  hypotheses: Hypothesis[];
  actions: DiagnosticAction[];
  forks: DecisionFork[];
  quality: QualityAssessment;
  metrics: MetricEstimate[];
  warnings: CaseWarning[];
  coaching: CoachingReport;
  skillMatches: SkillMatch[];
  executions: ModelExecutionWithUsage[];
}

export interface ClaimQuery {
  asOf?: string | undefined;
  category?: EvidenceCategory | undefined;
  reviewState?: ReviewState | undefined;
  hypothesisId?: string | undefined;
  q?: string | undefined;
  limit: number;
  cursor?: string | undefined;
}

export interface ReviewClaimInput {
  reviewedCategory: EvidenceCategory;
  reason: string;
  reviewedBy: string;
  reviewedAt: string;
  expectedVersion: number;
}

export interface DismissWarningInput {
  by: string;
  at: string;
  reason: string;
  expectedVersion: number;
}

/**
 * The four analysis-derived fields of `CaseSummary` (see `CaseSummarySchema`) for one case, which
 * `CaseListItem` leaves out. Everything is read from the case's latest analysis.
 */
export interface CaseAnalysisSummary {
  caseId: string;
  /** Composite score (0-100) of the stored quality assessment; null when the case has none. */
  qualityIndex: number | null;
  /** Value (percent) of the stored Avoidable Support Effort metric; null when it is missing or unknown. */
  avoidableEffortPct: number | null;
  /** The hypothesis with the highest current confidence (name and confidence); null when there is none. */
  leadingHypothesis: { name: string; confidence: number } | null;
  /** Warnings in state `open`. */
  openWarningCount: number;
}

export interface AnalysisRepository {
  findRunByInputHash(caseId: string, inputHash: string): Promise<AnalysisRun | null>;
  /** Replaces the case's artefacts in ONE transaction and points the case at the new run. */
  saveSnapshot(snapshot: AnalysisSnapshot): Promise<void>;
  getLatestRun(caseId: string): Promise<AnalysisRun | null>;
  getTwin(caseId: string): Promise<DigitalTwin | null>;
  /**
   * Analysis-derived summary fields for up to 200 cases, read with ONE statement however many ids are
   * given (use it to fill a page of `CaseListItem`s). The result has one entry per requested id that is
   * a case of this tenant, in the order requested with duplicates collapsed. A case that has not been
   * analysed gets null, null, null and 0. Ids that are not cases of this tenant (unknown, erased, or
   * another tenant's) are OMITTED, so the caller cannot tell them apart. An empty list returns [].
   * More than 200 ids, or an id that is not a non-empty string, is a ValidationFailedError.
   */
  summarize(caseIds: readonly string[]): Promise<CaseAnalysisSummary[]>;
  /**
   * Open warnings across all cases of the tenant, most severe first (`critical`, `high`, `medium`,
   * `low`), then most recently raised, then by rank. `limit` is 1..100.
   */
  listOpenWarnings(query: { limit: number }): Promise<CaseWarning[]>;
  /**
   * Unresolved missing-evidence items across the tenant, only from each case's LATEST analysis, most
   * critical first (`critical`, `important`, `helpful`), then most recently relevant. `limit` is
   * 1..100. It lists every criticality by default; pass `minCriticality: 'critical'` for the critical
   * items only, or `'important'` for critical and important ones.
   */
  listCriticalMissing(query: {
    limit: number;
    minCriticality?: MissingEvidence['criticality'] | undefined;
  }): Promise<(MissingEvidence & { caseId: string })[]>;
  listEvidence(
    caseId: string,
    filter?: { asOf?: string | undefined; ids?: readonly string[] | undefined },
  ): Promise<Evidence[]>;
  listLinks(
    caseId: string,
    filter?: { asOf?: string | undefined; hypothesisId?: string | undefined },
  ): Promise<HypothesisEvidenceLink[]>;
  listClaims(caseId: string, query: ClaimQuery): Promise<Page<Claim>>;
  countClaimsByCategory(caseId: string, asOf?: string): Promise<Record<string, number>>;
  getClaim(caseId: string, claimId: string): Promise<Claim | null>;
  reviewClaim(caseId: string, claimId: string, input: ReviewClaimInput): Promise<Claim>;
  listMissing(caseId: string): Promise<MissingEvidence[]>;
  listHypotheses(caseId: string): Promise<Hypothesis[]>;
  getHypothesis(caseId: string, hypothesisId: string): Promise<Hypothesis | null>;
  listActions(caseId: string, asOf?: string): Promise<DiagnosticAction[]>;
  listForks(caseId: string): Promise<DecisionFork[]>;
  getFork(caseId: string, forkId: string): Promise<DecisionFork | null>;
  updateForkReview(
    caseId: string,
    forkId: string,
    review: { reviewState: ReviewState; reason: string | null; expectedVersion: number },
  ): Promise<DecisionFork>;
  getQuality(caseId: string): Promise<QualityAssessment | null>;
  listMetrics(caseId: string): Promise<MetricEstimate[]>;
  listWarnings(
    caseId: string,
    filter?: {
      asOf?: string | undefined;
      state?: 'open' | 'resolved' | 'dismissed' | undefined;
    },
  ): Promise<CaseWarning[]>;
  getWarning(caseId: string, warningId: string): Promise<CaseWarning | null>;
  dismissWarning(
    caseId: string,
    warningId: string,
    input: DismissWarningInput,
  ): Promise<CaseWarning>;
  getCoaching(caseId: string): Promise<CoachingReport | null>;
  listSkillMatches(caseId: string): Promise<SkillMatch[]>;
}

// ---------------------------------------------------------------- counterfactuals

export interface CounterfactualRepository {
  /** Upserts scenarios (and their steps) for a fork. Steps live inside the scenario JSON and in a steps table. */
  saveScenarios(scenarios: CounterfactualScenario[]): Promise<void>;
  list(caseId: string, filter?: { forkId?: string | undefined }): Promise<CounterfactualScenario[]>;
  get(caseId: string, scenarioId: string): Promise<CounterfactualScenario | null>;
  review(
    caseId: string,
    scenarioId: string,
    review: {
      reviewState: ReviewState;
      reason: string;
      reviewedBy: string;
      reviewedAt: string;
      expectedVersion: number;
    },
  ): Promise<CounterfactualScenario>;
}

// ---------------------------------------------------------------- skills

export interface SkillListQuery {
  lifecycle?: SkillLifecycle | undefined;
  q?: string | undefined;
  limit: number;
  cursor?: string | undefined;
}

export interface SkillRepository {
  create(input: { skill: SkillDna; version: SkillVersion }): Promise<void>;
  list(query: SkillListQuery): Promise<Page<SkillDna>>;
  get(skillId: string): Promise<SkillDna | null>;
  getVersion(skillId: string, versionId: string): Promise<SkillVersion | null>;
  listVersions(skillId: string): Promise<SkillVersion[]>;
  addVersion(version: SkillVersion): Promise<void>;
  setVersionState(skillId: string, versionId: string, state: SkillVersionState): Promise<void>;
  /** Optimistic update of mutable skill columns; the merged result is validated against SkillDnaSchema. */
  update(
    skillId: string,
    patch: Partial<Omit<SkillDna, 'id' | 'tenantId' | 'createdAt' | 'version'>>,
    expectedVersion: number,
  ): Promise<SkillDna>;
  addValidation(validation: SkillValidation): Promise<void>;
  listValidations(skillId: string): Promise<SkillValidation[]>;
  addApproval(approval: SkillApproval): Promise<void>;
  listApprovals(skillId: string): Promise<SkillApproval[]>;
  upsertMatch(match: SkillMatch): Promise<void>;
  getMatch(caseId: string, matchId: string): Promise<SkillMatch | null>;
  listMatchesForCase(caseId: string): Promise<SkillMatch[]>;
  listMatchesForSkill(skillId: string): Promise<SkillMatch[]>;
  /** Skills whose lifecycle is pilot/validated/published for a workload, with their current version. */
  listMatchable(workload: string): Promise<{ skill: SkillDna; version: SkillVersion }[]>;
}

// ---------------------------------------------------------------- telemetry & prompts

export interface TelemetryAggregate {
  totals: {
    executions: number;
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    failures: number;
    cacheHits: number;
    avgLatencyMs: number;
    estimatedCostUsd: number | null;
  };
  byAgent: {
    agent: AgentName;
    executions: number;
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    avgLatencyMs: number;
    cacheHits: number;
    failures: number;
    estimatedSavingsTokens: number;
  }[];
  byModel: {
    model: string;
    provider: string;
    executions: number;
    totalTokens: number;
    avgLatencyMs: number;
  }[];
  savings: {
    contextCompressionTokens: number;
    duplicateRemovalTokens: number;
    cacheHitTokens: number;
    earlyStopTokens: number;
  };
  tokensToday: number;
}

export interface TelemetryRepository {
  saveExecutions(items: ModelExecutionWithUsage[]): Promise<void>;
  listExecutions(query: {
    caseId?: string | undefined;
    agent?: AgentName | undefined;
    limit: number;
    cursor?: string | undefined;
  }): Promise<Page<ModelExecutionWithUsage>>;
  aggregate(query: {
    caseId?: string | undefined;
    since?: string | undefined;
  }): Promise<TelemetryAggregate>;
  upsertPromptVersions(items: PromptVersion[]): Promise<void>;
  listPromptVersions(): Promise<PromptVersion[]>;
}

// ---------------------------------------------------------------- governance, users, audit, reviews

/** Profile an identity provider (Entra) asserts for the signed-in user; the token is the source of truth. */
export interface IdentityUserInput {
  /** The identity provider's stable user id (Entra object id). */
  userId: string;
  displayName: string;
  /** Null when the token carries none: a new user gets an empty string, an existing user keeps the stored address. */
  email: string | null;
  /** At least one role; duplicates are ignored and the order does not matter. */
  roles: Role[];
  synthetic: boolean;
}

export interface GovernanceRepository {
  getTenant(): Promise<Tenant>;
  /** Returns stored sections, seeding defaults for any that are missing. */
  getSettings(): Promise<GovernanceSettings>;
  updateSection(
    section: GovernanceSection,
    value: unknown,
    input: { expectedVersion: number; changeNote: string; by: string },
  ): Promise<GovernanceSettings>;
  listUsers(): Promise<User[]>;
  getUser(userId: string): Promise<User | null>;
  updateUserRoles(userId: string, roles: Role[], expectedVersion: number): Promise<User>;
  /**
   * Just-in-time user sync for the scoped tenant. Inserts the user when absent (status `active`,
   * version 1). When present, takes displayName, email and roles from `input` but never changes
   * `status` (an administrator may have disabled the user), `createdAt` or `synthetic`; `updatedAt`
   * and `version` move only when something actually changed, so repeated sign-ins are no-ops. A null
   * `email` never erases a stored address. Safe to call concurrently. Writes no audit rows: the
   * caller audits role changes. Throws ValidationFailedError for an empty role list, an unknown
   * role, a malformed id or an e-mail longer than 200 characters.
   */
  upsertIdentityUser(input: IdentityUserInput): Promise<User>;
}

export interface AuditAppendInput {
  actorId: string;
  actorRole: Role | 'system' | 'anonymous';
  action: string;
  targetType: string;
  targetId: string | null;
  caseId: string | null;
  outcome: 'success' | 'denied' | 'failure';
  details: Record<string, unknown>;
  correlationId: string;
  occurredAt?: string | undefined;
}

export interface AuditQueryInput {
  action?: string | undefined;
  actorId?: string | undefined;
  caseId?: string | undefined;
  outcome?: 'success' | 'denied' | 'failure' | undefined;
  from?: string | undefined;
  to?: string | undefined;
  limit: number;
  cursor?: string | undefined;
}

export interface AuditRepository {
  /** Appends in one serialised step: sequence = previous + 1, hash = sha256(prevHash + canonical JSON). */
  append(input: AuditAppendInput): Promise<AuditEvent>;
  list(query: AuditQueryInput): Promise<Page<AuditEvent>>;
  verify(): Promise<AuditVerification>;
  /** Bounded export (<= maxRecords) in sequence order. */
  listForExport(maxRecords: number): Promise<AuditEvent[]>;
}

export interface ReviewStats {
  reviewedClaims: number;
  correctedClaims: number;
  counterfactualsReviewed: number;
  counterfactualsAccepted: number;
  counterfactualsRejected: number;
}

export interface ReviewRepository {
  record(decision: ReviewDecision): Promise<void>;
  list(query: {
    caseId?: string | undefined;
    limit: number;
    cursor?: string | undefined;
  }): Promise<Page<ReviewDecision>>;
  stats(): Promise<ReviewStats>;
}

// ---------------------------------------------------------------- jobs, idempotency, demo, analytics

export interface JobRepository {
  create(job: Job): Promise<void>;
  update(
    jobId: string,
    patch: Partial<
      Pick<
        Job,
        'status' | 'progress' | 'error' | 'resultRef' | 'startedAt' | 'completedAt' | 'cancellable'
      >
    >,
  ): Promise<Job>;
  get(jobId: string): Promise<Job | null>;
  list(query: {
    caseId?: string | undefined;
    status?: JobStatus | undefined;
    kind?: JobKind | undefined;
    limit: number;
    cursor?: string | undefined;
  }): Promise<Page<Job>>;
  findByIdempotencyKey(kind: JobKind, key: string): Promise<Job | null>;
  /**
   * Fails jobs a process left queued or running. Without `staleBefore` every non-terminal job of the
   * tenant fails (right for a lone process that has just started). With it, only jobs whose last sign of
   * life (heartbeat, else start, else creation) is at or before that ISO instant fail, so a job another
   * replica is still running is left alone. Returns how many were failed.
   */
  failOrphaned(reason: string, options?: { staleBefore?: string }): Promise<number>;
  /**
   * Records that the process running `jobId` is alive and returns the job's status as stored (null when
   * the job does not exist). A status other than queued/running tells the owner to stop.
   */
  heartbeat(jobId: string): Promise<JobStatus | null>;
}

export type IdempotencyBegin =
  | { state: 'new' }
  | { state: 'replay'; status: number; response: unknown }
  | { state: 'in_progress' }
  | { state: 'conflict' };

export interface IdempotencyRepository {
  /** Reserves the key. `conflict` means the same key was used with a different request hash. */
  begin(key: string, scopeName: string, requestHash: string): Promise<IdempotencyBegin>;
  complete(key: string, scopeName: string, status: number, response: unknown): Promise<void>;
  release(key: string, scopeName: string): Promise<void>;
}

export interface DemoRepository {
  /** Deletes all case-derived data for the tenant (cases, artefacts, skills, jobs, telemetry). Keeps users, settings and audit. */
  resetTenantData(): Promise<void>;
  getSeedMarker(): Promise<{ seededAt: string; profile: string } | null>;
  setSeedMarker(marker: { seededAt: string; profile: string }): Promise<void>;
}

export interface AnalyticsSource {
  cases: Pick<Case, 'id' | 'reference' | 'synthetic' | 'analysisState' | 'openedAt' | 'workload'>[];
  quality: {
    caseId: string;
    analyzedAt: string;
    compositeScore: number;
    evidenceIntegrity: number;
  }[];
  forks: { caseId: string; category: string }[];
  missing: { caseId: string; requirementId: string; label: string; resolved: boolean }[];
  metrics: {
    caseId: string;
    key: string;
    value: number | null;
    ase: { components: { key: string; label: string; avoidablePct: number }[] } | null;
  }[];
  assumptionFlags: { caseId: string; subject: string | null; text: string }[];
  scenarios: {
    caseId: string;
    reviewState: ReviewState;
    counterfactualTokens: number;
    actualTokens: number;
  }[];
  skills: SkillDna[];
  matches: { caseId: string; skillId: string; applied: boolean }[];
}

export interface AnalyticsRepository {
  /** Bounded read model for the analytics aggregator (<= `limit` cases, newest first). */
  collect(limit: number): Promise<AnalyticsSource>;
}

// ---------------------------------------------------------------- search

export type SearchHitType = 'case' | 'claim' | 'hypothesis' | 'skill' | 'warning' | 'event';

/** One search result; the service layer adds the `href` that `SearchResultSchema` carries. */
export interface SearchHit {
  type: SearchHitType;
  id: string;
  /** The case the hit belongs to (the case itself for `case` hits); null for skills. */
  caseId: string | null;
  title: string;
  /** Plain text of at most 300 characters (no highlight markup). Render it as text. */
  snippet: string;
  /** Relevance in [0, 1) used only for ordering; comparable across types, not across queries. */
  score: number;
}

export interface SearchRepository {
  /**
   * Full-text search over the tenant's cases (title, reference, tags), case events (title, body),
   * claims, hypotheses, skills and open warnings. `text` uses web-search syntax (words are ANDed,
   * "quoted phrases", `or`, `-exclusion`); any input is accepted and never reaches SQL as text.
   * Blank text, or text with nothing searchable in it, returns []. `limit` is 1..100. Best match
   * first; ties break by type, case id and id, so the order is deterministic.
   */
  query(input: { text: string; limit: number }): Promise<SearchHit[]>;
}

// ---------------------------------------------------------------- composition

export interface TenantRepositories {
  readonly scope: TenantScope;
  readonly cases: CaseRepository;
  readonly analysis: AnalysisRepository;
  readonly counterfactuals: CounterfactualRepository;
  readonly skills: SkillRepository;
  readonly telemetry: TelemetryRepository;
  readonly governance: GovernanceRepository;
  readonly audit: AuditRepository;
  readonly reviews: ReviewRepository;
  readonly jobs: JobRepository;
  readonly idempotency: IdempotencyRepository;
  readonly demo: DemoRepository;
  readonly analytics: AnalyticsRepository;
  readonly search: SearchRepository;
  /** Runs `fn` with repositories bound to ONE transaction (all-or-nothing). */
  transaction<T>(fn: (repos: TenantRepositories) => Promise<T>): Promise<T>;
}

export interface Repositories {
  forTenant(scope: TenantScope): TenantRepositories;
  readonly database: Database;
  migrationStatus(): Promise<MigrationStatus>;
}
