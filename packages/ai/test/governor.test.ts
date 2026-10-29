import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_CONFIG, type ModelConfig } from '@caseguard/schemas';
import { createTemporalView, runDeterministicAnalysis } from '@caseguard/domain';
import {
  AiOrchestrator,
  TokenGovernor,
  fitContextToBudget,
  buildContext,
  prepareTask,
  type AgentTask,
} from '../src';
import { CASE_ONE, CONFIG, eventBySuffix, prepareCase } from './helpers';
import { FakeClock, capturingLogger } from './fakes';
import { baseOf, qualityTask, timelineTask, wholeRecordView } from './tasks';

const one = prepareCase(CASE_ONE);

const withConfig = (patch: Partial<ModelConfig>): ModelConfig => ({
  ...DEFAULT_MODEL_CONFIG,
  ...patch,
});
const governorOf = (patch: Partial<ModelConfig> = {}, clock = new FakeClock(), limits = {}) =>
  new TokenGovernor({ config: withConfig(patch), clock, limits, logger: capturingLogger() });

describe('limits and routing [FR-TK-02]', () => {
  it('[FR-TK-02] uses the stricter of the global and the per-agent budget', () => {
    const governor = governorOf({
      maxInputTokens: 10_000,
      maxOutputTokens: 2_000,
      agentBudgets: {
        ...DEFAULT_MODEL_CONFIG.agentBudgets,
        timeline_analyzer: {
          maxInputTokens: 4_000,
          maxOutputTokens: 3_000,
          maxRetries: 1,
          timeoutMs: 5_000,
        },
      },
    });
    expect(governor.limitsFor('timeline_analyzer')).toEqual({
      maxInputTokens: 4_000,
      maxOutputTokens: 2_000,
      maxRetries: 1,
      timeoutMs: 5_000,
    });
    expect(governor.limitsFor('quality_judge').maxInputTokens).toBe(10_000);
  });

  it('[FR-TK-02] routes by task difficulty: code for pure computation, cheap model for classification, stronger model for reasoning', () => {
    const governor = governorOf({
      azureDeployment: 'gpt-strong',
      routing: {
        defaultModel: 'deterministic-knowledge-pack',
        cheapModel: 'gpt-small',
        rules: [{ agent: 'skilldna_extractor', model: 'gpt-special' }],
      },
    });
    expect(governor.route('token_governor', 'azure-openai')).toMatchObject({
      tier: 'deterministic',
    });
    expect(governor.route('safety_policy_validator', 'azure-openai')).toMatchObject({
      tier: 'deterministic',
    });
    expect(governor.route('quality_judge', 'deterministic')).toMatchObject({
      tier: 'deterministic',
    });
    expect(governor.route('evidence_classifier', 'azure-openai')).toMatchObject({
      tier: 'cheap',
      model: 'gpt-small',
    });
    expect(governor.route('hypothesis_generator', 'azure-openai')).toMatchObject({
      tier: 'strong',
      model: 'gpt-strong',
    });
    expect(governor.route('skilldna_extractor', 'azure-openai')).toMatchObject({
      tier: 'rule',
      model: 'gpt-special',
    });
  });

  it('[FR-TK-02] degrades to deterministic code when no deployment is configured', () => {
    const governor = governorOf({
      azureDeployment: '',
      routing: { defaultModel: '', cheapModel: null, rules: [] },
    });
    expect(governor.route('quality_judge', 'azure-openai')).toMatchObject({
      tier: 'deterministic',
      reason: 'No model deployment is configured.',
    });
  });
});

describe('cost estimation [NFR-COST-01]', () => {
  it('[NFR-COST-01] never invents a price: cost is unknown until the operator supplies unit prices', () => {
    expect(governorOf().estimateCostUsd(1000, 500)).toBeNull();
    expect(
      governorOf({
        unitPrices: { inputPer1kUsd: 1, outputPer1kUsd: null, cachedInputPer1kUsd: null },
      }).estimateCostUsd(1000, 500),
    ).toBeNull();
  });

  it('[NFR-COST-01] computes cost from operator-supplied prices, charging cached tokens at the cached rate', () => {
    const governor = governorOf({
      unitPrices: { inputPer1kUsd: 2, outputPer1kUsd: 6, cachedInputPer1kUsd: 0.5 },
    });
    // 800 uncached x 2/1k + 200 cached x 0.5/1k + 500 output x 6/1k
    expect(governor.estimateCostUsd(1000, 500, 200)).toBeCloseTo(1.6 + 0.1 + 3, 10);
    expect(
      governorOf({
        unitPrices: { inputPer1kUsd: 2, outputPer1kUsd: 6, cachedInputPer1kUsd: null },
      }).estimateCostUsd(1000, 0, 500),
    ).toBeCloseTo(2, 10);
  });
});

