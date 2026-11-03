import { AsyncLocalStorage } from 'node:async_hooks';
import { createTemporalView } from '@caseguard/domain';
import type { AiFinding, ModelExecutionWithUsage, ProviderKind } from '@caseguard/schemas';
import type { TaskBase } from '../agents/tasks';
import { AiTaskError } from '../errors';
import type { AiOrchestrator } from '../orchestrator/orchestrator';
import type { AgentRunResult } from '../orchestrator/types';
import {
  noopLogger,
  noopMetrics,
  systemClock,
  type Clock,
  type Logger,
  type Metrics,
} from '../types';
import { buildConclusions } from './conclusions';
import { deterministicFactsOf, type DeterministicFacts } from './facts';
import { combine, critiquesOfEngine, type ConclusionRef, type EngineNote } from './policy';
import type { KeptCritic, ProposalCode } from './types';

/**
 * The entry of the optional model-assisted review: the reasoner proposes, the grounding rules dispose, the critic gives
 * a second look at what survived, and the hybrid policy says how each survivor stands next to the engine. The layer
 * never changes the case, its scores or its evidence; it returns findings for a person to review, and an honest account
 * of what it did (`assistance`).
 *
 * Hard limits, all enforced here or in the pipeline it uses: at most two model tasks per run (the reasoner, and the
 * critic only when the reasoner kept something), each with at most one repair, so at most four provider calls; a token
 * ceiling for the whole run; the per-request, per-case and per-day budgets, timeout, retry limit, bulkhead and circuit
 * breaker of the orchestrator; no call from inside a call (a nested review is refused).
 */

export interface ReviewDeps {
  orchestrator: AiOrchestrator;
  clock?: Clock;
  logger?: Logger;
  metrics?: Metrics;
  /**
   * The most tokens one review may use, both tasks and their repairs included. Without it: what the two tasks'
   * budgets allow once each (input plus output), taken from the token governor.
   */
  maxRunTokens?: number;
}

/** What the review reads: the temporal view and the engine's analysis (the same as any task), and optionally the facts. */
export interface ReviewInput extends TaskBase {
  /**
   * The engine's facts, as they stood at the boundary of the view. Without them they are derived from `analysis`,
   * restricted to the view, so a review of an early boundary never meets what the engine found later.
   */
  facts?: DeterministicFacts;
}

export type AssistanceMode = 'off' | 'ran' | 'fallback';

export const ASSISTANCE_REASON_CODES = [
  'ran',
  'ran_without_second_look',
  'deterministic_provider',
  'no_model_configured',
  'no_events',
  'reentrant_call',
  'cancelled',
  'budget_exceeded',
  'timeout',
  'circuit_open',
  'provider_error',
  'content_filtered',
  'rejected_by_validation',
  'input_too_large',
  'internal_error',
] as const;
export type AssistanceReasonCode = (typeof ASSISTANCE_REASON_CODES)[number];

/** Every number is measured from the executions that ran, or null; none is invented. */
export interface Assistance {
  /** `off`: no model was asked. `ran`: a model's reply was used. `fallback`: it was not (the reason says why). */
  mode: AssistanceMode;
  reasonCode: AssistanceReasonCode;
  /** One sentence for a person, in our own words. */
  reason: string;
  provider: ProviderKind;
  /** The deployment the reasoner was routed to; the provider's default when nothing was called. */
  model: string | null;
  /** True for the deterministic and the scripted provider: nothing says anything about a real model. */
  simulated: boolean;
  counts: {
    /** Proposals (and critiques) the replies held. */
    proposed: number;
    kept: number;
    /** Per grounding-rule code, how many proposals failed it (a proposal may fail several). */
    rejectedByCode: Partial<Record<ProposalCode, number>>;
    /** Critiques that were kept: attached to a finding or to an engine conclusion. */
    criticNotes: number;
  };
  /** Replies that failed as a whole (a repair was needed, or the last reply was rejected) plus proposals dropped for their shape or size. */
  schemaFailures: number;
  /** Tasks whose model reply was not used and deterministic code answered. */
  fallbackCount: number;
  /** Proposals dropped as instruction-like, secret-like, policy-violating or naming a server-only field, plus content-filter blocks. */
  safetyBlocks: number;
  /** Provider calls made, repairs included. At most four. */
  modelCalls: number;
  /** HTTP requests sent, transport retries included. */
  requests: number;
  tokens: {
    prompt: number;
    completion: number;
    total: number;
    /** Whether the provider reported the counts or they were estimated; null when nothing was called. */
    source: 'measured' | 'estimated' | 'mixed' | null;
  };
  /** Null when no unit prices are configured (cost is never guessed), or when nothing was called. */
  estimatedCostUsd: number | null;
  /** Wall-clock time of the whole review. */
  latencyMs: number;
  cancelled: boolean;
  /** Tasks answered from the tenant-scoped cache (no provider call). */
  cacheHits: number;
}

