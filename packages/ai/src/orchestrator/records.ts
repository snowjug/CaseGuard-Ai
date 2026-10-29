import type {
  AgentName,
  ExecutionStatus,
  ModelExecutionWithUsage,
  ProviderKind,
  ValidationOutcome,
} from '@caseguard/schemas';
import type { TrimLevel } from '../context/types';
import type { RegisteredPrompt } from '../prompts/registry';
import type { ModelUsage } from '../types';
import { toIso } from '../util/ids';

export type ResultSource = 'model' | 'cache' | 'deterministic' | 'deterministic_fallback';

export interface CallFacts {
  attempts: number;
  retries: number;
  latencyMs: number;
  usage: ModelUsage;
}

export interface ExecutionFacts {
  tenantId: string;
  caseId: string | null;
  analysisRunId: string | null;
  createdBy: string;
  agent: AgentName;
  prompt: RegisteredPrompt;
  executionId: string;
  usageId: string;
  provider: ProviderKind;
  model: string;
  status: ExecutionStatus;
  startedMs: number;
  completedMs: number;
  calls: readonly CallFacts[];
  repairAttempts: number;
  evidenceIds: readonly string[];
  validation: ValidationOutcome;
  error: string | null;
  /** Null when no result was produced (for example a cancelled execution). */
  resultSource: ResultSource | null;
  fallbackReason: string | null;
  /** True when the result handed to the caller is simulated (deterministic) rather than model output. */
  simulatedResult: boolean;
  cacheHit: boolean;
  cacheSavedTokens: number;
  earlyStopped: boolean;
  inputHash: string | null;
  tokensBefore: number;
  tokensAfter: number;
  trimLevel: TrimLevel;
  estimateCostUsd: (
    promptTokens: number,
    completionTokens: number,
    cachedTokens: number,
  ) => number | null;
}

/** A validation outcome for executions that produced nothing to validate. */
export const NOT_VALIDATED: ValidationOutcome = {
  schemaValid: true,
  citationsValid: true,
  policyValid: true,
  temporalValid: true,
  issues: [],
};

const QUALITY_IMPACT = {
  none: 'No compression was applied.',
  negligible: 'Event text was shortened; evidence summaries and ids are unchanged.',
  possible_minor: 'Context was compressed to evidence summaries; some detail may be missing.',
} as const;

function qualityImpact(level: TrimLevel): {
  level: 'none' | 'negligible' | 'possible_minor';
  note: string;
} {
  const key = level === 0 ? 'none' : level === 1 ? 'negligible' : 'possible_minor';
  return { level: key, note: QUALITY_IMPACT[key] };
}

/**
 * Builds the persistable execution + token-usage record. It carries hashes and metadata only:
 * never the prompt, the context or the raw model output.
 */
export function buildExecutionRecord(facts: ExecutionFacts): ModelExecutionWithUsage {
  const sum = (pick: (c: CallFacts) => number): number =>
    facts.calls.reduce((s, c) => s + pick(c), 0);
  const promptTokens = sum((c) => c.usage.promptTokens);
  const completionTokens = sum((c) => c.usage.completionTokens);
  const cachedTokens = sum((c) => c.usage.cachedTokens);
  const measured =
    facts.calls.length > 0 && facts.calls.every((c) => c.usage.source === 'measured');
  const completedAt = toIso(facts.completedMs);
  const meta = {
    tenantId: facts.tenantId,
    createdAt: completedAt,
    updatedAt: completedAt,
    createdBy: facts.createdBy,
    version: 1,
  };
  const compression =
    facts.tokensBefore > 0
      ? Math.min(1, Math.max(0, 1 - facts.tokensAfter / facts.tokensBefore))
      : 0;
  const trimSavings = Math.max(0, facts.tokensBefore - facts.tokensAfter);
  const earlyStopSavings = facts.earlyStopped ? Math.round(sum((c) => c.usage.totalTokens)) : 0;
  const latency = Math.max(0, Math.round(facts.completedMs - facts.startedMs));

  return {
    ...meta,
    id: facts.executionId,
    caseId: facts.caseId,
    analysisRunId: facts.analysisRunId,
    agent: facts.agent,
    promptVersionId: facts.prompt.id,
    promptVersion: facts.prompt.version,
    provider: facts.provider,
    model: facts.model.slice(0, 120),
    status: facts.status,
    attempts: sum((c) => c.attempts),
    latencyMs: latency,
    startedAt: toIso(facts.startedMs),
    completedAt,
    inputEvidenceIds: facts.evidenceIds.slice(0, 500),
    validation: facts.validation,
    error: facts.error === null ? null : facts.error.slice(0, 400),
    simulated: facts.simulatedResult,
    tokenUsageId: facts.usageId,
    promptHash: facts.prompt.templateHash,
    inputHash: facts.inputHash,
    fallbackReason: facts.fallbackReason === null ? null : facts.fallbackReason.slice(0, 300),
    ...(facts.resultSource === null ? {} : { resultSource: facts.resultSource }),
    retries: sum((c) => c.retries),
    repairAttempts: facts.repairAttempts,
    usage: {
      ...meta,
      id: facts.usageId,
      modelExecutionId: facts.executionId,
      caseId: facts.caseId,
      agent: facts.agent,
      provider: facts.provider,
      model: facts.model,
      promptTokens,
      completionTokens,
      cachedTokens,
      totalTokens: promptTokens + completionTokens,
      estimatedCostUsd: facts.estimateCostUsd(promptTokens, completionTokens, cachedTokens),
      contextTokensBefore: facts.tokensBefore,
      contextTokensAfter: facts.tokensAfter,
      compressionRatio: Math.round(compression * 1000) / 1000,
      cacheHit: facts.cacheHit,
      earlyStopped: facts.earlyStopped,
      estimatedSavingsTokens: trimSavings + facts.cacheSavedTokens + earlyStopSavings,
      estimatedQualityImpact:
        facts.status === 'succeeded' || facts.status === 'cache_hit'
          ? qualityImpact(facts.trimLevel)
          : { level: 'unknown', note: 'No model result was used for this execution.' },
      latencyMs: Math.round(sum((c) => c.latencyMs)),
      simulated: facts.simulatedResult,
      estimated: true,
      tokenSource: measured ? 'measured' : 'estimated',
    },
  };
}
