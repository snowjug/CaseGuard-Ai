import type { AgentName } from '@caseguard/schemas';
import type { Logger, Metrics } from '../types';
import type { FallbackCause, RunState } from './run-state';
import type { AgentRunResult } from './types';

/** Records metrics for a fallback (reason and any validation rejection kinds). */
export function recordFallbackMetrics(
  metrics: Metrics,
  agent: AgentName,
  cause: FallbackCause,
): void {
  metrics.increment('ai.fallback', 1, { agent, reason: cause.code });
  for (const kind of cause.rejection?.kinds ?? []) {
    metrics.increment('ai.validation.rejected', 1, { agent, kind });
  }
}

/**
 * Emits the structured log line and the model/token metrics for one finished task. Field names
 * follow the observability log contract (agent, model, status, latencyMs, promptTokens ...);
 * prompts, case text and secrets never appear.
 */
export function emitExecution(
  logger: Logger,
  metrics: Metrics,
  run: RunState,
  result: AgentRunResult<AgentName>,
): void {
  const record = result.modelExecution;
  const usage = record.usage;
  metrics.increment('ai.model.calls', 1, {
    agent: run.agent,
    provider: record.provider,
    status: record.status,
  });
  metrics.observe('ai.model.latency_ms', record.latencyMs, {
    agent: run.agent,
    provider: record.provider,
  });
  if (usage) {
    const source = usage.tokenSource ?? 'estimated';
    const tags = { agent: run.agent, provider: record.provider, source };
    metrics.increment('ai.tokens.prompt', usage.promptTokens, tags);
    metrics.increment('ai.tokens.completion', usage.completionTokens, tags);
  }
  if (result.inputFlags.injectionIndicators > 0) {
    metrics.increment('ai.injection.flagged', result.inputFlags.injectionIndicators, {
      agent: run.agent,
    });
  }
  logger.info(
    {
      event: 'ai.model.execution',
      agent: run.agent,
      model: record.model,
      provider: record.provider,
      status: record.status,
      source: result.source,
      latencyMs: record.latencyMs,
      promptTokens: usage?.promptTokens ?? 0,
      completionTokens: usage?.completionTokens ?? 0,
      tokenSource: usage?.tokenSource ?? 'estimated',
      cacheHit: usage?.cacheHit ?? false,
      promptVersion: record.promptVersion,
      fallbackReason: record.fallbackReason ?? null,
      injectionIndicators: result.inputFlags.injectionIndicators,
      tenantId: run.tenantId,
      caseId: run.caseId,
      correlationId: run.request.correlationId ?? null,
    },
    'AI task finished',
  );
}
