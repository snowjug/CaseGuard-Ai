import type { AgentBudget, AgentName, ModelConfig, ProviderKind } from '@caseguard/schemas';
import { AGENT_CATALOG } from '../agents/catalog';
import type { RouteTier } from '../agents/outputs';
import { noopLogger, noopMetrics, type Clock, type Logger, type Metrics } from '../types';

/** Label for results produced by code rather than a model (matches the default routing config). */
export const DETERMINISTIC_MODEL = 'deterministic-knowledge-pack';

export interface GovernorLimits {
  /** Null means unlimited. Not part of ModelConfig; supplied by the operator. */
  perCaseMaxTokens: number | null;
  perDayMaxTokens: number | null;
}

export interface RouteDecision {
  tier: RouteTier;
  model: string;
  reason: string;
}

export type BudgetRefusalCode =
  'request_tokens' | 'day_tokens' | 'case_tokens' | 'run_tokens' | 'cost_limit' | 'cost_unknown';

export type BudgetVerdict =
  { allowed: true } | { allowed: false; code: BudgetRefusalCode; reason: string };

export interface UsageSample {
  tenantId: string;
  caseId: string | null;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

export interface UsageTotals {
  tokens: number;
  /** Sum of known costs; null while no unit prices are configured. */
  costUsd: number | null;
}

interface Ledger {
  tokens: number;
  costUsd: number;
  costKnown: boolean;
}

export interface BudgetRequest {
  tenantId: string;
  caseId: string | null;
  agent: AgentName;
  estimatedInputTokens: number;
  maxOutputTokens: number;
  /** The ceiling of the larger unit of work this call belongs to, and what it has already used (see `AgentRunRequest`). */
  run?: { ceiling: number; used: number };
}

export interface GovernorOptions {
  config: ModelConfig;
  clock: Clock;
  limits?: Partial<GovernorLimits>;
  logger?: Logger;
  metrics?: Metrics;
}

const dayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');

/**
 * Token governor (spec 5.14 and 10): per-agent limits, model routing by task difficulty, per-day
 * and per-case budgets with explicit refusal reasons, and cost estimation from operator-supplied
 * unit prices only. In-memory: totals reset on restart and are per process.
 */
export class TokenGovernor {
  private config: ModelConfig;
  private readonly clock: Clock;
  private readonly limits: GovernorLimits;
  private readonly logger: Logger;
  private readonly metrics: Metrics;
  private readonly daily = new Map<string, Ledger>();
  private readonly perCase = new Map<string, Ledger>();
  private warnedUnenforceableCost = false;

  constructor(options: GovernorOptions) {
    this.config = options.config;
    this.clock = options.clock;
    this.limits = {
      perCaseMaxTokens: options.limits?.perCaseMaxTokens ?? null,
      perDayMaxTokens: options.limits?.perDayMaxTokens ?? null,
    };
    this.logger = options.logger ?? noopLogger;
    this.metrics = options.metrics ?? noopMetrics;
  }

  /** Applies a new governed configuration (budgets, prices, routing) without losing usage totals. */
  updateConfig(config: ModelConfig): void {
    this.config = config;
  }

  get modelConfig(): ModelConfig {
    return this.config;
  }

  get budgetLimits(): Readonly<GovernorLimits> {
    return this.limits;
  }

  /** Effective per-request limits: the stricter of the global and the agent-specific budget. */
  limitsFor(agent: AgentName): AgentBudget {
    const global = this.config;
    const own = global.agentBudgets[agent];
    return {
      maxInputTokens: Math.min(global.maxInputTokens, own?.maxInputTokens ?? global.maxInputTokens),
      maxOutputTokens: Math.min(
        global.maxOutputTokens,
        own?.maxOutputTokens ?? global.maxOutputTokens,
      ),
      maxRetries: Math.min(global.maxRetries, own?.maxRetries ?? global.maxRetries),
      timeoutMs: Math.min(global.timeoutMs, own?.timeoutMs ?? global.timeoutMs),
    };
  }

