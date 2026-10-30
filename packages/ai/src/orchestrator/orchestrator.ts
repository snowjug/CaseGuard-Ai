import type {
  AgentName,
  ExecutionStatus,
  ModelExecutionWithUsage,
  ProviderKind,
  ValidationOutcome,
} from '@caseguard/schemas';
import type { AgentOutputs } from '../agents/outputs';
import type { AgentTask } from '../agents/tasks';
import { SemanticCache } from '../cache/semantic-cache';
import { AiTaskError } from '../errors';
import { DETERMINISTIC_MODEL, TokenGovernor, type RouteDecision } from '../governor/token-governor';
import { createPromptRegistry } from '../prompts/registry';
import { DeterministicProvider } from '../providers/deterministic/provider';
import { Bulkhead } from '../resilience/bulkhead';
import { CircuitBreaker } from '../resilience/circuit-breaker';
import {
  noopLogger,
  noopMetrics,
  systemClock,
  type Clock,
  type IdGenerator,
  type Logger,
  type Metrics,
  type ModelMessage,
  type ModelProvider,
  type ModelRequest,
} from '../types';
import { createIdGenerator } from '../util/ids';
import { validateAgentOutput } from '../validators';
import { defaultInjectionScanner } from '../validators/injection';
import { buildHealth, type LastCall } from './health';
import { ModelPath, type ModelPathOutcome } from './model-path';
import { prepareTask, type PrepareDeps, type PreparedTask } from './prepare';
import { NOT_VALIDATED, buildExecutionRecord, type CallFacts, type ResultSource } from './records';
import type { FallbackCause, RunState } from './run-state';
import { emitExecution, recordFallbackMetrics } from './telemetry';
import type {
  AgentRunRequest,
  AgentRunResult,
  AiHealth,
  AiOrchestratorOptions,
  InputFlags,
} from './types';

const DETERMINISTIC_ROUTE: RouteDecision = {
  tier: 'deterministic',
  model: DETERMINISTIC_MODEL,
  reason: 'Deterministic analysis requested.',
};

interface RecordFacts {
  provider: ProviderKind;
  model: string;
  status: ExecutionStatus;
  calls: readonly CallFacts[];
  repairAttempts: number;
  validation: ValidationOutcome;
  error: string | null;
  resultSource: ResultSource | null;
  fallbackReason: string | null;
  simulatedResult: boolean;
  cacheHit: boolean;
  cacheSavedTokens: number;
  earlyStopped: boolean;
}

/**
 * Runs AI agent tasks: build a minimised context, route, call a provider, validate, optionally
 * repair once, and accept the proposal or fall back to deterministic code. "LLM proposes, code
 * disposes": no model output is returned without schema, citation, temporal, policy, grounding and
 * injection validation, and every outcome yields a persistable execution record (hashes and
 * metadata only, never prompts or raw model output).
 */
export class AiOrchestrator {
  readonly governor: TokenGovernor;
  readonly cache: SemanticCache | null;
  readonly breaker: CircuitBreaker | null;
  readonly bulkhead: Bulkhead;
  private readonly provider: ModelProvider;
  private readonly deterministic: ModelProvider;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly logger: Logger;
  private readonly metrics: Metrics;
  private readonly createdBy: string;
  private readonly deps: PrepareDeps;
  private readonly modelPath: ModelPath;
  private lastCall: LastCall | null = null;
  private lastFallback: { atMs: number; reason: string } | null = null;