describe('budgets and refusals [FR-TK-02] [NFR-COST-01]', () => {
  const request = {
    tenantId: 'tenant_a',
    caseId: 'case_1',
    agent: 'quality_judge' as const,
    estimatedInputTokens: 1_000,
    maxOutputTokens: 500,
  };

  it('[FR-TK-02] refuses an input above the per-request limit with a clear reason', () => {
    const verdict = governorOf({ maxInputTokens: 2_000 }).checkBudget({
      ...request,
      estimatedInputTokens: 5_000,
    });
    expect(verdict).toMatchObject({ allowed: false, code: 'request_tokens' });
    expect(verdict.allowed === false && verdict.reason).toMatch(/5,000 tokens.*limit is 2,000/);
  });

  it('[FR-TK-02] enforces the per-day budget per tenant and resets on the next UTC day', () => {
    const clock = new FakeClock(Date.parse('2026-10-29T23:30:00Z'));
    const governor = governorOf({}, clock, { perDayMaxTokens: 5_000 });
    expect(governor.checkBudget(request).allowed).toBe(true);
    governor.record({
      tenantId: 'tenant_a',
      caseId: 'case_1',
      promptTokens: 3_000,
      completionTokens: 1_000,
      cachedTokens: 0,
    });
    const refused = governor.checkBudget(request);
    expect(refused).toMatchObject({ allowed: false, code: 'day_tokens' });
    expect(refused.allowed === false && refused.reason).toMatch(/4,000 of 5,000 tokens used today/);
    expect(governor.checkBudget({ ...request, tenantId: 'tenant_b' }).allowed).toBe(true);
    expect(governor.consumedToday('tenant_a').tokens).toBe(4_000);

    clock.advance(60 * 60 * 1000);
    expect(governor.consumedToday('tenant_a').tokens).toBe(0);
    expect(governor.checkBudget(request).allowed).toBe(true);
  });

  it('[FR-TK-02] enforces the per-case budget', () => {
    const governor = governorOf({}, new FakeClock(), { perCaseMaxTokens: 3_000 });
    governor.record({
      tenantId: 'tenant_a',
      caseId: 'case_1',
      promptTokens: 2_000,
      completionTokens: 500,
      cachedTokens: 0,
    });
    expect(governor.checkBudget(request)).toMatchObject({ allowed: false, code: 'case_tokens' });
    expect(governor.checkBudget({ ...request, caseId: 'case_2' }).allowed).toBe(true);
    expect(governor.consumedForCase('tenant_a', 'case_1').tokens).toBe(2_500);
  });

  it('[NFR-COST-01] enforces cost limits from operator prices (worst case before the call)', () => {
    const prices = { inputPer1kUsd: 1, outputPer1kUsd: 2, cachedInputPer1kUsd: null };
    const governor = governorOf({
      unitPrices: prices,
      costLimits: { perRequestUsd: 1.2, perCaseUsd: null, perDayUsd: 3 },
    });
    // worst case: 1000 in x 1/1k + 500 out x 2/1k = 2.0 > 1.2
    expect(governor.checkBudget(request)).toMatchObject({ allowed: false, code: 'cost_limit' });
    expect(
      governor.checkBudget({ ...request, estimatedInputTokens: 100, maxOutputTokens: 100 }).allowed,
    ).toBe(true);
    const day = governorOf({
      unitPrices: prices,
      costLimits: { perRequestUsd: null, perCaseUsd: null, perDayUsd: 3 },
    });
    day.record({
      tenantId: 'tenant_a',
      caseId: null,
      promptTokens: 2_000,
      completionTokens: 400,
      cachedTokens: 0,
    });
    expect(day.consumedToday('tenant_a').costUsd).toBeCloseTo(2.8, 10);
    expect(
      day.checkBudget({ ...request, estimatedInputTokens: 500, maxOutputTokens: 100 }),
    ).toMatchObject({ allowed: false, code: 'cost_limit' });
  });

  it('[NFR-COST-01] fails closed, with a clear reason, when a cost limit exists but no prices do', () => {
    const logger = capturingLogger();
    const governor = new TokenGovernor({
      config: withConfig({ costLimits: { perRequestUsd: null, perCaseUsd: null, perDayUsd: 5 } }),
      clock: new FakeClock(),
      logger,
    });
    const verdict = governor.checkBudget(request);
    expect(verdict).toMatchObject({ allowed: false, code: 'cost_unknown' });
    expect(verdict.allowed === false && verdict.reason).toMatch(/unit prices are not/);
    governor.checkBudget(request);
    expect(
      logger.entries.filter((e) => e.fields.event === 'ai.budget.cost_unenforceable'),
    ).toHaveLength(1);
  });

  it('[FR-TK-02] can be re-seeded after a restart and picks up governed configuration changes', () => {
    const governor = governorOf({}, new FakeClock(), { perDayMaxTokens: 5_000 });
    governor.restoreDailyUsage('tenant_a', 4_900, null);
    expect(governor.checkBudget(request)).toMatchObject({ allowed: false, code: 'day_tokens' });
    governor.updateConfig(withConfig({ maxInputTokens: 500 }));
    expect(governor.limitsFor('quality_judge').maxInputTokens).toBe(500);
  });
});