  /** Chooses deterministic code, the cheap model or the stronger model by task difficulty. */
  route(agent: AgentName, providerKind: ProviderKind): RouteDecision {
    const meta = AGENT_CATALOG[agent];
    if (meta.execution === 'deterministic_only') {
      return {
        tier: 'deterministic',
        model: DETERMINISTIC_MODEL,
        reason: 'Pure code: this agent never calls a model.',
      };
    }
    if (providerKind === 'deterministic') {
      return {
        tier: 'deterministic',
        model: DETERMINISTIC_MODEL,
        reason: 'The deterministic provider is configured.',
      };
    }
    const { routing, azureDeployment } = this.config;
    const rule = routing.rules.find((r) => r.agent === agent);
    if (rule)
      return { tier: 'rule', model: rule.model, reason: `Explicit routing rule for ${agent}.` };
    if (meta.difficulty === 'classification' && routing.cheapModel) {
      return {
        tier: 'cheap',
        model: routing.cheapModel,
        reason: 'Classification-style task routed to the cheaper model.',
      };
    }
    const configured = routing.defaultModel;
    const model =
      configured === '' || configured === DETERMINISTIC_MODEL ? azureDeployment : configured;
    if (model === '') {
      return {
        tier: 'deterministic',
        model: DETERMINISTIC_MODEL,
        reason: 'No model deployment is configured.',
      };
    }
    return {
      tier: 'strong',
      model,
      reason: 'Reasoning or generation task routed to the default model.',
    };
  }

  /** Cost estimate from operator-supplied unit prices; null when prices are not configured (A-16). */
  estimateCostUsd(promptTokens: number, completionTokens: number, cachedTokens = 0): number | null {
    const { inputPer1kUsd, outputPer1kUsd, cachedInputPer1kUsd } = this.config.unitPrices;
    if (inputPer1kUsd === null || outputPer1kUsd === null) return null;
    const cached = Math.min(cachedTokens, promptTokens);
    const cachedRate = cachedInputPer1kUsd ?? inputPer1kUsd;
    return (
      ((promptTokens - cached) / 1000) * inputPer1kUsd +
      (cached / 1000) * cachedRate +
      (completionTokens / 1000) * outputPer1kUsd
    );
  }

  private ledgerFor(map: Map<string, Ledger>, key: string): Ledger {
    const existing = map.get(key);
    if (existing) return existing;
    const created: Ledger = { tokens: 0, costUsd: 0, costKnown: true };
    map.set(key, created);
    return created;
  }

  private dailyKey(tenantId: string): string {
    return `${tenantId}|${dayKey(this.clock.nowMs())}`;
  }