  constructor(options: AiOrchestratorOptions) {
    this.clock = options.clock ?? systemClock;
    this.ids =
      options.ids ??
      createIdGenerator({
        clock: this.clock,
        ...(options.random ? { random: options.random } : {}),
      });
    this.logger = options.logger ?? noopLogger;
    this.metrics = options.metrics ?? noopMetrics;
    this.createdBy = options.createdBy ?? 'system:ai-orchestrator';
    this.governor =
      options.governor ??
      new TokenGovernor({
        config: options.config,
        clock: this.clock,
        ...(options.limits ? { limits: options.limits } : {}),
        logger: this.logger,
        metrics: this.metrics,
      });
    this.deterministic =
      options.deterministic ??
      new DeterministicProvider({
        clock: this.clock,
        governor: this.governor,
        ...(options.handlerOverrides ? { overrides: options.handlerOverrides } : {}),
      });
    this.provider = options.provider ?? this.deterministic;
    const cacheConfig = options.config.semanticCache;
    this.cache =
      options.cache === undefined
        ? new SemanticCache({
            clock: this.clock,
            enabled: cacheConfig.enabled,
            ttlSeconds: cacheConfig.ttlSeconds,
            similarityThreshold: cacheConfig.similarityThreshold,
            metrics: this.metrics,
          })
        : options.cache;
    this.breaker =
      this.provider.kind === 'deterministic'
        ? null
        : new CircuitBreaker({
            name: this.provider.kind,
            failureThreshold: options.config.circuitBreaker.failureThreshold,
            resetMs: options.config.circuitBreaker.resetMs,
            clock: this.clock,
            logger: this.logger,
            metrics: this.metrics,
          });
    this.bulkhead = new Bulkhead({
      name: this.provider.kind,
      maxConcurrent: options.maxConcurrent ?? 4,
      maxQueue: options.maxQueue ?? 16,
    });
    this.deps = {
      registry: options.promptRegistry ?? createPromptRegistry(),
      governor: this.governor,
      redact: options.redactor ?? ((text) => text),
      scanInjection: options.injectionScanner ?? defaultInjectionScanner,
      validationLimits: options.validationLimits,
    };
    this.modelPath = new ModelPath({
      provider: this.provider,
      governor: this.governor,
      cache: this.cache,
      breaker: this.breaker,
      bulkhead: this.bulkhead,
      clock: this.clock,
      logger: this.logger,
      metrics: this.metrics,
      prepare: this.deps,
      maxRepairAttempts: Math.max(
        0,
        Math.min(options.maxRepairAttempts ?? 1, options.config.maxAnalysisDepth - 1),
      ),
      toRequest: (run, prepared, messages, model) => this.toRequest(run, prepared, messages, model),
      onCallResult: (ok, latencyMs, failure) => {
        this.lastCall = { ok, atMs: this.clock.nowMs(), latencyMs, failure: failure ?? null };
      },
    });
  }

  /** Dependencies needed to prepare tasks outside the pipeline (evaluation harness). */
  get prepareDependencies(): PrepareDeps {
    return this.deps;
  }

  get primaryProvider(): ModelProvider {
    return this.provider;
  }

  /** Runs one agent task end to end. Throws only for invalid input, cancellation or an internal defect. */
  async runAgentTask<A extends AgentName>(request: AgentRunRequest<A>): Promise<AgentRunResult<A>> {
    const task = request.task as AgentTask;
    if (task.input.tenantId.length === 0) {
      throw new AiTaskError('invalid_input', 'A tenant id is required for every AI task.');
    }
    if ('view' in task.input && task.input.view.events.length === 0) {
      throw new AiTaskError('invalid_input', 'The temporal view contains no events to analyse.');
    }
    if (request.signal?.aborted) {
      throw new AiTaskError('cancelled', 'The task was cancelled before it started.');
    }
    const run: RunState = {
      task,
      request,
      agent: task.agent,
      tenantId: task.input.tenantId,
      caseId: task.input.caseId,
      analysisRunId: 'analysisRunId' in task.input ? task.input.analysisRunId : null,
      executionId: this.ids.next('exec'),
      usageId: this.ids.next('usage'),
      requestId: this.ids.next('req'),
      startedMs: this.clock.nowMs(),
    };
    const route =
      request.forceDeterministic === true
        ? DETERMINISTIC_ROUTE
        : this.governor.route(task.agent, this.provider.kind);
    const result =
      route.tier === 'deterministic'
        ? await this.produceDeterministic(run, null, null)
        : await this.finishModelPath(run, await this.modelPath.run(run, route));
    emitExecution(this.logger, this.metrics, run, result);
    return result as AgentRunResult<A>;
  }

