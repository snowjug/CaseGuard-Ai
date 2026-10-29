import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL_CONFIG,
  DependencyHealthSchema,
  EfficiencyOverviewSchema,
  ModelExecutionWithUsageSchema,
  ProviderStatusSchema,
} from '@caseguard/schemas';
import { prepareTask, type AgentTask } from '../src';
import { messageTokens } from '../src/orchestrator/prepare';
import { ScriptedProvider } from './fakes';
import { good, hallucinated, hypTask, one, run, setup } from './orchestrator-harness';
import { qualityTask, timelineTask, validOutput, viewUpTo } from './tasks';

describe('budgets and caching [FR-TK-02]', () => {
  it('[FR-TK-02] degrades to deterministic code, with a clear reason, when the input cannot fit the per-request budget', async () => {
    const provider = new ScriptedProvider([{ output: good() }]);
    const { orchestrator } = setup(provider, {
      agentBudgets: {
        ...DEFAULT_MODEL_CONFIG.agentBudgets,
        hypothesis_generator: {
          maxInputTokens: 256,
          maxOutputTokens: 500,
          maxRetries: 1,
          timeoutMs: 5_000,
        },
      },
    });
    const result = await run(orchestrator);
    expect(provider.requests).toHaveLength(0);
    expect(result.modelExecution).toMatchObject({
      status: 'budget_exceeded',
      resultSource: 'deterministic_fallback',
      attempts: 0,
    });
    expect(result.modelExecution.fallbackReason).toMatch(/input_too_large.*limit is 256/);
    expect(result.modelExecution.usage?.contextTokensBefore).toBeGreaterThan(256);
    expect(result.modelExecution.usage?.contextTokensAfter).toBeLessThan(
      result.modelExecution.usage?.contextTokensBefore ?? 0,
    );
  });

  it('[FR-TK-02] compresses the context instead of failing when a smaller context fits', async () => {
    const task = qualityTask(one);
    const probe = setup().orchestrator;
    const untrimmed = prepareTask(task, 'req', 'gpt-test', probe.prepareDependencies, {
      applyBudget: false,
    }).fit.tokensBefore;
    const budget = Math.floor(untrimmed * 0.85);
    const provider = new ScriptedProvider([{ output: validOutput(task) }]);
    const { orchestrator } = setup(provider, {
      agentBudgets: {
        ...DEFAULT_MODEL_CONFIG.agentBudgets,
        quality_judge: {
          maxInputTokens: budget,
          maxOutputTokens: 3_000,
          maxRetries: 1,
          timeoutMs: 5_000,
        },
      },
    });
    const result = await run(orchestrator, task);
    const usage = result.modelExecution.usage;
    expect(usage?.contextTokensBefore).toBe(untrimmed);
    expect(usage?.contextTokensAfter).toBeLessThanOrEqual(budget);
    expect(usage?.compressionRatio).toBeGreaterThan(0);
    expect(usage?.estimatedSavingsTokens).toBeGreaterThan(0);
    const sent = provider.requests[0];
    expect(sent).toBeDefined();
    expect(messageTokens(sent?.messages ?? [])).toBeLessThanOrEqual(budget);
    expect(result.source).toBe('model');
    expect(usage?.estimatedQualityImpact.level).toMatch(/negligible|possible_minor/);
    expect(result.notices.join(' ')).toMatch(/compressed/);
  }, 60_000);

  it('[FR-TK-02] refuses further model calls once the daily token budget is exhausted', async () => {
    const provider = new ScriptedProvider([
      {
        output: good(),
        usage: { promptTokens: 9_000, completionTokens: 1_000, totalTokens: 10_000 },
      },
    ]);
    const { orchestrator } = setup(provider, {}, { limits: { perDayMaxTokens: 12_000 } });
    expect((await run(orchestrator)).source).toBe('model');
    expect(orchestrator.governor.consumedToday('tenant_test').tokens).toBe(10_000);
    const second = await run(orchestrator, timelineTask(one));
    expect(second.modelExecution.status).toBe('budget_exceeded');
    expect(second.modelExecution.fallbackReason).toMatch(/daily token budget is exhausted/);
    expect(provider.requests).toHaveLength(1);
  });

  it('[NFR-COST-01] refuses model calls when a cost limit is set without unit prices', async () => {
    const provider = new ScriptedProvider([{ output: good() }]);
    const { orchestrator } = setup(provider, {
      costLimits: { perRequestUsd: null, perCaseUsd: null, perDayUsd: 1 },
    });
    const result = await run(orchestrator);
    expect(provider.requests).toHaveLength(0);
    expect(result.modelExecution.fallbackReason).toMatch(/cost_unknown/);
    expect(orchestrator.getHealth().notes.join(' ')).toMatch(
      /cost limit is configured without unit prices/,
    );
  });

  it('[FR-TK-02] serves repeated identical requests from the tenant-scoped cache', async () => {
    const provider = new ScriptedProvider([{ output: good() }]);
    const { orchestrator, metrics } = setup(provider);
    const first = await run(orchestrator);
    const second = await run(orchestrator);
    expect(provider.requests).toHaveLength(1);
    expect(second.source).toBe('cache');
    expect(second.result).toEqual(first.result);
    expect(second.modelExecution).toMatchObject({
      status: 'cache_hit',
      attempts: 0,
      resultSource: 'cache',
      provider: 'azure-openai',
    });
    expect(second.modelExecution.usage).toMatchObject({
      cacheHit: true,
      totalTokens: 0,
      estimatedSavingsTokens: 1_200,
    });
    expect(() => ModelExecutionWithUsageSchema.parse(second.modelExecution)).not.toThrow();
    expect(metrics.sum('ai.cache.hit')).toBe(1);
    expect(orchestrator.getHealth().cache).toMatchObject({ enabled: true, hits: 1, size: 1 });
  });

  it('[NFR-SEC-01] never serves one tenant a cached answer computed for another', async () => {
    const provider = new ScriptedProvider([{ output: good() }]);
    const { orchestrator } = setup(provider);
    await run(orchestrator);
    const otherTenant = {
      ...hypTask,
      input: { ...hypTask.input, tenantId: 'tenant_other' },
    } as AgentTask;
    const result = await run(orchestrator, otherTenant);
    expect(result.source).toBe('model');
    expect(provider.requests).toHaveLength(2);
  });

  it('[FR-CF-02] an earlier temporal window is never served an answer computed with later information', async () => {
    const provider = new ScriptedProvider([
      { output: validOutput(timelineTask(one, viewUpTo(one, 'e14'))) },
      { output: validOutput(timelineTask(one, viewUpTo(one, 'e10'))) },
    ]);
    const { orchestrator } = setup(provider);
    await run(orchestrator, timelineTask(one, viewUpTo(one, 'e14')));
    const earlier = await run(orchestrator, timelineTask(one, viewUpTo(one, 'e10')));
    expect(earlier.source).toBe('model');
    expect(provider.requests).toHaveLength(2);
  });

  it('[FR-TK-02] expires cached answers after the configured TTL and re-validates anything it serves', async () => {
    const provider = new ScriptedProvider([{ output: good() }]);
    const { orchestrator, clock } = setup(provider, {
      semanticCache: { enabled: true, similarityThreshold: 0.92, ttlSeconds: 60 },
    });
    await run(orchestrator);
    clock.advance(61_000);
    expect((await run(orchestrator)).source).toBe('model');
    expect(provider.requests).toHaveLength(2);

    const prepared = prepareTask(hypTask, 'req', 'gpt-test', orchestrator.prepareDependencies, {
      applyBudget: true,
    });
    if (!prepared.cacheScope || !prepared.cacheInput) throw new Error('not cacheable');
    orchestrator.cache?.set(prepared.cacheScope, prepared.cacheInput, hallucinated(), {
      provider: 'azure-openai',
      model: 'gpt-test',
      usage: {
        promptTokens: 1,
        completionTokens: 1,
        cachedTokens: 0,
        totalTokens: 2,
        source: 'measured',
      },
    });
    const result = await run(orchestrator);
    expect(result.source).toBe('model');
    expect(provider.requests).toHaveLength(3);
  });
});

