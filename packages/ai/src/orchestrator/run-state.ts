import type { AgentName, ExecutionStatus, ValidationOutcome } from '@caseguard/schemas';
import type { AgentTask } from '../agents/tasks';
import type { ProviderError, ProviderErrorCode } from '../errors';
import type { ModelResponse } from '../types';
import type { CallFacts } from './records';
import type { AgentRunRequest, ValidationRejection } from './types';

/** Per-invocation state shared by the pipeline stages. */
export interface RunState {
  task: AgentTask;
  request: AgentRunRequest<AgentName>;
  agent: AgentName;
  tenantId: string;
  caseId: string | null;
  analysisRunId: string | null;
  executionId: string;
  usageId: string;
  requestId: string;
  startedMs: number;
}

/** What a failed provider call tells health reporting. Codes and numbers only: nothing free-form. */
export interface CallFailure {
  code: ProviderErrorCode;
  status: number | null;
  causeCode: string | null;
  /** A persistent fault of our own configuration (credentials, deployment, endpoint). */
  configuration: boolean;
}

/** Why the model result was not used and deterministic code answered instead. */
export interface FallbackCause {
  status: ExecutionStatus;
  code: string;
  detail: string;
  error: string | null;
  validation: ValidationOutcome | null;
  rejection: ValidationRejection | null;
  earlyStopped: boolean;
  calls: readonly CallFacts[];
  repairAttempts: number;
  rawOutput: string | null;
  model: string;
}

export type CallOutcome =
  { response: ModelResponse } | { error: ProviderError; circuitOpen: boolean };

export const ZERO_USAGE = {
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  totalTokens: 0,
  source: 'estimated',
} as const;

export interface UsageSample {
  tenantId: string;
  caseId: string | null;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

export function usageSample(run: RunState, calls: readonly CallFacts[]): UsageSample {
  return {
    tenantId: run.tenantId,
    caseId: run.caseId,
    promptTokens: calls.reduce((s, c) => s + c.usage.promptTokens, 0),
    completionTokens: calls.reduce((s, c) => s + c.usage.completionTokens, 0),
    cachedTokens: calls.reduce((s, c) => s + c.usage.cachedTokens, 0),
  };
}
