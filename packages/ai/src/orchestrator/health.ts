import type { DependencyHealth, HealthStatus, ProviderStatus } from '@caseguard/schemas';
import type { CacheStats, SemanticCache } from '../cache/semantic-cache';
import type { TokenGovernor } from '../governor/token-governor';
import type { Bulkhead } from '../resilience/bulkhead';
import type { CircuitBreaker } from '../resilience/circuit-breaker';
import type { ModelProvider } from '../types';
import { toIso } from '../util/ids';
import type { CallFailure } from './run-state';
import type { AiHealth, AiHealthFailure } from './types';

/** The outcome of the most recent provider call that was actually made. */
export interface LastCall {
  ok: boolean;
  atMs: number;
  latencyMs: number;
  /** Set when the call failed: codes only, never a message. */
  failure: CallFailure | null;
}

export interface HealthInputs {
  provider: ModelProvider;
  governor: TokenGovernor;
  breaker: CircuitBreaker | null;
  bulkhead: Bulkhead;
  cache: SemanticCache | null;
  lastCall: LastCall | null;
  lastFallback: { atMs: number; reason: string } | null;
  nowMs: number;
}

const EMPTY_CACHE: CacheStats = {
  hits: 0,
  exactHits: 0,
  nearHits: 0,
  misses: 0,
  expirations: 0,
  evictions: 0,
  size: 0,
};

const CHECK_CONFIGURATION = 'Check the deployment name, endpoint, credentials and role assignment.';

/** Code, HTTP status and sanitised cause, for example `bad_request, HTTP 404, DeploymentNotFound`. */
function describeFailure(failure: CallFailure): string {
  return [
    failure.code,
    failure.status === null ? null : `HTTP ${failure.status}`,
    failure.causeCode,
  ]
    .filter((part): part is string => part !== null)
    .join(', ');
}

/**
 * Honest provider health. A remote provider is only "healthy" after a call actually succeeded;
 * before any call it is unknown (null). A failed last call, whatever its kind, shows as degraded
 * with its code, status and cause; repeated configuration faults (rejected credentials, a
 * deployment that does not exist) are reported as misconfiguration, and an open breaker is
 * degraded because requests are still being served by deterministic code.
 */
export function buildHealth(input: HealthInputs): AiHealth {
  const descriptor = input.provider.describe();
  const config = input.governor.modelConfig;
  const breaker = input.breaker?.snapshot() ?? null;
  const remote = descriptor.kind !== 'deterministic';
  const lastCall = input.lastCall;
  const failure = lastCall?.failure ?? null;
  const lastFailed = remote && lastCall !== null && !lastCall.ok;
  const heldBack = remote && breaker !== null && breaker.state !== 'closed';
  const misconfigured = remote && (input.breaker?.misconfigured ?? false);
  const degraded = heldBack || lastFailed;
  const healthy: boolean | null = !remote
    ? true
    : breaker?.state === 'open'
      ? false
      : (lastCall?.ok ?? null);
  const status: HealthStatus = !remote
    ? 'healthy'
    : degraded
      ? 'degraded'
      : lastCall === null
        ? 'unknown'
        : 'healthy';
  const ago = lastCall
    ? `${Math.max(0, Math.round((input.nowMs - lastCall.atMs) / 1000))}s ago`
    : null;
  const failureText = failure ? describeFailure(failure) : null;
  const suffix = failureText ? ` (${failureText})` : '';

  let degradedReason: string | null = null;
  if (heldBack) {
    degradedReason = misconfigured
      ? `The AI provider is misconfigured: ${input.breaker?.configurationFaults() ?? 0} consecutive calls were rejected as a configuration fault${suffix}. ${CHECK_CONFIGURATION} Circuit breaker is ${breaker?.state ?? 'open'}; requests are served by deterministic code.`
      : `Circuit breaker is ${breaker?.state ?? 'open'}; requests are served by deterministic code.`;
  } else if (lastFailed) {
    degradedReason = `The last AI provider call failed ${ago ?? 'just now'}${suffix}; that request was served by deterministic code.${failure?.configuration ? ` This may be a configuration fault. ${CHECK_CONFIGURATION}` : ''}`;
  }
  const detail = !remote
    ? 'Deterministic knowledge-pack provider (simulated values, fully offline).'
    : (degradedReason ??
      (lastCall
        ? `Last call succeeded ${ago ?? 'just now'}.`
        : 'Configured; no call has been made yet, so health is unknown.'));
  const checkedAt = toIso(input.nowMs);
  const provider: ProviderStatus = {
    kind: descriptor.kind,
    configured: descriptor.configured,
    healthy,
    model: descriptor.model,
    simulated: descriptor.simulated,
    checkedAt,
    detail: detail.slice(0, 400),
    validationNote: descriptor.validationNote.slice(0, 400),
    limits: {
      maxInputTokens: config.maxInputTokens,
      maxOutputTokens: config.maxOutputTokens,
      timeoutMs: config.timeoutMs,
      maxRetries: config.maxRetries,
    },
  };
  const dependency: DependencyHealth = {
    name: 'ai-provider',
    kind: 'ai_provider',
    status,
    latencyMs: lastCall?.ok ? lastCall.latencyMs : null,
    detail: provider.detail,
    checkedAt,
    simulated: descriptor.simulated,
  };
  const lastFailure: AiHealthFailure | null =
    remote && lastFailed && failure && lastCall
      ? {
          code: failure.code,
          status: failure.status,
          causeCode: failure.causeCode,
          configurationFault: failure.configuration,
          at: toIso(lastCall.atMs),
        }
      : null;
  const notes: string[] = [];
  if (remote) notes.push(descriptor.validationNote);
  if (misconfigured) {
    notes.push(
      `The AI provider is misconfigured${suffix}: analyses use deterministic code until it is fixed. ${CHECK_CONFIGURATION}`,
    );
  }
  if (input.lastFallback) {
    notes.push(
      `Last fallback to deterministic code: ${input.lastFallback.reason} at ${toIso(input.lastFallback.atMs)}.`,
    );
  }
  const { costLimits, unitPrices } = config;
  if (
    (costLimits.perRequestUsd !== null ||
      costLimits.perCaseUsd !== null ||
      costLimits.perDayUsd !== null) &&
    (unitPrices.inputPer1kUsd === null || unitPrices.outputPer1kUsd === null)
  ) {
    notes.push(
      'A cost limit is configured without unit prices: model calls are refused because cost cannot be estimated.',
    );
  }
  return {
    status,
    provider,
    dependency,
    breakers: breaker ? [breaker] : [],
    bulkhead: input.bulkhead.stats(),
    cache: { ...(input.cache?.stats() ?? EMPTY_CACHE), enabled: input.cache?.enabled ?? false },
    degraded,
    degradedReason,
    misconfigured,
    lastFailure,
    notes,
  };
}
