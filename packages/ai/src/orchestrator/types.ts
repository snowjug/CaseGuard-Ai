import type {
  AgentName,
  DependencyHealth,
  HealthStatus,
  ModelConfig,
  ModelExecutionWithUsage,
  ProviderStatus,
} from '@caseguard/schemas';
import type { SemanticCache, CacheStats } from '../cache/semantic-cache';
import type { AgentOutputs, IssueKind } from '../agents/outputs';
import type { AgentTaskOf } from '../agents/tasks';
import type { GovernorLimits, TokenGovernor } from '../governor/token-governor';
import type { HandlerOverrides } from '../providers/deterministic/provider';
import type { PromptRegistry } from '../prompts/registry';
import type { BreakerSnapshot } from '../resilience/circuit-breaker';
import type { BulkheadStats } from '../resilience/bulkhead';
import type { OutputIssue, ValidationLimits } from '../validators/types';
import type {
  Clock,
  IdGenerator,
  InjectionScanner,
  Logger,
  Metrics,
  ModelMessage,
  ModelProvider,
  RandomSource,
  Redactor,
} from '../types';
import type { ResultSource } from './records';

export interface AgentRunRequest<A extends AgentName> {
  task: AgentTaskOf<A>;
  /** Cancels the whole pipeline, including provider retries and queue waits. */
  signal?: AbortSignal;
  correlationId?: string;
  /** Attach the rendered prompt and raw model text to the result (never persisted by this package). */
  retainContent?: boolean;
  /** Skip the model and use deterministic code for this task. */
  forceDeterministic?: boolean;
}

/** Why a model proposal was not used. Contains our own wording only, never raw model text. */
export interface ValidationRejection {
  kinds: IssueKind[];
  issues: OutputIssue[];
  /** Whether a repair attempt could have helped (policy, temporal and injection issues never are). */
  repairable: boolean;
  repairAttempted: boolean;
  summary: string;
}

export interface InputFlags {
  /** Instruction-like passages found in the untrusted case text (flagged, never obeyed). */
  injectionIndicators: number;
  findings: { ruleId: string; severity: 'low' | 'medium' | 'high'; eventId: string | null }[];
}

export interface AgentRunResult<A extends AgentName> {
  /** Validated model proposal, cached proposal, or the deterministic result. */
  result: AgentOutputs[A];
  /** Persistable record: hashes and metadata only. */
  modelExecution: ModelExecutionWithUsage;
  source: ResultSource;
  rejection: ValidationRejection | null;
  inputFlags: InputFlags;
  /** Honest, user-safe notes (fallback, compression, simulated labelling). */
  notices: string[];
  /** Present only when `retainContent` was requested. */
  content?: { messages: ModelMessage[]; rawOutput: string | null };
}

export interface AiOrchestratorOptions {
  /** Governed model configuration (budgets, routing, prices, breaker, cache). */
  config: ModelConfig;
  /** Primary provider; defaults to the deterministic provider. */
  provider?: ModelProvider;
  /** Fallback provider; defaults to the deterministic provider. */
  deterministic?: ModelProvider;
  promptRegistry?: PromptRegistry;
  clock?: Clock;
  ids?: IdGenerator;
  random?: RandomSource;
  logger?: Logger;
  metrics?: Metrics;
  /** Shared injection scanner from the security package; a conservative built-in is the default. */
  injectionScanner?: InjectionScanner;
  /** Redactor applied to case text before it reaches a prompt; secret patterns are always masked. */
  redactor?: Redactor;
  governor?: TokenGovernor;
  limits?: Partial<GovernorLimits>;
  cache?: SemanticCache | null;
  maxConcurrent?: number;
  maxQueue?: number;
  /** Record owner for execution records. */
  createdBy?: string;
  /** Validator-feedback repair attempts per task (bounded by the analysis-depth setting). */
  maxRepairAttempts?: number;
  handlerOverrides?: HandlerOverrides;
  validationLimits?: Partial<ValidationLimits>;
}

export interface AiHealth {
  status: HealthStatus;
  /** Matches the `system.provider` route contract. */
  provider: ProviderStatus;
  /** Matches the dependency-health contract of the system health route. */
  dependency: DependencyHealth;
  breakers: BreakerSnapshot[];
  bulkhead: BulkheadStats;
  cache: CacheStats & { enabled: boolean };
  /** True while requests are being served by deterministic code because the model path is unavailable. */
  degraded: boolean;
  degradedReason: string | null;
  notes: string[];
}