export interface ReviewResult {
  /** Findings for a person to review. Empty whenever the review did not complete. */
  findings: AiFinding[];
  /** The second look at the engine's own conclusions. They change nothing about the engine's items. */
  engineNotes: EngineNote[];
  assistance: Assistance;
  /** One row per model task that ran (cancelled and failed ones included), ready to persist. */
  executions: ModelExecutionWithUsage[];
}

const SCHEMA_CODES: readonly ProposalCode[] = ['schema', 'prohibited_field', 'excessive_output'];
const SAFETY_CODES: readonly ProposalCode[] = [
  'instruction_like_text',
  'secret_like_text',
  'policy_violation',
  'prohibited_field',
];

const REASONS: Record<AssistanceReasonCode, string> = {
  ran: 'A model reviewed the case; every proposal was checked against the record and the survivors are listed for a person to review.',
  ran_without_second_look:
    'A model reviewed the case and its proposals were checked against the record, but the second look was not available.',
  deterministic_provider:
    'Model assistance is off: the deterministic provider is configured, so no model reviewed this case.',
  no_model_configured: 'Model assistance is off: no model deployment is configured.',
  no_events: 'There was nothing to review: the case has no events in this view.',
  reentrant_call:
    'A review was already running in this call chain; a review never starts another one.',
  cancelled: 'The review was cancelled; no findings are shown.',
  budget_exceeded:
    'Model assistance was not used: a token or cost budget was reached before the call.',
  timeout: 'Model assistance was not used: the model did not answer in time.',
  circuit_open:
    'Model assistance was not used: the model provider is not accepting calls right now.',
  provider_error: 'Model assistance was not used: the model provider failed.',
  content_filtered: 'Model assistance was not used: the provider blocked the request.',
  rejected_by_validation:
    'Model assistance was not used: the reply did not match the required format, even after one repair.',
  input_too_large:
    'Model assistance was not used: the case is too long to be reviewed with its text quoted in full.',
  internal_error: 'Model assistance was not used: the review failed unexpectedly.',
};

/** What stopped a model task, from its execution record. */
function reasonOfFallback(record: ModelExecutionWithUsage): AssistanceReasonCode {
  const reason = record.fallbackReason ?? '';
  if (reason.startsWith('input_too_large')) return 'input_too_large';
  if (reason.startsWith('content_filtered')) return 'content_filtered';
  switch (record.status) {
    case 'budget_exceeded':
      return 'budget_exceeded';
    case 'timed_out':
      return 'timeout';
    case 'circuit_open':
      return 'circuit_open';
    case 'rejected_by_validation':
      return 'rejected_by_validation';
    default:
      return 'provider_error';
  }
}

const active = new AsyncLocalStorage<{ depth: number }>();

interface Ledger {
  results: AgentRunResult<'case_reasoner' | 'case_critic'>[];
  executions: ModelExecutionWithUsage[];
  /** Tokens used so far (what the next call's ceiling check sees). */
  tokens: number;
  internalFailures: number;
}

function assist(
  deps: ReviewDeps,
  mode: AssistanceMode,
  reasonCode: AssistanceReasonCode,
  ledger: Ledger,
  startedMs: number,
  extra: { criticNotes: number } = { criticNotes: 0 },
): Assistance {
  const provider = deps.orchestrator.primaryProvider;
  const descriptor = provider.describe();
  const clock = deps.clock ?? systemClock;
  let proposed = 0;
  let kept = 0;
  let schemaFailures = 0;
  let safetyBlocks = 0;
  let fallbackCount = ledger.internalFailures;
  let modelCalls = 0;
  let cacheHits = 0;
  const rejectedByCode: Partial<Record<ProposalCode, number>> = {};
  for (const result of ledger.results) {
    modelCalls += result.providerCalls;
    if (result.source === 'deterministic_fallback') fallbackCount++;
    if (result.source === 'cache') cacheHits++;
    schemaFailures += (result.modelExecution.repairAttempts ?? 0) + (result.rejection ? 1 : 0);
    if (result.modelExecution.fallbackReason?.startsWith('content_filtered')) safetyBlocks++;
    const report = result.proposals;
    if (!report) continue;
    proposed += report.proposed;
    kept += report.kept;
    for (const [code, count] of Object.entries(report.rejectedByCode) as [ProposalCode, number][]) {
      rejectedByCode[code] = (rejectedByCode[code] ?? 0) + count;
      if (SCHEMA_CODES.includes(code)) schemaFailures += count;
      if (SAFETY_CODES.includes(code)) safetyBlocks += count;
    }
  }
  const usages = ledger.executions.flatMap((e) => (e.usage ? [e.usage] : []));
  const sources = new Set(usages.map((u) => u.tokenSource ?? 'estimated'));
  const costs = usages.map((u) => u.estimatedCostUsd);
  const model =
    ledger.executions.find((e) => e.agent === 'case_reasoner')?.model ?? descriptor.model;
  return {
    mode,
    reasonCode,
    reason: REASONS[reasonCode],
    provider: descriptor.kind,
    model,
    simulated: descriptor.simulated,
    counts: { proposed, kept, rejectedByCode, criticNotes: extra.criticNotes },
    schemaFailures,
    fallbackCount,
    safetyBlocks,
    modelCalls,
    requests: ledger.executions.reduce((n, e) => n + e.attempts, 0),
    tokens: {
      prompt: usages.reduce((n, u) => n + u.promptTokens, 0),
      completion: usages.reduce((n, u) => n + u.completionTokens, 0),
      total: usages.reduce((n, u) => n + u.totalTokens, 0),
      source:
        sources.size === 0
          ? null
          : sources.size > 1
            ? 'mixed'
            : sources.has('measured')
              ? 'measured'
              : 'estimated',
    },
    estimatedCostUsd:
      costs.length > 0 && costs.every((c): c is number => c !== null)
        ? costs.reduce((n, c) => n + c, 0)
        : null,
    latencyMs: Math.max(0, Math.round(clock.nowMs() - startedMs)),
    cancelled: reasonCode === 'cancelled',
    cacheHits,
  };
}

