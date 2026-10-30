// Model providers
export * from './types';
export * from './errors';
export { DeterministicProvider, runDeterministicTask } from './providers/deterministic/provider';
export type {
  DeterministicProviderOptions,
  DeterministicRunOptions,
  HandlerOverrides,
} from './providers/deterministic/provider';
export { projectScenario } from './providers/deterministic/counterfactual-handler';
export {
  AzureOpenAiProvider,
  AZURE_OPENAI_SCOPE,
  AZURE_VALIDATION_NOTE,
  type AzureAuth,
  type AzureOpenAiProviderOptions,
  type AzureRetryPolicy,
} from './providers/azure/provider';

// Agents, tasks and output contracts
export * from './agents/outputs';
export * from './agents/tasks';
export * from './agents/notices';
export { counterfactualTask, type CounterfactualTaskParams } from './agents/builders';
export { AGENT_CATALOG, type AgentMeta, type AgentDifficulty } from './agents/catalog';
export {
  toStrictJsonSchema,
  findStrictViolations,
  type JsonSchemaObject,
} from './agents/json-schema';

// Prompts
export {
  createPromptRegistry,
  type PromptRegistry,
  type PromptRecordMeta,
  type RegisteredPrompt,
} from './prompts/registry';
export {
  PROMPT_TEMPLATES,
  SECURITY_PREAMBLE,
  type PromptStatus,
  type PromptTemplate,
} from './prompts/templates';
export {
  renderMessages,
  dataBlock,
  deriveNonce,
  escapeForDataBlock,
  DATA_OPEN,
  DATA_CLOSE,
} from './prompts/render';

// Context, validation
export { buildContext, type ContextDeps } from './context/build';
export { contextProse, contextStructure, contextStructureKey } from './context/fingerprint';
export { scopeAnalysis, type ScopedAnalysis } from './context/scope';
export type * from './context/types';
export * from './validators';

// Governance, cache, resilience
export {
  TokenGovernor,
  DETERMINISTIC_MODEL,
  type BudgetRequest,
  type BudgetVerdict,
  type GovernorLimits,
  type GovernorOptions,
  type RouteDecision,
  type UsageSample,
  type UsageTotals,
} from './governor/token-governor';
export { fitContextToBudget, type FitResult } from './governor/fit';
export {
  SemanticCache,
  type CacheHit,
  type CacheScope,
  type CacheStats,
  type InvalidationFilter,
  type SemanticCacheOptions,
} from './cache/semantic-cache';
export {
  CircuitBreaker,
  DEFAULT_CONFIG_FAULT_THRESHOLD,
  type BreakerSnapshot,
  type BreakerState,
  type CircuitBreakerOptions,
} from './resilience/circuit-breaker';
export { Bulkhead, type BulkheadStats } from './resilience/bulkhead';

// Orchestration
export { AiOrchestrator } from './orchestrator/orchestrator';
export { prepareTask, type PrepareDeps, type PreparedTask } from './orchestrator/prepare';
export { buildExecutionRecord, type ResultSource } from './orchestrator/records';
export type {
  AgentRunRequest,
  AgentRunResult,
  AiHealth,
  AiHealthFailure,
  AiOrchestratorOptions,
  InputFlags,
  ValidationRejection,
} from './orchestrator/types';

// Utilities the API layer may reuse
export { createIdGenerator } from './util/ids';
export { redactSecrets, createSecretScrubber } from './util/redact';

// Evaluation harness (spec 13)
export { runEvaluation, type EvalOptions } from './eval/harness';
export { runAdversarialSuite, runControlSuite } from './eval/adversarial';
export { planSamples, type PlanOptions, type PlannedSample } from './eval/plan';
export { evalReportToJson, evalReportToMarkdown } from './eval/report';
export * from './eval/types';
