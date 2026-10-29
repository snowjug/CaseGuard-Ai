import type {
  AnalysisRun,
  CounterfactualScenario,
  CounterfactualStrategy,
  IngestRequest,
  IngestResult,
  Job,
  JobKind,
  JobStage,
  SkillDna,
  SkillMatch,
  StartAnalysisResponse,
} from '@caseguard/schemas';
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
  /** Marks jobs left running by a previous process as failed. Returns how many. */
  recoverOrphans(tenantIds: readonly string[]): Promise<number>;
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

export interface IngestInput {
  readonly source: IngestRequest;
  /** Start the analysis job after ingestion (default true). */
  readonly analyze?: boolean;
  readonly idempotencyKey?: string | null;
}

export interface IngestionPort {
  ingest(ctx: RequestContext, input: IngestInput): Promise<IngestResult>;
}

// ---------------------------------------------------------------- the container

/** Services resolvable from any request context. Implementations are wired in `container.ts`. */
export interface Services {
  readonly jobs: JobPort;
  readonly analysis: AnalysisPort;
  readonly counterfactuals: CounterfactualPort;
  readonly skills: SkillsPort;
  readonly ingestion: IngestionPort;
  readonly objects: ObjectStore;
}

export type { JobStage };