describe('context compression and duplicate removal [FR-TK-02]', () => {
  const deps = new AiOrchestrator({ config: DEFAULT_MODEL_CONFIG }).prepareDependencies;
  const tokensAt = (task: AgentTask, budget: number) => {
    const governor = new TokenGovernor({
      config: withConfig({
        agentBudgets: {
          ...DEFAULT_MODEL_CONFIG.agentBudgets,
          [task.agent]: {
            maxInputTokens: budget,
            maxOutputTokens: 1_000,
            maxRetries: 1,
            timeoutMs: 5_000,
          },
        },
        maxInputTokens: budget,
      }),
      clock: new FakeClock(),
    });
    return prepareTask(task, 'req', 'm', { ...deps, governor }, { applyBudget: true });
  };

  it('[FR-TK-02] picks the least-compressed context that fits and never exceeds the budget silently', () => {
    const task = qualityTask(one);
    const full = tokensAt(task, 1_000_000);
    expect(full.fit.level).toBe(0);
    const levels = [12_000, 6_000, 3_500, 2_000, 1_200].map((b) => tokensAt(task, b));
    const sorted = levels.map((l) => l.fit.tokensAfter);
    expect([...sorted].sort((a, b) => b - a)).toEqual(sorted);
    expect(Math.max(...levels.map((l) => l.fit.level))).toBeGreaterThan(0);
    for (const l of levels)
      if (l.fit.fits) expect(l.fit.tokensAfter).toBeLessThanOrEqual(l.limits.maxInputTokens);
    const impossible = tokensAt(task, 50);
    expect(impossible.fit.fits).toBe(false);
    expect(impossible.fit.level).toBe(4);
  });

  it('[FR-TK-02] prefers evidence summaries over raw text and keeps every evidence id when compressing', () => {
    const task = timelineTask(one);
    const base = buildContext(task, 0, {
      redact: (t) => t,
      scanInjection: () => [],
      maxAnalysisDepth: 8,
    });
    const compressed = buildContext(qualityTask(one), 3, {
      redact: (t) => t,
      scanInjection: () => [],
      maxAnalysisDepth: 8,
    });
    expect(compressed.context.events.every((e) => e.text === null)).toBe(true);
    expect(compressed.context.evidence.length).toBe(one.analysis.evidence.length);
    expect(compressed.context.evidence.every((e) => e.excerpt === null)).toBe(true);
    expect(base.context.events.some((e) => e.text !== null)).toBe(true);
    expect(compressed.stats.tokensAfter).toBeLessThan(
      buildContext(qualityTask(one), 0, {
        redact: (t) => t,
        scanInjection: () => [],
        maxAnalysisDepth: 8,
      }).stats.tokensAfter,
    );
  });

  it('[FR-TK-02] removes duplicate notes (quoted threads repeated verbatim) from the context', () => {
    const events = one.normalized.events.map((e) =>
      e.id === eventBySuffix(one, 'e13').id ? { ...e, body: eventBySuffix(one, 'e03').body } : e,
    );
    const view = createTemporalView(events, eventBySuffix(one, 'e14').timestamp);
    const analysis = runDeterministicAnalysis({
      view,
      pack: one.pack,
      config: CONFIG,
      ctx: one.ctx,
    });
    const built = buildContext(
      { agent: 'timeline_analyzer', input: { ...baseOf(one, view), analysis } },
      0,
      { redact: (t) => t, scanInjection: () => [], maxAnalysisDepth: 8 },
    );
    const duplicate = built.context.events.find((e) => e.id === eventBySuffix(one, 'e13').id);
    expect(duplicate?.duplicateOf).toBe(eventBySuffix(one, 'e03').id);
    expect(duplicate?.text).toBeNull();
    expect(built.stats.duplicatesRemoved).toBe(1);
  });

  it('[FR-TK-02] fitContextToBudget stops at the first level that fits', () => {
    const task = timelineTask(one, wholeRecordView(one));
    const calls: number[] = [];
    const result = fitContextToBudget({
      buildAt: (level) => {
        calls.push(level);
        return buildContext(task, level, {
          redact: (t) => t,
          scanInjection: () => [],
          maxAnalysisDepth: 8,
        });
      },
      measure: (b) => b.stats.tokensAfter,
      maxInputTokens: 1_500,
    });
    expect(result.fits).toBe(true);
    expect(calls[calls.length - 1]).toBe(result.level);
    expect(result.tokensBefore).toBeGreaterThanOrEqual(result.tokensAfter);
  });
});
