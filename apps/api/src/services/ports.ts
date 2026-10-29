import type {
  AnalysisRun,
  AgentName,
  CounterfactualScenario,
  CounterfactualStrategy,
  HindsightCheck,
  IngestRequest,
  IngestResult,
  IngestionPreview,
  Job,
  JobKind,
  JobStage,
  Page,
  ProviderStatus,
  ReviewCounterfactualBody,
  SimulateSkillBody,
  SkillDetail,
  SkillDiff,
  SkillDna,
  SkillMatch,
  SkillRollbackBody,
  SkillTransitionBody,
  SkillValidation,
  SkillVersion,
  SkillVersionDecisionBody,
  StartAnalysisResponse,
} from '@caseguard/schemas';
import type { AgentRunRequest, AgentRunResult, AiHealth } from '@caseguard/ai';
import type { ObjectStore } from '../storage';
import type { SkillListQuery } from '../db';
import type { RequestContext } from '../http/request-context';

/*
 * Ports: the contracts between route groups. Each is implemented by exactly one service module and
 * consumed by others (for example the demo seeder ingests, analyses and extracts skills). Keeping
 * them here lets groups be built and tested independently; implementations are resolved lazily by the
 * container, so there is no import cycle between services.
 */

// ---------------------------------------------------------------- jobs

export interface JobStageSpec {
  readonly id: string;
  readonly label: string;
}

export interface JobSpec {
  readonly kind: JobKind;
  readonly caseId: string | null;
  /** Optional id of the thing the job acts on (fork id, skill id, ...). */
  readonly targetId?: string | null;
  /** Ordered stages shown to the user; at least one. */
  readonly stages: readonly JobStageSpec[];
  readonly idempotencyKey?: string | null;
  /** Default true: the user may cancel while it is queued or running. */
  readonly cancellable?: boolean;
  /** Longest the work may run before it is stopped and recorded as failed (default 10 minutes). */
  readonly timeoutMs?: number;
}

/** Handed to the work function so it can report progress and observe cancellation. */
export interface JobHandle {
  readonly jobId: string;
  readonly signal: AbortSignal;
  /** Marks earlier stages done and `stageId` running. Throws if the job was cancelled. */
  stage(stageId: string, detail?: string): Promise<void>;
  /** Marks a stage skipped (with the reason shown to the user). */
  skip(stageId: string, detail: string): Promise<void>;
  /** Throws a cancellation error when the job was cancelled; call between expensive steps. */
  throwIfCancelled(): void;
}

export interface JobResult {
  readonly resultRef: { readonly type: string; readonly id: string } | null;
}

export type JobWork = (handle: JobHandle, ctx: RequestContext) => Promise<JobResult>;

export interface JobPort {
  /** Persists a queued job and runs `work` in the background; returns immediately with the job. */
  start(ctx: RequestContext, spec: JobSpec, work: JobWork): Promise<Job>;
  /** Same as `start` but resolves when the job has finished (used by seeding and tests). */
  runToCompletion(ctx: RequestContext, spec: JobSpec, work: JobWork): Promise<Job>;
  cancel(ctx: RequestContext, jobId: string): Promise<Job>;
  /** Resolves when no job is queued or running (graceful shutdown and tests). */
  idle(): Promise<void>;
  /**
   * Fails jobs that no live process is running and returns how many. Without `staleAfterMs` every
   * non-terminal job of the given tenants fails (a lone process that has just started). With it, only
   * jobs whose owner has been silent that long fail, so another replica's jobs are left alone.
   */
  recoverOrphans(
    tenantIds: readonly string[],
    options?: { readonly staleAfterMs?: number },
  ): Promise<number>;
}

// ---------------------------------------------------------------- analysis

export interface AnalyzeOptions {
  /** Re-run even when an analysis with identical input already exists. */
  readonly force?: boolean;
}

export interface AnalysisOutcome {
  readonly run: AnalysisRun;
  /** True when an identical analysis already existed and was reused. */
  readonly reused: boolean;
}

export interface AnalysisPort {
  /** Runs the whole analysis pipeline for a case and persists the snapshot (idempotent on input hash). */
  analyzeCase(
    ctx: RequestContext,
    caseId: string,
    options?: AnalyzeOptions,
  ): Promise<AnalysisOutcome>;
  /** Queues the analysis as a job (reusing an identical earlier run) and returns immediately. */
  startAnalysis(
    ctx: RequestContext,
    caseId: string,
    options?: AnalyzeOptions,
  ): Promise<StartAnalysisResponse>;
}

// ---------------------------------------------------------------- counterfactuals and skills

