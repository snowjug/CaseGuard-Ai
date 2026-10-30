import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL_CONFIG,
  EfficiencyOverviewSchema,
  type ModelConfig,
} from '@caseguard/schemas';
import {
  agentInputLimit,
  buildEfficiencyOverview,
  caseProcessOf,
  tokenProcessOf,
  type EfficiencyInputs,
} from '../src/services/efficiency';
import { effectiveModelConfig } from '../src/services/ai';
import { loadConfig } from '@caseguard/config';
import { NOW, aseEstimateWithTokens, estimateOf, telemetry } from './insights-fixtures';

const NO_CASE_PROCESS = {
  actualTokens: 0,
  counterfactualTokens: null,
  estimatedSavingsPct: null,
  caseId: null,
};

function inputs(overrides: Partial<EfficiencyInputs> = {}): EfficiencyInputs {
  return {
    now: NOW,
    telemetry: telemetry(),
    model: DEFAULT_MODEL_CONFIG,
    simulated: true,
    breakers: [],
    caseProcess: NO_CASE_PROCESS,
    scope: { kind: 'portfolio', analysedCases: 0 },
    requestedCaseMissing: false,
    ...overrides,
  };
}

const USED = telemetry({
  totals: {
    executions: 10,
    promptTokens: 40_000,
    completionTokens: 8_000,
    cachedTokens: 5_000,
    failures: 1,
    cacheHits: 3,
    avgLatencyMs: 12.34,
    estimatedCostUsd: null,
  },
  byAgent: [
    {
      agent: 'timeline_analyzer',
      executions: 4,
      promptTokens: 24_000,
      completionTokens: 2_000,
      cachedTokens: 0,
      avgLatencyMs: 9,
      cacheHits: 1,
      failures: 0,
      estimatedSavingsTokens: 1_500,
    },
    {
      agent: 'quality_judge',
      executions: 6,
      promptTokens: 16_000,
      completionTokens: 6_000,
      cachedTokens: 5_000,
      avgLatencyMs: 14,
      cacheHits: 2,
      failures: 1,
      estimatedSavingsTokens: 500,
    },
  ],
  byModel: [
    {
      model: 'deterministic-knowledge-pack',
      provider: 'deterministic',
      executions: 10,
      totalTokens: 48_000,
      avgLatencyMs: 12.3,
    },
    {
      model: 'mystery',
      provider: 'some-other-provider',
      executions: 1,
      totalTokens: 10,
      avgLatencyMs: 1,
    },
  ],
  savings: {
    contextCompressionTokens: 3_000,
    duplicateRemovalTokens: 0,
    cacheHitTokens: 2_000,
    earlyStopTokens: 500,
  },
  tokensToday: 48_000,
});

