import type { SemanticCache } from '../cache/semantic-cache';
import { ProviderError, describeError, executionStatusFor } from '../errors';
import type { RouteDecision, TokenGovernor } from '../governor/token-governor';
import { renderMessages } from '../prompts/render';
import type { Bulkhead } from '../resilience/bulkhead';
import type { CircuitBreaker } from '../resilience/circuit-breaker';
import type { Clock, Logger, Metrics, ModelMessage, ModelProvider, ModelRequest } from '../types';
import { validateAgentOutput } from '../validators';
import type { ValidationReport } from '../validators/types';
import { messageTokens, prepareTask, type PrepareDeps, type PreparedTask } from './prepare';
import type { CallFacts } from './records';
import {
  ZERO_USAGE,
  usageSample,
  type CallFailure,
  type CallOutcome,
  type FallbackCause,
  type RunState,
} from './run-state';
import type { ValidationRejection } from './types';

export type ModelPathOutcome =
  | {
      kind: 'model';
      prepared: PreparedTask;
      report: ValidationReport<unknown>;
      model: string;
      calls: readonly CallFacts[];
      repairs: number;
      rawOutput: string | null;
    }
  | {
      kind: 'cache';
      prepared: PreparedTask;
      value: unknown;
      meta: {
        provider: 'deterministic' | 'azure-openai';
        model: string;
        usage: { totalTokens: number };
      };
      report: ValidationReport<unknown>;
      model: string;
    }
  | { kind: 'fallback'; prepared: PreparedTask; cause: FallbackCause }
  | {
      kind: 'cancelled';
      prepared: PreparedTask;
      model: string;
      calls: readonly CallFacts[];
      repairs: number;
    };

export interface ModelPathDeps {
  provider: ModelProvider;
  governor: TokenGovernor;
  cache: SemanticCache | null;
  breaker: CircuitBreaker | null;
  bulkhead: Bulkhead;
  clock: Clock;
  logger: Logger;
  metrics: Metrics;
  prepare: PrepareDeps;
  maxRepairAttempts: number;
  toRequest: (
    run: RunState,
    prepared: PreparedTask,
    messages: readonly ModelMessage[],
    model: string,
  ) => ModelRequest;
  /** Reports the outcome of every provider call that was made, except one the caller cancelled. */
  onCallResult: (ok: boolean, latencyMs: number, failure?: CallFailure) => void;
}

const fallbackCause = (
  model: string,
  c: Partial<FallbackCause> & Pick<FallbackCause, 'status' | 'code' | 'detail'>,
): FallbackCause => ({
  error: null,
  validation: null,
  rejection: null,
  earlyStopped: false,
  calls: [],
  repairAttempts: 0,
  rawOutput: null,
  model,
  ...c,
});

/**
 * The remote-model branch of the pipeline: fit the context to the budget, consult the tenant
 * cache, check budgets and the circuit breaker, call the provider through the bulkhead, validate,
 * and make at most the configured number of validator-feedback repair attempts.
 */
export class ModelPath {
  constructor(private readonly deps: ModelPathDeps) {}

  private async call(
    run: RunState,
    prepared: PreparedTask,
    messages: readonly ModelMessage[],
    model: string,
    calls: CallFacts[],
  ): Promise<CallOutcome> {
    const { breaker } = this.deps;
    if (breaker && !breaker.tryAcquire()) {
      return {
        error: new ProviderError('overloaded', 'The AI provider circuit breaker is open.'),
        circuitOpen: true,
      };
    }
    const request = this.deps.toRequest(run, prepared, messages, model);
    try {
      const response = await this.deps.bulkhead.run(
        () => this.deps.provider.complete(request),
        run.request.signal,
      );
      breaker?.recordSuccess();
      this.deps.onCallResult(true, response.latencyMs);
      this.finishCall(run, calls, {
        attempts: response.attempts,
        retries: response.retries,
        latencyMs: response.latencyMs,
        usage: response.usage,
      });
      return { response };
    } catch (error) {
      const known = error instanceof ProviderError;
      const failure = known
        ? error
        : new ProviderError('invalid_response', 'The provider failed unexpectedly.');
      if (!known) {
        this.deps.logger.error(
          { event: 'ai.provider.unexpected', agent: run.agent, error: describeError(error) },
          'Unexpected provider failure',
        );
      }
      this.reportFailure(run, failure);
      this.finishCall(run, calls, {
        attempts: failure.attempts,
        retries: Math.max(0, failure.attempts - 1),
        latencyMs: 0,
        usage: ZERO_USAGE,
      });
      return { error: failure, circuitOpen: false };
    }
  }

  /**
   * Books a finished call right away: the budget checks that follow (the repair call, the next
   * task of the same case) must see what this call used. Calls that failed outright used nothing.
   */
  private finishCall(run: RunState, calls: CallFacts[], facts: CallFacts): void {
    calls.push(facts);
    if (facts.usage.promptTokens + facts.usage.completionTokens > 0) {
      this.deps.governor.record(usageSample(run, [facts]));
    }
  }

