import { round } from '@caseguard/domain';
import {
  ProviderKindSchema,
  type AgentName,
  type EfficiencyOverview,
  type ModelConfig,
} from '@caseguard/schemas';
import type { TelemetryAggregate } from '../../db';

/** What the case-process block describes, so the notes can say so. */
export type CaseProcessScope =
  { readonly kind: 'case' } | { readonly kind: 'portfolio'; readonly analysedCases: number };

export interface EfficiencyInputs {
  readonly now: string;
  readonly telemetry: TelemetryAggregate;
  /** The settings in force: the tenant's governed `model` section tightened by the operator's limits. */
  readonly model: ModelConfig;
  /** True when the model values come from the deterministic offline provider. */
  readonly simulated: boolean;
  /** Circuit breakers as the AI service reports them; null when it could not report. */
  readonly breakers: EfficiencyOverview['circuitBreakers'] | null;
  readonly caseProcess: EfficiencyOverview['caseProcess'];
  /** How the case-process figures were scoped, for the notes. */
  readonly scope: CaseProcessScope;
  /** A case was asked for but does not exist (or is not visible), so every case is shown instead. */
  readonly requestedCaseMissing: boolean;
}

const tokens = (value: number): number => Math.max(0, Math.round(value));
const rate = (part: number, whole: number): number =>
  whole > 0 ? Math.min(1, Math.max(0, part / whole)) : 0;

/** The per-request input limit the governor enforces for an agent: the stricter of the global and its own. */
export function agentInputLimit(model: ModelConfig, agent: AgentName): number {
  return Math.min(model.maxInputTokens, model.agentBudgets[agent]?.maxInputTokens ?? Infinity);
}

function totalsOf(telemetry: TelemetryAggregate): EfficiencyOverview['totals'] {
  const { totals } = telemetry;
  return {
    executions: totals.executions,
    promptTokens: tokens(totals.promptTokens),
    completionTokens: tokens(totals.completionTokens),
    cachedTokens: tokens(totals.cachedTokens),
    totalTokens: tokens(totals.promptTokens + totals.completionTokens),
    estimatedCostUsd: totals.estimatedCostUsd,
    avgLatencyMs: round(totals.avgLatencyMs, 1),
    cacheHitRate: rate(totals.cacheHits, totals.executions),
    failureRate: rate(totals.failures, totals.executions),
  };
}

function agentsOf(
  telemetry: TelemetryAggregate,
  model: ModelConfig,
): EfficiencyOverview['byAgent'] {
  return telemetry.byAgent.map((row) => ({
    agent: row.agent,
    executions: row.executions,
    promptTokens: tokens(row.promptTokens),
    completionTokens: tokens(row.completionTokens),
    cachedTokens: tokens(row.cachedTokens),
    avgLatencyMs: round(row.avgLatencyMs, 1),
    cacheHitRate: rate(row.cacheHits, row.executions),
    failures: row.failures,
    estimatedSavingsTokens: tokens(row.estimatedSavingsTokens),
    // How much of the per-request input limit a typical request of this agent uses.
    budgetUtilization: rate(
      row.promptTokens / Math.max(1, row.executions),
      agentInputLimit(model, row.agent),
    ),
  }));
}

/** Models with a provider this contract knows; the data tier only stores validated kinds. */
function modelsOf(telemetry: TelemetryAggregate): EfficiencyOverview['byModel'] {
  return telemetry.byModel.flatMap((row) => {
    const provider = ProviderKindSchema.safeParse(row.provider);
    return provider.success
      ? [
          {
            model: row.model,
            provider: provider.data,
            executions: row.executions,
            totalTokens: tokens(row.totalTokens),
            avgLatencyMs: round(row.avgLatencyMs, 1),
          },
        ]
      : [];
  });
}