describe('[FR-EFF-01] the efficiency overview', () => {
  it('is valid, zero and honest for an empty tenant: no executions, null budgets, no breakers, a note saying so', () => {
    const overview = buildEfficiencyOverview(inputs());
    expect(EfficiencyOverviewSchema.safeParse(overview).success).toBe(true);
    expect(overview.totals).toMatchObject({
      executions: 0,
      totalTokens: 0,
      estimatedCostUsd: null,
      cacheHitRate: 0,
      failureRate: 0,
    });
    expect(overview.byAgent).toEqual([]);
    expect(overview.byModel).toEqual([]);
    expect(overview.savings).toMatchObject({ totalTokens: 0 });
    expect(overview.budgets).toMatchObject({
      perCaseMaxTokens: null,
      perDayMaxTokens: null,
      consumedToday: 0,
      costLimitUsdPerDay: null,
    });
    expect(overview.circuitBreakers).toEqual([]);
    expect(overview.labels).toEqual({ simulated: true, estimated: true });
    expect(overview.notes.join('\n')).toMatch(/no model execution has been recorded/i);
  });

  it('reports the totals, rates, per-agent budget use and per-model usage exactly as recorded', () => {
    const overview = buildEfficiencyOverview(inputs({ telemetry: USED }));
    expect(EfficiencyOverviewSchema.safeParse(overview).success).toBe(true);
    expect(overview.totals).toEqual({
      executions: 10,
      promptTokens: 40_000,
      completionTokens: 8_000,
      cachedTokens: 5_000,
      totalTokens: 48_000,
      estimatedCostUsd: null,
      avgLatencyMs: 12.3,
      cacheHitRate: 0.3,
      failureRate: 0.1,
    });
    const [timeline, judge] = overview.byAgent;
    expect(timeline).toMatchObject({
      agent: 'timeline_analyzer',
      executions: 4,
      cacheHitRate: 0.25,
      estimatedSavingsTokens: 1_500,
    });
    // 24,000 prompt tokens over 4 runs = 6,000 per run against the agent's 8,000-token input limit.
    expect(timeline?.budgetUtilization).toBeCloseTo(0.75, 10);
    expect(judge).toMatchObject({ agent: 'quality_judge', failures: 1 });
    expect(judge?.budgetUtilization).toBeCloseTo(2_666.6667 / 12_000, 3);
    // A provider this contract does not know is left out rather than guessed at.
    expect(overview.byModel).toEqual([
      {
        model: 'deterministic-knowledge-pack',
        provider: 'deterministic',
        executions: 10,
        totalTokens: 48_000,
        avgLatencyMs: 12.3,
      },
    ]);
  });

  it('adds up the estimated savings and describes their quality impact as estimated, never measured', () => {
    const { savings } = buildEfficiencyOverview(inputs({ telemetry: USED }));
    expect(savings).toMatchObject({
      contextCompressionTokens: 3_000,
      duplicateRemovalTokens: 0,
      cacheHitTokens: 2_000,
      earlyStopTokens: 500,
      totalTokens: 5_500,
    });
    expect(savings.estimatedQualityImpact).toMatch(/estimated .*never measured/i);
    expect(buildEfficiencyOverview(inputs()).savings.estimatedQualityImpact).toMatch(
      /no quality impact to assess/i,
    );
  });

  it('clamps budget use at 100% and never divides by zero executions', () => {
    const heavy = telemetry({
      totals: { ...USED.totals, executions: 1 },
      byAgent: [
        {
          agent: 'timeline_analyzer',
          executions: 1,
          promptTokens: 500_000,
          completionTokens: 0,
          cachedTokens: 0,
          avgLatencyMs: 1,
          cacheHits: 0,
          failures: 0,
          estimatedSavingsTokens: 0,
        },
      ],
    });
    expect(
      buildEfficiencyOverview(inputs({ telemetry: heavy })).byAgent[0]?.budgetUtilization,
    ).toBe(1);
  });

  it('reports unset budgets as null and set ones as configured, from the settings in force', () => {
    const governed: ModelConfig = {
      ...DEFAULT_MODEL_CONFIG,
      maxInputTokens: 9_000,
      costLimits: { perRequestUsd: null, perCaseUsd: null, perDayUsd: 2.5 },
    };
    const { budgets } = buildEfficiencyOverview(
      inputs({ model: governed, telemetry: telemetry({ tokensToday: 1_234 }) }),
    );
    expect(budgets).toEqual({
      perRequestMaxTokens: 9_000,
      perCaseMaxTokens: null,
      perDayMaxTokens: null,
      consumedToday: 1_234,
      costLimitUsdPerDay: 2.5,
    });
  });

  it('lets the operator tighten what a tenant configured, and takes the stricter agent limit', () => {
    const config = loadConfig({
      APP_ENV: 'test',
      DATABASE_URL: 'pglite://memory',
      AI_MAX_INPUT_TOKENS: '10000',
      AI_COST_LIMIT_USD_PER_DAY: '5',
      AI_UNIT_PRICE_INPUT_PER_1K: '0.001',
      AI_UNIT_PRICE_OUTPUT_PER_1K: '0.002',
    });
    const effective = effectiveModelConfig(DEFAULT_MODEL_CONFIG, config);
    expect(effective.maxInputTokens).toBe(10_000);
    expect(effective.costLimits.perDayUsd).toBe(5);
    expect(agentInputLimit(effective, 'timeline_analyzer')).toBe(8_000);
    expect(agentInputLimit(effective, 'evidence_classifier')).toBe(10_000);
    expect(agentInputLimit({ ...effective, agentBudgets: {} }, 'quality_judge')).toBe(10_000);
  });

  it('passes the circuit breakers through as reported, and never invents one', () => {
    const open = {
      name: 'azure-openai',
      state: 'open' as const,
      consecutiveFailures: 5,
      openedAt: '2026-03-15T08:59:00.000Z',
    };
    expect(
      buildEfficiencyOverview(inputs({ simulated: false, breakers: [open] })).circuitBreakers,
    ).toEqual([open]);

    const none = buildEfficiencyOverview(inputs());
    expect(none.circuitBreakers).toEqual([]);
    expect(none.notes.join('\n')).toMatch(/makes no remote calls, so no circuit breaker/i);

    const unreadable = buildEfficiencyOverview(inputs({ breakers: null }));
    expect(unreadable.circuitBreakers).toEqual([]);
    expect(unreadable.notes.join('\n')).toMatch(/could not be read/i);
  });

  it('says what is simulated and why cost is unknown, and prices only when the data tier did', () => {
    const simulated = buildEfficiencyOverview(inputs({ telemetry: USED })).notes.join('\n');
    expect(simulated).toMatch(/deterministic offline provider \(simulated\)/i);
    expect(simulated).toMatch(/cost is unknown/i);
    expect(simulated).toMatch(/no per-case or per-day token cap is configured/i);

    const priced = buildEfficiencyOverview(
      inputs({
        simulated: false,
        telemetry: telemetry({ totals: { ...USED.totals, estimatedCostUsd: 0.42 } }),
      }),
    );
    expect(priced.totals.estimatedCostUsd).toBe(0.42);
    expect(priced.labels).toEqual({ simulated: false, estimated: true });
    expect(priced.notes.join('\n')).not.toMatch(/cost is unknown/i);
    expect(priced.notes.join('\n')).not.toMatch(/offline provider/i);
  });

  it('notes a requested case that was not found', () => {
    expect(buildEfficiencyOverview(inputs({ requestedCaseMissing: true })).notes[0]).toMatch(
      /requested case was not found/i,
    );
  });
});