  /**
   * Tells the breaker, health and the logs about a failed call. Every failure except the caller
   * leaving shows up in health as the last call having failed; configuration faults (404, 401,
   * 403, unusable settings) are counted separately so a wrong deployment name stops costing calls.
   * Only codes, numbers and the sanitised cause code are logged: no message, URL or header.
   */
  private reportFailure(run: RunState, failure: ProviderError): void {
    const { breaker, logger, metrics, provider } = this.deps;
    if (failure.isConfigurationFault) breaker?.recordConfigurationFault();
    else if (failure.countsTowardBreaker) breaker?.recordFailure();
    else breaker?.recordNeutral();
    if (failure.code === 'cancelled') return;
    const configuration = failure.isConfigurationFault;
    this.deps.onCallResult(false, 0, {
      code: failure.code,
      status: failure.status,
      causeCode: failure.causeCode,
      configuration,
    });
    metrics.increment('ai.provider.failure', 1, {
      provider: provider.kind,
      code: failure.code,
      configuration: String(configuration),
    });
    logger.warn(
      {
        event: 'ai.provider.failure',
        agent: run.agent,
        provider: provider.kind,
        code: failure.code,
        status: failure.status,
        causeCode: failure.causeCode,
        attempts: failure.attempts,
        configurationFault: configuration,
      },
      'AI provider call failed',
    );
  }

  private budgetFor(
    run: RunState,
    prepared: PreparedTask,
    estimatedInputTokens = prepared.fit.tokensAfter,
  ) {
    return this.deps.governor.checkBudget({
      tenantId: run.tenantId,
      caseId: run.caseId,
      agent: run.agent,
      estimatedInputTokens,
      maxOutputTokens: prepared.limits.maxOutputTokens,
    });
  }

  async run(run: RunState, route: RouteDecision): Promise<ModelPathOutcome> {
    const model = route.model;
    const prepared = prepareTask(run.task, run.requestId, model, this.deps.prepare, {
      applyBudget: true,
    });
    const fallback = (
      c: Partial<FallbackCause> & Pick<FallbackCause, 'status' | 'code' | 'detail'>,
    ): ModelPathOutcome => ({
      kind: 'fallback',
      prepared,
      cause: fallbackCause(model, c),
    });

    if (!prepared.fit.fits) {
      return fallback({
        status: 'budget_exceeded',
        code: 'input_too_large',
        detail: `Even the most compressed context needs about ${prepared.fit.tokensAfter} tokens; the per-request limit is ${prepared.limits.maxInputTokens}.`,
      });
    }

    const { cache } = this.deps;
    const hit =
      cache && prepared.cacheScope && prepared.cacheInput
        ? cache.get(prepared.cacheScope, prepared.cacheInput)
        : null;
    if (hit) {
      const report = validateAgentOutput(run.agent, hit.value, prepared.vctx);
      if (report.ok)
        return { kind: 'cache', prepared, value: hit.value, meta: hit.meta, report, model };
    }

    const verdict = this.budgetFor(run, prepared);
    if (!verdict.allowed) {
      return fallback({
        status: 'budget_exceeded',
        code: verdict.code,
        detail: verdict.reason,
        error: verdict.reason,
      });
    }

    const calls: CallFacts[] = [];
    let outcome = await this.call(run, prepared, prepared.messages, model, calls);
    let repairs = 0;
    let repairSkipped: string | null = null;
    let report: ValidationReport<unknown> | null = null;
    let rawOutput: string | null = null;
    for (;;) {
      if ('error' in outcome) {
        const failure = outcome.error;
        if (failure.code === 'cancelled')
          return { kind: 'cancelled', prepared, model, calls, repairs };
        return fallback({
          status: outcome.circuitOpen ? 'circuit_open' : executionStatusFor(failure),
          code: outcome.circuitOpen ? 'circuit_open' : failure.code,
          detail: failure.message,
          error: describeError(failure),
          calls,
          repairAttempts: repairs,
          rawOutput,
          validation: report?.outcome ?? null,
        });
      }
      const { response } = outcome;
      rawOutput = response.outputText;
      report = validateAgentOutput(run.agent, response.output, prepared.vctx);
      if (report.ok) break;
      if (!report.repairable || repairs >= this.deps.maxRepairAttempts) break;
      const feedback = [
        ...report.issues.slice(0, 8).map((i) => `${i.path}: ${i.message}`),
        ...(response.finishReason === 'length' ? ['The reply was cut off; keep it shorter.'] : []),
      ];
      const repairMessages = renderMessages(prepared.prompt, prepared.fit.built.context, {
        nonce: prepared.nonce,
        repairFeedback: feedback,
      });
      // The first call is already booked, and the repair prompt is longer than the first one.
      const allowance = this.budgetFor(run, prepared, messageTokens(repairMessages));
      if (!allowance.allowed) {
        repairSkipped = allowance.reason;
        break;
      }
      repairs++;
      outcome = await this.call(run, prepared, repairMessages, model, calls);
    }

    const last = calls[calls.length - 1];
    if (report.ok && last) {
      if (cache && prepared.cacheScope && prepared.cacheInput && report.output !== null) {
        cache.set(prepared.cacheScope, prepared.cacheInput, report.output, {
          provider: this.deps.provider.kind,
          model,
          usage: last.usage,
        });
      }
      return { kind: 'model', prepared, report, model, calls, repairs, rawOutput };
    }
    const rejection: ValidationRejection = {
      kinds: report.kinds,
      issues: report.issues,
      repairable: report.repairable,
      repairAttempted: repairs > 0,
      summary: `The model proposal was rejected by validation (${report.kinds.join(', ') || 'unknown'}).${repairSkipped === null ? '' : ` A repair attempt was not made: ${repairSkipped}`}`,
    };
    return fallback({
      status: 'rejected_by_validation',
      code: 'rejected_by_validation',
      detail: rejection.summary,
      error: rejection.summary,
      validation: report.outcome,
      rejection,
      earlyStopped: !rejection.repairable && repairs === 0,
      calls,
      repairAttempts: repairs,
      rawOutput,
    });
  }
}