function ceilingOf(deps: ReviewDeps): number {
  if (deps.maxRunTokens !== undefined) return deps.maxRunTokens;
  const governor = deps.orchestrator.governor;
  return (['case_reasoner', 'case_critic'] as const).reduce((sum, agent) => {
    const limits = governor.limitsFor(agent);
    return sum + limits.maxInputTokens + limits.maxOutputTokens;
  }, 0);
}

/** The task input without the review's own extras, with the resolution removed: both agents are pre-resolution. */
function taskBase(input: ReviewInput): TaskBase {
  const { facts: _facts, ...base } = input;
  const view =
    base.view.resolution === null
      ? base.view
      : createTemporalView(base.view.events, base.view.asOf, { mode: base.view.mode });
  return { ...base, view };
}

async function review(
  deps: ReviewDeps,
  input: ReviewInput,
  signal: AbortSignal | undefined,
): Promise<ReviewResult> {
  const clock = deps.clock ?? systemClock;
  const logger = deps.logger ?? noopLogger;
  const metrics = deps.metrics ?? noopMetrics;
  const startedMs = clock.nowMs();
  const { orchestrator } = deps;
  const ledger: Ledger = { results: [], executions: [], tokens: 0, internalFailures: 0 };

  const finish = (
    mode: AssistanceMode,
    reasonCode: AssistanceReasonCode,
    findings: AiFinding[] = [],
    engineNotes: EngineNote[] = [],
    criticNotes = 0,
  ): ReviewResult => {
    const assistance = assist(deps, mode, reasonCode, ledger, startedMs, { criticNotes });
    metrics.increment('ai.review.runs', 1, { mode, reason: reasonCode });
    metrics.observe('ai.review.latency_ms', assistance.latencyMs, { mode });
    logger.info(
      {
        event: 'ai.review.finished',
        mode,
        reason: reasonCode,
        proposed: assistance.counts.proposed,
        kept: assistance.counts.kept,
        findings: findings.length,
        criticNotes,
        modelCalls: assistance.modelCalls,
        requests: assistance.requests,
        totalTokens: assistance.tokens.total,
        latencyMs: assistance.latencyMs,
        tenantId: input.tenantId,
        caseId: input.caseId,
        analysisRunId: input.analysisRunId,
      },
      'Model-assisted review finished',
    );
    return { findings, engineNotes, assistance, executions: ledger.executions };
  };

  const book = (result: AgentRunResult<'case_reasoner' | 'case_critic'>): void => {
    ledger.results.push(result);
    ledger.executions.push(result.modelExecution);
    ledger.tokens += result.modelExecution.usage?.totalTokens ?? 0;
  };
  const bookFailed = (error: unknown): void => {
    if (error instanceof AiTaskError && error.execution) {
      ledger.executions.push(error.execution);
      ledger.tokens += error.execution.usage?.totalTokens ?? 0;
    }
  };
  const isCancelled = (error: unknown): boolean =>
    error instanceof AiTaskError && error.code === 'cancelled';

  if (signal?.aborted) return finish('fallback', 'cancelled');
  const provider = orchestrator.primaryProvider;
  if (provider.kind === 'deterministic') return finish('off', 'deterministic_provider');
  if (orchestrator.governor.route('case_reasoner', provider.kind).tier === 'deterministic') {
    return finish('off', 'no_model_configured');
  }
  if (input.view.events.length === 0) return finish('off', 'no_events');

  const base = taskBase(input);
  const facts = input.facts ?? deterministicFactsOf(input.analysis, {}, { view: base.view });
  const ceiling = ceilingOf(deps);

  // 1. The reasoner proposes.
  let reasoner: AgentRunResult<'case_reasoner'>;
  try {
    reasoner = await orchestrator.runAgentTask({
      task: { agent: 'case_reasoner', input: base },
      ...(signal ? { signal } : {}),
      runTokenBudget: { ceiling, used: ledger.tokens },
      maxRepairAttempts: 1,
    });
  } catch (error) {
    bookFailed(error);
    if (isCancelled(error)) return finish('fallback', 'cancelled');
    if (error instanceof AiTaskError && error.code === 'invalid_input')
      return finish('off', 'no_events');
    logger.error(
      {
        event: 'ai.review.internal_error',
        agent: 'case_reasoner',
        error: error instanceof Error ? error.name : 'unknown',
      },
      'The reasoner task failed unexpectedly',
    );
    ledger.internalFailures++;
    return finish('fallback', 'internal_error');
  }
  book(reasoner);
  if (reasoner.source === 'deterministic') return finish('off', 'no_model_configured');
  if (reasoner.source === 'deterministic_fallback' || reasoner.proposals === null) {
    return finish('fallback', reasonOfFallback(reasoner.modelExecution));
  }
  if (signal?.aborted) return finish('fallback', 'cancelled');

  // 2. The critic gives a second look, but only at something that survived.
  const kept = reasoner.proposals.reasoner ?? [];
  let critic: KeptCritic | null = null;
  let conclusions: ConclusionRef[] = [];
  let criticUnavailable = false;
  if (kept.length > 0) {
    const under = buildConclusions(facts, kept);
    conclusions = under.map((c) => ({ id: c.id, source: c.source, ref: c.ref }));
    try {
      const second = await orchestrator.runAgentTask({
        task: { agent: 'case_critic', input: { ...base, conclusions: under } },
        ...(signal ? { signal } : {}),
        runTokenBudget: { ceiling, used: ledger.tokens },
        maxRepairAttempts: 1,
      });
      book(second);
      if (second.source === 'deterministic_fallback' || second.proposals === null) {
        criticUnavailable = true;
      } else {
        critic = second.proposals.critic;
      }
    } catch (error) {
      bookFailed(error);
      if (isCancelled(error)) return finish('fallback', 'cancelled');
      logger.error(
        {
          event: 'ai.review.internal_error',
          agent: 'case_critic',
          error: error instanceof Error ? error.name : 'unknown',
        },
        'The critic task failed unexpectedly',
      );
      ledger.internalFailures++;
      criticUnavailable = true;
    }
  }
  if (signal?.aborted) return finish('fallback', 'cancelled');

  // 3. The policy says how each survivor stands next to the engine.
  const record = reasoner.modelExecution;
  const criticInput = critic ? { critic, conclusions } : null;
  const findings = combine({
    proposals: kept,
    critic: criticInput,
    facts,
    provenance: {
      agent: 'case_reasoner',
      promptVersion: record.promptVersion,
      provider: record.provider,
      model: record.model,
      simulated: record.simulated,
      executionId: record.id,
    },
  });
  const engineNotes = critiquesOfEngine(criticInput);
  const criticNotes = critic?.critiques.length ?? 0;
  return finish(
    'ran',
    criticUnavailable ? 'ran_without_second_look' : 'ran',
    findings,
    engineNotes,
    criticNotes,
  );
}

/**
 * Runs the model-assisted review of one case view: reasoner, validation, critic (only if there is something to
 * criticise), policy. An aborted signal stops the run and returns no findings. A deterministic provider gives mode
 * `off`. A failed call, a rejected reply or an exhausted budget gives no findings and an honest reason, never an error
 * and never invented content. Called from inside a review (for example by a provider), it refuses and returns `off`.
 */
export async function runModelAssistedReview(
  deps: ReviewDeps,
  input: ReviewInput,
  signal?: AbortSignal,
): Promise<ReviewResult> {
  if (active.getStore() !== undefined) {
    const startedMs = (deps.clock ?? systemClock).nowMs();
    const ledger: Ledger = { results: [], executions: [], tokens: 0, internalFailures: 0 };
    return {
      findings: [],
      engineNotes: [],
      assistance: assist(deps, 'off', 'reentrant_call', ledger, startedMs),
      executions: [],
    };
  }
  return active.run({ depth: 1 }, () => review(deps, input, signal));
}