describe('[FR-EFF-02] real versus simulated tokens', () => {
  const one = aseEstimateWithTokens('case_one', {
    total: 12_000,
    avoidable: 4_800,
    avoidablePct: 40,
  });
  const two = aseEstimateWithTokens('case_two', { total: 6_000, avoidable: 600, avoidablePct: 10 });

  it('reads the token component of the stored avoidable-effort estimate, as the domain computes it', () => {
    expect(tokenProcessOf([one])).toEqual({
      actualTokens: 12_000,
      counterfactualTokens: 7_200,
      savingsPct: 40,
    });
    expect(
      tokenProcessOf([
        estimateOf('case_quality_index', 50),
        estimateOf('avoidable_support_effort', null),
      ]),
    ).toBeNull();
  });

  it('is one case, or the sum of the analysed cases that have a comparison, or "not available"', () => {
    const single = tokenProcessOf([one]);
    const other = tokenProcessOf([two]);
    if (single === null || other === null) throw new Error('fixtures must carry a token component');
    expect(caseProcessOf('case_one', [single])).toEqual({
      actualTokens: 12_000,
      counterfactualTokens: 7_200,
      estimatedSavingsPct: 40,
      caseId: 'case_one',
    });
    expect(caseProcessOf(null, [single, other])).toEqual({
      actualTokens: 18_000,
      counterfactualTokens: 12_600,
      estimatedSavingsPct: 30,
      caseId: null,
    });
    // Nothing to compare: zero actual means "not available", with no counterfactual and no saving.
    expect(caseProcessOf('case_two', [])).toEqual({
      actualTokens: 0,
      counterfactualTokens: null,
      estimatedSavingsPct: null,
      caseId: 'case_two',
    });
  });

  it('explains in a note what the figures cover, or that no comparison exists', () => {
    const single = tokenProcessOf([one]);
    if (single === null) throw new Error('fixture');
    const forCase = buildEfficiencyOverview(
      inputs({ caseProcess: caseProcessOf('case_one', [single]), scope: { kind: 'case' } }),
    );
    expect(EfficiencyOverviewSchema.safeParse(forCase).success).toBe(true);
    expect(forCase.notes.join('\n')).toMatch(
      /real path with the best valid simulated path.*estimates/i,
    );
    const portfolio = buildEfficiencyOverview(
      inputs({
        caseProcess: caseProcessOf(null, [single]),
        scope: { kind: 'portfolio', analysedCases: 1 },
      }),
    );
    expect(portfolio.notes.join('\n')).toMatch(/add up the 1 analysed case/i);
    expect(buildEfficiencyOverview(inputs()).notes.join('\n')).toMatch(
      /no real-versus-simulated token comparison is available/i,
    );
  });
});
