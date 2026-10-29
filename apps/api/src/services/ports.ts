import type {
  AnalysisRun,
  AgentName,
  CounterfactualScenario,
  CounterfactualStrategy,
  IngestRequest,
  IngestResult,
  IngestionPreview,
  Job,
  JobKind,
  JobStage,
  ProviderStatus,
  SkillDna,
  SkillMatch,
  StartAnalysisResponse,
} from '@caseguard/schemas';
import type { AgentRunRequest, AgentRunResult, AiHealth } from '@caseguard/ai';
import type { ObjectStore } from '../storage';
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

export interface CounterfactualPort {
  /** Generates, validates and persists scenarios (and hindsight checks) for one fork. */
  runForFork(
    ctx: RequestContext,
    caseId: string,
    forkId: string,
    strategies?: readonly CounterfactualStrategy[],
  ): Promise<CounterfactualScenario[]>;
  /**
   * Ensures every fork flagged as meaningful has scenarios (generating missing ones). The analysis
   * pipeline uses the valid scenarios to estimate avoidable support effort.
   */
  ensureScenarios(ctx: RequestContext, caseId: string): Promise<CounterfactualScenario[]>;
}

export interface SkillsPort {
  /** Scores matchable skills against the evidence known as of `asOf` (default: the whole case). */
  matchForCase(
    ctx: RequestContext,
    caseId: string,
    options?: { asOf?: string },
  ): Promise<SkillMatch[]>;
  /** Extracts draft skills from the case's eligible forks and valid scenarios. */
  extractForCase(ctx: RequestContext, caseId: string): Promise<SkillDna[]>;
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