  /** Provider status and resilience state for the system-health routes. */
  getHealth(): AiHealth {
    return buildHealth({
      provider: this.provider,
      governor: this.governor,
      breaker: this.breaker,
      bulkhead: this.bulkhead,
      cache: this.cache,
      lastCall: this.lastCall,
      lastFallback: this.lastFallback,
      nowMs: this.clock.nowMs(),
    });
  }

  private toRequest(
    run: RunState,
    prepared: PreparedTask,
    messages: readonly ModelMessage[],
    model: string,
  ): ModelRequest {
    return {
      requestId: run.requestId,
      tenantId: run.tenantId,
      agent: run.agent,
      messages,
      structuredOutput: {
        name: prepared.prompt.outputSchemaId,
        schema: prepared.prompt.jsonSchema,
        strict: true,
      },
      maxOutputTokens: prepared.limits.maxOutputTokens,
      temperature: this.governor.modelConfig.temperature,
      timeoutMs: prepared.limits.timeoutMs,
      maxRetries: prepared.limits.maxRetries,
      model: model === DETERMINISTIC_MODEL ? null : model,
      signal: run.request.signal,
      task: run.task,
    };
  }

  private flagsOf(prepared: PreparedTask): InputFlags {
    return {
      injectionIndicators: prepared.fit.built.injection.length,
      findings: prepared.fit.built.injection.map((f) => ({
        ruleId: f.ruleId,
        severity: f.severity,
        eventId: f.eventId,
      })),
    };
  }

  private record(
    run: RunState,
    prepared: PreparedTask,
    facts: RecordFacts,
  ): ModelExecutionWithUsage {
    return buildExecutionRecord({
      tenantId: run.tenantId,
      caseId: run.caseId,
      analysisRunId: run.analysisRunId,
      createdBy: this.createdBy,
      agent: run.agent,
      prompt: prepared.prompt,
      executionId: run.executionId,
      usageId: run.usageId,
      startedMs: run.startedMs,
      completedMs: this.clock.nowMs(),
      evidenceIds: [...prepared.fit.built.index.evidence.keys()],
      inputHash: prepared.fit.built.contextHash,
      trimLevel: prepared.fit.level,
      tokensBefore: prepared.fit.tokensBefore,
      tokensAfter: prepared.fit.tokensAfter,
      estimateCostUsd: (p, c, cached) => this.governor.estimateCostUsd(p, c, cached),
      ...facts,
    });
  }

  /** Domain-backed result: the default route, and the fallback for every model failure. */
  private async produceDeterministic(
    run: RunState,
    cause: FallbackCause | null,
    attempted: PreparedTask | null,
  ): Promise<AgentRunResult<AgentName>> {
    const prepared = prepareTask(run.task, run.requestId, DETERMINISTIC_MODEL, this.deps, {
      applyBudget: false,
    });
    const response = await this.deterministic.complete(
      this.toRequest(run, prepared, prepared.messages, DETERMINISTIC_MODEL),
    );
    const report = validateAgentOutput(run.agent, response.output, prepared.vctx);
    if (!report.ok || report.output === null) {
      this.logger.error(
        {
          event: 'ai.deterministic.invalid',
          agent: run.agent,
          kinds: report.kinds,
          issues: report.issues.slice(0, 5).map((i) => i.code),
        },
        'The deterministic result failed validation',
      );
      throw new AiTaskError(
        'internal_validation_failure',
        `The deterministic result failed validation (${report.kinds.join(', ')}).`,
      );
    }
    const resultSource: ResultSource = cause ? 'deterministic_fallback' : 'deterministic';
    // The record describes what was actually sent to the model when a model attempt preceded the fallback.
    const sent = attempted ?? prepared;
    const record = this.record(run, sent, {
      provider: cause ? this.provider.kind : 'deterministic',
      model: cause ? cause.model : DETERMINISTIC_MODEL,
      status: cause ? cause.status : 'succeeded',
      calls: cause
        ? cause.calls
        : [
            {
              attempts: response.attempts,
              retries: 0,
              latencyMs: response.latencyMs,
              usage: response.usage,
            },
          ],
      repairAttempts: cause?.repairAttempts ?? 0,
      validation: cause?.validation ?? report.outcome,
      error: cause?.error ?? null,
      resultSource,
      fallbackReason: cause ? `${cause.code}: ${cause.detail}` : null,
      simulatedResult: true,
      cacheHit: false,
      cacheSavedTokens: 0,
      earlyStopped: cause?.earlyStopped ?? false,
    });
    const notices = cause
      ? [
          `The AI provider result was not used (${cause.code}); the deterministic analysis is shown instead.`,
        ]
      : ['Deterministic (simulated) analysis from the knowledge pack; token counts are estimates.'];
    if (cause?.rejection) notices.push('Validation reasons were recorded for review.');
    return {
      result: report.output,
      modelExecution: record,
      source: resultSource,
      rejection: cause?.rejection ?? null,
      inputFlags: this.flagsOf(prepared),
      notices,
      ...(run.request.retainContent === true
        ? { content: { messages: sent.messages, rawOutput: cause?.rawOutput ?? null } }
        : {}),
    };
  }