describe('health reporting [NFR-OBS-01]', () => {
  it('[NFR-OBS-01] reports the deterministic provider as healthy and simulated, in the contract shapes', () => {
    const { orchestrator } = setup();
    const health = orchestrator.getHealth();
    expect(() => ProviderStatusSchema.parse(health.provider)).not.toThrow();
    expect(() => DependencyHealthSchema.parse(health.dependency)).not.toThrow();
    expect(health).toMatchObject({ status: 'healthy', degraded: false, breakers: [] });
    expect(health.provider).toMatchObject({
      kind: 'deterministic',
      simulated: true,
      healthy: true,
      configured: true,
    });
  });

  it('[NFR-OBS-01] a remote provider is "unknown" until a call succeeds, and always carries the honest validation note', async () => {
    const provider = new ScriptedProvider([{ output: good() }]);
    const { orchestrator } = setup(provider);
    const before = orchestrator.getHealth();
    expect(before.status).toBe('unknown');
    expect(before.provider.healthy).toBeNull();
    expect(before.provider.validationNote).toBe('Scripted test provider.');
    await run(orchestrator);
    const after = orchestrator.getHealth();
    expect(after).toMatchObject({ status: 'healthy' });
    expect(after.provider.healthy).toBe(true);
    expect(after.dependency.latencyMs).toBe(25);
    expect(() =>
      EfficiencyOverviewSchema.shape.circuitBreakers.parse(after.breakers),
    ).not.toThrow();
  });
});