/**
 * Counterfactual paths. Every method takes the `RequestContext` of the acting persona (the demo
 * seeder builds one per persona), so permissions, tenancy, audit actor and four-eyes rules apply
 * exactly as they do over HTTP. Route-level permission checks happen in the binder; the service
 * enforces the data-dependent rules (eligibility, review state, optimistic locks).
 */
export interface CounterfactualPort {
  /**
   * Generates, validates and persists scenarios for one eligible fork, waiting for the result (the
   * job-based route runs the same work in the background). Generation sees only the pre-decision
   * view; the engine's leak and validity checks decide each scenario's status and are stored as they
   * are. Rejected scenarios are kept and shown as rejected.
   */
  runForFork(
    ctx: RequestContext,
    caseId: string,
    forkId: string,
    strategies?: readonly CounterfactualStrategy[],
  ): Promise<CounterfactualScenario[]>;
  /** `counterfactuals.run`: validates the fork, then queues the generation as a `counterfactual` job. */
  startRun(
    ctx: RequestContext,
    caseId: string,
    forkId: string,
    strategies?: readonly CounterfactualStrategy[],
  ): Promise<Job>;
  /**
   * Ensures every eligible fork has its default scenarios (generating the missing ones) and returns
   * all stored scenarios of the case: the earliest meaningful fork with every strategy, the other
   * eligible forks with the balanced strategy.
   */
  ensureScenarios(ctx: RequestContext, caseId: string): Promise<CounterfactualScenario[]>;
  list(
    ctx: RequestContext,
    caseId: string,
    filter?: { readonly forkId?: string | undefined },
  ): Promise<CounterfactualScenario[]>;
  get(ctx: RequestContext, caseId: string, scenarioId: string): Promise<CounterfactualScenario>;
  /**
   * Accepts (`confirmed`) or rejects a scenario with a reason, in one transaction with the
   * `ReviewDecision` record and the audit event. `expectedVersion` is the scenario `version` the
   * reviewer last saw. Only accepted scenarios may seed a skill.
   */
  review(
    ctx: RequestContext,
    caseId: string,
    scenarioId: string,
    input: ReviewCounterfactualBody,
  ): Promise<CounterfactualScenario>;
  /** Post-hoc comparison with the recorded resolution; separate from, and never feeding, generation. */
  hindsight(ctx: RequestContext, caseId: string, scenarioId: string): Promise<HindsightCheck>;
}

export interface SkillExtractionOptions {
  /** Restrict extraction to one accepted scenario; by default every accepted scenario of the case is used. */
  readonly scenarioId?: string | undefined;
}

export type SkillMutationResult =
  | {
      readonly status: 'proposed';
      /** The proposed version (`state: 'proposed'`): never applied until a distinct approver decides. */
      readonly version: SkillVersion;
      /** Human-readable diff from the version it builds on. */
      readonly diff: SkillDiff;
    }
  | { readonly status: 'no_change'; readonly reasons: readonly string[] };

/**
 * SkillDNA library, governance and matching. Every method takes the acting persona's
 * `RequestContext`; the domain gates (four-eyes, validations, optimistic locks) decide, and a refused
 * step is audited as `denied` and thrown as the documented problem (`SKILL_ERROR_HTTP`).
 */
export interface SkillsPort {
  // ------------------------------------------------------------ matching and application
  /**
   * Scores the matchable skills (pilot, validated, published) against the evidence known as of `asOf`
   * (default: the whole case, which is also persisted; ad-hoc `asOf` matches never are).
   */
  matchForCase(
    ctx: RequestContext,
    caseId: string,
    options?: { readonly asOf?: string | undefined },
  ): Promise<SkillMatch[]>;
  /** `skillMatches.apply`: records that the engineer adopted the guided plan of a stored match (idempotent). */
  applyMatch(ctx: RequestContext, caseId: string, matchId: string): Promise<SkillMatch>;
  /** `skills.apply`: applies a skill to a case (creates or updates the match; idempotent). */
  applyToCase(ctx: RequestContext, caseId: string, skillId: string): Promise<SkillMatch>;

  // ------------------------------------------------------------ library
  list(ctx: RequestContext, query: SkillListQuery): Promise<Page<SkillDna>>;
  get(ctx: RequestContext, skillId: string): Promise<SkillDetail>;
  versions(ctx: RequestContext, skillId: string): Promise<SkillVersion[]>;
  diff(
    ctx: RequestContext,
    skillId: string,
    fromVersionId: string,
    toVersionId: string,
  ): Promise<SkillDiff>;

