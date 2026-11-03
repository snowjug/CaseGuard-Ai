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
// Test-only provider: replays a stated script. The configuration loader refuses it outside local and test runtimes.
export {
  ScriptedProvider as ScriptedTestProvider,
  createScriptedTestProvider,
  SCRIPTED_MODEL,
  SCRIPTED_VALIDATION_NOTE,
  type Script,
  type ScriptEntry,
  type ScriptFailure,
  type ScriptStep,
  type ScriptedCall,
  type ScriptedProviderOptions,
} from './providers/scripted/provider';

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

// Optional model-assisted review: proposals, grounding rules, hybrid policy, orchestration entry
export {
  runModelAssistedReview,
  ASSISTANCE_REASON_CODES,
  type Assistance,
  type AssistanceMode,
  type AssistanceReasonCode,
  type ReviewDeps,
  type ReviewInput,
  type ReviewResult,
} from './reasoning/run';
export {
  combine,
  critiquesOfEngine,
  findingKey,
  stanceOf,
  type CombineInput,
  type ConclusionRef,
  type CriticInput,
  type EngineNote,
} from './reasoning/policy';
export {
  deterministicFactsOf,
  isAtOrBefore,
  isBefore,
  mentions,
  unmetRequirementsAt,
  type ActionFact,
  type CounterfactualFact,
  type DeterministicFacts,
  type FactsExtras,
  type FactsScope,
  type ForkFact,
  type HypothesisFact,
  type RecommendationFact,
  type RequirementFact,
  type SignalFact,
  type Stamp,
} from './reasoning/facts';
export { buildConclusions } from './reasoning/conclusions';
export { validateProposalOutput } from './reasoning/validate';
export { locateCitation } from './reasoning/locate';
export {
  PROPOSAL_CODES,
  PROPOSAL_CODE_DESCRIPTIONS,
  type DroppedItem,
  type KeptCritic,
  type KeptCritique,
  type KeptProposal,
  type ProposalCode,
  type ProposalIssue,
  type ProposalReport,
  type ReviewConclusion,
} from './reasoning/types';