function savingsOf(telemetry: TelemetryAggregate): EfficiencyOverview['savings'] {
  const { savings } = telemetry;
  const parts = {
    contextCompressionTokens: tokens(savings.contextCompressionTokens),
    // Duplicate removal is part of context compression and is not tracked separately.
    duplicateRemovalTokens: tokens(savings.duplicateRemovalTokens),
    cacheHitTokens: tokens(savings.cacheHitTokens),
    earlyStopTokens: tokens(savings.earlyStopTokens),
  };
  const total =
    parts.contextCompressionTokens +
    parts.duplicateRemovalTokens +
    parts.cacheHitTokens +
    parts.earlyStopTokens;
  return {
    ...parts,
    totalTokens: total,
    estimatedQualityImpact:
      total === 0
        ? 'No context trimming, cache reuse or early stopping has saved tokens yet, so there is no quality impact to assess.'
        : 'Estimated per execution and never measured: trimming shortens event text or reduces the context to evidence summaries (impact none, negligible or possibly minor), and cache reuse or early stopping skip work. Each execution records its own estimate.',
  };
}

function budgetsOf(
  telemetry: TelemetryAggregate,
  model: ModelConfig,
): EfficiencyOverview['budgets'] {
  return {
    perRequestMaxTokens: model.maxInputTokens,
    // The token governor takes per-case and per-day token caps from the operator; none is configured.
    perCaseMaxTokens: null,
    perDayMaxTokens: null,
    consumedToday: tokens(telemetry.tokensToday),
    costLimitUsdPerDay: model.costLimits.perDayUsd,
  };
}

function notesOf(inputs: EfficiencyInputs, overview: Omit<EfficiencyOverview, 'notes'>): string[] {
  const { telemetry, model, simulated, breakers, scope } = inputs;
  const notes: string[] = [];
  if (inputs.requestedCaseMissing) {
    notes.push('The requested case was not found, so the figures cover every case.');
  }
  if (telemetry.totals.executions === 0) {
    notes.push('No model execution has been recorded yet. Analyse a case to see token usage here.');
  }
  if (simulated) {
    notes.push(
      'Token counts and latencies come from the deterministic offline provider (simulated). Token figures are estimates, not Azure OpenAI usage.',
    );
  }
  if (overview.totals.estimatedCostUsd === null) {
    notes.push('Cost is unknown: no unit prices are configured, and prices are never hard-coded.');
  }
  notes.push(
    `Each request may carry up to ${model.maxInputTokens.toLocaleString('en-US')} input tokens (output is capped separately at ${model.maxOutputTokens.toLocaleString('en-US')}). No per-case or per-day token cap is configured.`,
  );
  if (breakers === null) {
    notes.push('The provider state could not be read, so circuit breakers are not shown.');
  } else if (breakers.length === 0 && simulated) {
    notes.push(
      'The deterministic provider makes no remote calls, so no circuit breaker is in use.',
    );
  }
  if (overview.caseProcess.counterfactualTokens === null) {
    notes.push(
      'No real-versus-simulated token comparison is available: it needs a decision fork with a valid simulated path (an actual of 0 means not available).',
    );
  } else {
    notes.push(
      scope.kind === 'case'
        ? 'The case-process figures compare the case’s real path with the best valid simulated path. Both are estimates.'
        : `The case-process figures add up the ${scope.analysedCases} analysed case(s) that have a valid simulated path. Both sides are estimates.`,
    );
  }
  return notes;
}

/**
 * The efficiency overview: telemetry totals, per-agent and per-model usage, estimated savings, the
 * governed budgets (null when not configured), circuit breakers and the case-process comparison.
 * Everything is labelled estimated, and simulated when the deterministic provider produced it.
 */
export function buildEfficiencyOverview(inputs: EfficiencyInputs): EfficiencyOverview {
  const { telemetry, model } = inputs;
  const overview: Omit<EfficiencyOverview, 'notes'> = {
    generatedAt: inputs.now,
    totals: totalsOf(telemetry),
    byAgent: agentsOf(telemetry, model),
    byModel: modelsOf(telemetry),
    savings: savingsOf(telemetry),
    budgets: budgetsOf(telemetry, model),
    circuitBreakers: inputs.breakers ?? [],
    caseProcess: inputs.caseProcess,
    labels: { simulated: inputs.simulated, estimated: true },
  };
  return { ...overview, notes: notesOf(inputs, overview) };
}