  // ------------------------------------------------------------ extraction
  /**
   * Extracts draft skills (lifecycle `discovered`) from the reviewer-ACCEPTED scenarios of a case,
   * waiting for the result. Refusals are thrown as a 422 problem listing the engine's reasons.
   * Idempotent: an existing skill from the same scenario is returned as it is.
   */
  extractForCase(
    ctx: RequestContext,
    caseId: string,
    options?: SkillExtractionOptions,
  ): Promise<SkillDna[]>;
  /** `skills.extract`: validates the scenario, then queues a `skill_extraction` job. */
  startExtraction(ctx: RequestContext, caseId: string, scenarioId: string): Promise<Job>;

  // ------------------------------------------------------------ governance
  /** Moves a skill through its lifecycle (permission, four-eyes, validations, optimistic lock, audit). */
  transition(
    ctx: RequestContext,
    skillId: string,
    input: SkillTransitionBody,
  ): Promise<SkillDetail>;
  /**
   * Replays the skill (default: its current version) on the cases it was derived from
   * (`simulation_test`), or runs the regression suite over the tenant's analysed, resolved cases of
   * its workload (`regression`), and records the validation.
   */
  runValidation(
    ctx: RequestContext,
    skillId: string,
    input?: Partial<SimulateSkillBody>,
  ): Promise<SkillValidation>;
  /** Proposes a new version learned from another resolved case, waiting for the result. */
  proposeMutation(
    ctx: RequestContext,
    skillId: string,
    sourceCaseId: string,
  ): Promise<SkillMutationResult>;
  /** `skills.proposeMutation`: validates the request, then queues a `skill_mutation` job. */
  startMutation(ctx: RequestContext, skillId: string, sourceCaseId: string): Promise<Job>;
  /** Approves or rejects a proposed version (distinct approver; validated content only). */
  decideVersion(
    ctx: RequestContext,
    skillId: string,
    versionId: string,
    input: SkillVersionDecisionBody,
  ): Promise<SkillDetail>;
  /** Rolls back by creating a NEW version with an earlier version's content. */
  rollback(ctx: RequestContext, skillId: string, input: SkillRollbackBody): Promise<SkillDetail>;
}

// ---------------------------------------------------------------- ingestion

/** An uploaded file as the HTTP layer hands it over. Hostile until the ingestion service validated it. */
export interface IngestUpload {
  readonly fileName: string;
  readonly mediaType: string | null;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

/** What can be ingested: a request payload (built-in sample, pasted text, JSON bundle) or an uploaded file. */
export type IngestSource = IngestRequest | { readonly type: 'file'; readonly file: IngestUpload };

export interface IngestInput {
  readonly source: IngestSource;
  /** Start the analysis job after ingestion (default true). */
  readonly analyze?: boolean;
  readonly idempotencyKey?: string | null;
}

export interface IngestionPort {
  /**
   * Validates, redacts and screens a payload, then stores it as an immutable case (idempotent on the
   * content hash: an identical payload returns the existing case with `created: false`).
   */
  ingest(ctx: RequestContext, input: IngestInput): Promise<IngestResult>;
  /** Runs the same pipeline without persisting anything and reports what would be stored. */
  preview(ctx: RequestContext, source: IngestSource): Promise<IngestionPreview>;
}

// ---------------------------------------------------------------- AI

export interface AiRunOptions {
  /**
   * Persist the execution record immediately (default). The analysis pipeline passes `false` and stores
   * the record together with its snapshot, because the record references the run that does not exist yet.
   */
  readonly persist?: boolean;
}

export interface AiPort {
  /**
   * Runs one agent task for the caller's tenant under that tenant's model settings (tightened by the
   * operator's limits). "LLM proposes, code disposes": the result is always validated, and falls back
   * to deterministic code when the provider is unavailable, over budget or proposes something invalid.
   */
  run<A extends AgentName>(
    ctx: RequestContext,
    request: AgentRunRequest<A>,
    options?: AiRunOptions,
  ): Promise<AgentRunResult<A>>;
  /** Honest provider status for `system.provider` (simulated, validation note, limits). */
  status(ctx: RequestContext): Promise<ProviderStatus>;
  /** Provider, circuit breaker, bulkhead and cache state for `system.health`. */
  health(ctx: RequestContext): Promise<AiHealth>;
}

// ---------------------------------------------------------------- the container

/** Services resolvable from any request context. Implementations are wired in `container.ts`. */
export interface Services {
  readonly jobs: JobPort;
  readonly ai: AiPort;
  readonly analysis: AnalysisPort;
  readonly counterfactuals: CounterfactualPort;
  readonly skills: SkillsPort;
  readonly ingestion: IngestionPort;
  readonly objects: ObjectStore;
}

export type { JobStage };
