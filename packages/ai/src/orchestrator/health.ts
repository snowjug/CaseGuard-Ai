import type { DependencyHealth, HealthStatus, ProviderStatus } from '@caseguard/schemas';
import type { CacheStats, SemanticCache } from '../cache/semantic-cache';
import type { TokenGovernor } from '../governor/token-governor';
import type { Bulkhead } from '../resilience/bulkhead';
import type { CircuitBreaker } from '../resilience/circuit-breaker';
import type { ModelProvider } from '../types';
import { toIso } from '../util/ids';
import type { AiHealth } from './types';

export interface HealthInputs {
  provider: ModelProvider;
  governor: TokenGovernor;
  breaker: CircuitBreaker | null;
  bulkhead: Bulkhead;
  cache: SemanticCache | null;
  lastCall: { ok: boolean; atMs: number; latencyMs: number } | null;
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

/**
 * Honest provider health. A remote provider is only "healthy" after a call actually succeeded;
 * before any call it is unknown (null), and an open breaker is reported as degraded because
 * requests are still being served by deterministic code.
 */
export function buildHealth(input: HealthInputs): AiHealth {
  const descriptor = input.provider.describe();
  const config = input.governor.modelConfig;
  const breaker = input.breaker?.snapshot() ?? null;
  const remote = descriptor.kind !== 'deterministic';
  const degraded = remote && breaker !== null && breaker.state !== 'closed';
  const healthy: boolean | null = !remote
    ? true
    : breaker?.state === 'open'
      ? false
      : (input.lastCall?.ok ?? null);
  const status: HealthStatus = !remote
    ? 'healthy'
    : degraded
      ? 'degraded'
      : input.lastCall === null
        ? 'unknown'
        : input.lastCall.ok
          ? 'healthy'
          : 'degraded';
  const degradedReason = degraded
    ? `Circuit breaker is ${breaker?.state ?? 'open'}; requests are served by deterministic code.`
    : null;
  const detail = !remote
    ? 'Deterministic knowledge-pack provider (simulated values, fully offline).'
    : (degradedReason ??
      (input.lastCall
        ? `Last call ${input.lastCall.ok ? 'succeeded' : 'failed'} ${Math.max(0, Math.round((input.nowMs - input.lastCall.atMs) / 1000))}s ago.`
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
    latencyMs: input.lastCall?.ok ? input.lastCall.latencyMs : null,
    detail: provider.detail,
    checkedAt,
    simulated: descriptor.simulated,
  };
  const notes: string[] = [];
  if (remote) notes.push(descriptor.validationNote);
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
    notes,
  };
}
