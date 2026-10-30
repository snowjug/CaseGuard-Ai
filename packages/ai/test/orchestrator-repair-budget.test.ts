import { describe, expect, it } from 'vitest';
import { ProviderError, prepareTask } from '../src';
import { messageTokens } from '../src/orchestrator/prepare';
import { ScriptedProvider } from './fakes';
import { good, hallucinated, hypTask, one, run, setup } from './orchestrator-harness';
import { timelineTask, validOutput } from './tasks';

const TENANT = 'tenant_test';
const CASE = 'case_test';

describe('the budget is checked again before a repair call [FR-TK-02]', () => {
  it('[FR-TK-02] refuses the repair call when the first call already used up the per-case budget', async () => {
    const provider = new ScriptedProvider([
      {
        output: hallucinated(),
        usage: { promptTokens: 9_000, completionTokens: 1_000, totalTokens: 10_000 },
      },
      {
        output: good(),
        usage: { promptTokens: 9_000, completionTokens: 1_000, totalTokens: 10_000 },
      },
    ]);
    const { orchestrator, metrics } = setup(provider, {}, { limits: { perCaseMaxTokens: 12_000 } });
    const result = await run(orchestrator);

    expect(provider.requests).toHaveLength(1);
    expect(orchestrator.governor.consumedForCase(TENANT, CASE).tokens).toBe(10_000);
    expect(result.source).toBe('deterministic_fallback');
    expect(result.modelExecution).toMatchObject({
      status: 'rejected_by_validation',
      repairAttempts: 0,
      attempts: 1,
    });
    expect(result.modelExecution.usage).toMatchObject({ totalTokens: 10_000 });
    expect(result.rejection).toMatchObject({
      kinds: ['citation'],
      repairable: true,
      repairAttempted: false,
    });
    expect(result.rejection?.summary).toMatch(/repair attempt was not made.*per-case token budget/);
    expect(metrics.sum('ai.budget.refused', { code: 'case_tokens' })).toBe(1);
  });

  it('[FR-TK-02] the same holds for the per-day budget', async () => {
    const provider = new ScriptedProvider([
      {
        output: hallucinated(),
        usage: { promptTokens: 9_000, completionTokens: 1_000, totalTokens: 10_000 },
      },
      { output: good() },
    ]);
    const { orchestrator } = setup(provider, {}, { limits: { perDayMaxTokens: 12_000 } });
    const result = await run(orchestrator);
    expect(provider.requests).toHaveLength(1);
    expect(orchestrator.governor.consumedToday(TENANT).tokens).toBe(10_000);
    expect(result.rejection?.summary).toMatch(/repair attempt was not made.*daily token budget/);
  });

  it('[FR-TK-02] counts the repair feedback in the estimate for the repair call', async () => {
    const probe = setup().orchestrator;
    const prepared = prepareTask(hypTask, 'req', 'gpt-test', probe.prepareDependencies, {
      applyBudget: true,
    });
    // Room for the first call and for a repair call that carried no feedback, but not for the feedback.
    const limit = prepared.fit.tokensAfter + prepared.limits.maxOutputTokens + 1;
    const provider = new ScriptedProvider([
      {
        output: hallucinated(),
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      },
      { output: good() },
    ]);
    const { orchestrator } = setup(provider, {}, { limits: { perCaseMaxTokens: limit } });
    const result = await run(orchestrator);

    expect(provider.requests).toHaveLength(1);
    expect(result.rejection?.summary).toMatch(/repair attempt was not made/);
    expect(messageTokens(provider.requests[0]?.messages ?? [])).toBe(prepared.fit.tokensAfter);
  });

  it('[FR-TK-02] still repairs once when the budget has room, and counts each call exactly once', async () => {
    const provider = new ScriptedProvider([
      {
        output: hallucinated(),
        usage: { promptTokens: 4_000, completionTokens: 500, totalTokens: 4_500 },
      },
      { output: good(), usage: { promptTokens: 4_200, completionTokens: 300, totalTokens: 4_500 } },
    ]);
    const { orchestrator } = setup(
      provider,
      { unitPrices: { inputPer1kUsd: 1, outputPer1kUsd: 2, cachedInputPer1kUsd: null } },
      { limits: { perCaseMaxTokens: 100_000 } },
    );
    const result = await run(orchestrator);

    expect(provider.requests).toHaveLength(2);
    expect(result.source).toBe('model');
    expect(result.modelExecution).toMatchObject({ repairAttempts: 1, attempts: 2 });
    expect(orchestrator.governor.consumedForCase(TENANT, CASE).tokens).toBe(9_000);
    expect(orchestrator.governor.consumedToday(TENANT).tokens).toBe(9_000);
    // (4000 + 4200) / 1000 x 1 + (500 + 300) / 1000 x 2
    expect(orchestrator.governor.consumedToday(TENANT).costUsd).toBeCloseTo(8.2 + 1.6, 10);
  });

  it('[FR-TK-02] a call that fails outright costs nothing, and a later successful call is counted once', async () => {
    const provider = new ScriptedProvider([
      {
        error: new ProviderError('server_error', 'The provider failed.', {
          status: 500,
          attempts: 3,
        }),
      },
      (request) => {
        const output: unknown = validOutput(request.task as never);
        return {
          output,
          usage: { promptTokens: 2_000, completionTokens: 300, totalTokens: 2_300 },
        };
      },
    ]);
    const { orchestrator } = setup(provider, {}, { limits: { perCaseMaxTokens: 100_000 } });
    const failed = await run(orchestrator);
    expect(failed.modelExecution.status).toBe('failed');
    expect(orchestrator.governor.consumedForCase(TENANT, CASE).tokens).toBe(0);
    const ok = await run(orchestrator, timelineTask(one));
    expect(ok.source).toBe('model');
    expect(orchestrator.governor.consumedForCase(TENANT, CASE).tokens).toBe(2_300);
  });
});