  /** Decides whether a call may proceed; the reason is safe to show to a user. */
  checkBudget(request: BudgetRequest): BudgetVerdict {
    const limits = this.limitsFor(request.agent);
    const worstTokens = request.estimatedInputTokens + request.maxOutputTokens;
    const refuse = (code: BudgetRefusalCode, reason: string): BudgetVerdict => {
      this.metrics.increment('ai.budget.refused', 1, { agent: request.agent, code });
      this.logger.info({ event: 'ai.budget.refused', agent: request.agent, code }, reason);
      return { allowed: false, code, reason };
    };

    if (request.estimatedInputTokens > limits.maxInputTokens) {
      return refuse(
        'request_tokens',
        `The input needs about ${fmt(request.estimatedInputTokens)} tokens but the per-request limit is ${fmt(limits.maxInputTokens)}.`,
      );
    }
    const day = this.daily.get(this.dailyKey(request.tenantId));
    if (request.run && request.run.used + worstTokens > request.run.ceiling) {
      return refuse(
        'run_tokens',
        `The token ceiling of this review is reached: ${fmt(request.run.used)} of ${fmt(request.run.ceiling)} tokens used; this request needs about ${fmt(worstTokens)}.`,
      );
    }
    if (
      this.limits.perDayMaxTokens !== null &&
      (day?.tokens ?? 0) + worstTokens > this.limits.perDayMaxTokens
    ) {
      return refuse(
        'day_tokens',
        `The daily token budget is exhausted: ${fmt(day?.tokens ?? 0)} of ${fmt(this.limits.perDayMaxTokens)} tokens used today; this request needs about ${fmt(worstTokens)}.`,
      );
    }
    const caseLedger = request.caseId
      ? this.perCase.get(`${request.tenantId}|${request.caseId}`)
      : undefined;
    if (
      this.limits.perCaseMaxTokens !== null &&
      (caseLedger?.tokens ?? 0) + worstTokens > this.limits.perCaseMaxTokens
    ) {
      return refuse(
        'case_tokens',
        `The per-case token budget is exhausted: ${fmt(caseLedger?.tokens ?? 0)} of ${fmt(this.limits.perCaseMaxTokens)} tokens used for this case.`,
      );
    }

    const { perRequestUsd, perCaseUsd, perDayUsd } = this.config.costLimits;
    if (perRequestUsd !== null || perCaseUsd !== null || perDayUsd !== null) {
      const worstCost = this.estimateCostUsd(request.estimatedInputTokens, request.maxOutputTokens);
      if (worstCost === null) {
        if (!this.warnedUnenforceableCost) {
          this.warnedUnenforceableCost = true;
          this.logger.warn(
            { event: 'ai.budget.cost_unenforceable' },
            'A cost limit is configured but unit prices are not; model calls are refused (fail closed).',
          );
        }
        return refuse(
          'cost_unknown',
          'A cost limit is configured but unit prices are not, so cost cannot be estimated; the model call was refused.',
        );
      }
      if (perRequestUsd !== null && worstCost > perRequestUsd) {
        return refuse(
          'cost_limit',
          'The worst-case cost of this request exceeds the per-request cost limit.',
        );
      }
      if (perDayUsd !== null && (day?.costUsd ?? 0) + worstCost > perDayUsd) {
        return refuse('cost_limit', 'The daily cost limit would be exceeded by this request.');
      }
      if (perCaseUsd !== null && (caseLedger?.costUsd ?? 0) + worstCost > perCaseUsd) {
        return refuse('cost_limit', 'The per-case cost limit would be exceeded by this request.');
      }
    }
    return { allowed: true };
  }

  /** Records tokens actually consumed by a model call (measured or estimated). */
  record(sample: UsageSample): number | null {
    const tokens = sample.promptTokens + sample.completionTokens;
    const cost = this.estimateCostUsd(
      sample.promptTokens,
      sample.completionTokens,
      sample.cachedTokens,
    );
    const today = dayKey(this.clock.nowMs());
    for (const key of this.daily.keys()) if (!key.endsWith(`|${today}`)) this.daily.delete(key);
    const targets = [this.ledgerFor(this.daily, this.dailyKey(sample.tenantId))];
    if (sample.caseId)
      targets.push(this.ledgerFor(this.perCase, `${sample.tenantId}|${sample.caseId}`));
    for (const ledger of targets) {
      ledger.tokens += tokens;
      if (cost === null) ledger.costKnown = false;
      else ledger.costUsd += cost;
    }
    return cost;
  }

  /** Re-seeds today's totals after a restart from persisted execution records. */
  restoreDailyUsage(tenantId: string, tokens: number, costUsd: number | null): void {
    const ledger = this.ledgerFor(this.daily, this.dailyKey(tenantId));
    ledger.tokens = tokens;
    ledger.costUsd = costUsd ?? 0;
    ledger.costKnown = costUsd !== null;
  }

  consumedToday(tenantId: string): UsageTotals {
    const ledger = this.daily.get(this.dailyKey(tenantId));
    return {
      tokens: ledger?.tokens ?? 0,
      costUsd:
        ledger && ledger.costKnown && this.config.unitPrices.inputPer1kUsd !== null
          ? ledger.costUsd
          : null,
    };
  }

  consumedForCase(tenantId: string, caseId: string): UsageTotals {
    const ledger = this.perCase.get(`${tenantId}|${caseId}`);
    return {
      tokens: ledger?.tokens ?? 0,
      costUsd:
        ledger && ledger.costKnown && this.config.unitPrices.inputPer1kUsd !== null
          ? ledger.costUsd
          : null,
    };
  }
}