  private async finishModelPath(
    run: RunState,
    outcome: ModelPathOutcome,
  ): Promise<AgentRunResult<AgentName>> {
    switch (outcome.kind) {
      case 'fallback':
        this.lastFallback = { atMs: this.clock.nowMs(), reason: outcome.cause.code };
        recordFallbackMetrics(this.metrics, run.agent, outcome.cause);
        return this.produceDeterministic(run, outcome.cause, outcome.prepared);
      case 'cancelled': {
        const record = this.record(run, outcome.prepared, {
          provider: this.provider.kind,
          model: outcome.model,
          status: 'cancelled',
          calls: outcome.calls,
          repairAttempts: outcome.repairs,
          validation: NOT_VALIDATED,
          error: 'cancelled: The task was cancelled by the caller.',
          resultSource: null,
          fallbackReason: null,
          simulatedResult: false,
          cacheHit: false,
          cacheSavedTokens: 0,
          earlyStopped: true,
        });
        this.metrics.increment('ai.model.calls', 1, {
          agent: run.agent,
          provider: this.provider.kind,
          status: 'cancelled',
        });
        throw new AiTaskError('cancelled', 'The task was cancelled.', record);
      }
      case 'cache': {
        const record = this.record(run, outcome.prepared, {
          provider: outcome.meta.provider,
          model: outcome.meta.model || outcome.model,
          status: 'cache_hit',
          calls: [],
          repairAttempts: 0,
          validation: outcome.report.outcome,
          error: null,
          resultSource: 'cache',
          fallbackReason: null,
          simulatedResult: outcome.meta.provider === 'deterministic',
          cacheHit: true,
          cacheSavedTokens: outcome.meta.usage.totalTokens,
          earlyStopped: false,
        });
        return {
          result: outcome.value as AgentOutputs[AgentName],
          modelExecution: record,
          source: 'cache',
          rejection: null,
          inputFlags: this.flagsOf(outcome.prepared),
          notices: ['Served from the tenant-scoped semantic cache.'],
        };
      }
      case 'model': {
        const record = this.record(run, outcome.prepared, {
          provider: this.provider.kind,
          model: outcome.model,
          status: 'succeeded',
          calls: outcome.calls,
          repairAttempts: outcome.repairs,
          validation: outcome.report.outcome,
          error: null,
          resultSource: 'model',
          fallbackReason: null,
          simulatedResult: this.provider.simulated,
          cacheHit: false,
          cacheSavedTokens: 0,
          earlyStopped: false,
        });
        const notices = [
          'AI-proposed analysis, validated against citations, the temporal boundary and safety policy; confidence values are model estimates.',
        ];
        if (outcome.prepared.fit.level > 0) {
          notices.push(
            `Context was compressed (level ${outcome.prepared.fit.level}) to fit the token budget.`,
          );
        }
        return {
          result: outcome.report.output as AgentOutputs[AgentName],
          modelExecution: record,
          source: 'model',
          rejection: null,
          inputFlags: this.flagsOf(outcome.prepared),
          notices,
          ...(run.request.retainContent === true
            ? { content: { messages: outcome.prepared.messages, rawOutput: outcome.rawOutput } }
            : {}),
        };
      }
    }
  }
}
