import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ModelProvider } from '@caseguard/ai';
import { loadConfig } from '@caseguard/config';
import {
  createFullView,
  getCompiledPack,
  runDeterministicAnalysis,
  type EngineContext,
} from '@caseguard/domain';
import { DEFAULT_ACTION_VALUE_CONFIG, DEFAULT_MODEL_CONFIG } from '@caseguard/schemas';
import type { Database } from '../src/db';
import { TEST_DATABASE_STARTUP_TIMEOUT_MS } from '../src/db/testing';
import { createAiService, effectiveModelConfig } from '../src/services/ai';
import {
  CONTOSO,
  PERSONAS,
  createHarness,
  openSharedDatabase,
  type Harness,
} from './support/app-harness';
import { contextFor } from './support/context';
import { SAMPLE_FILES, ingestSample, normalizeSample } from './support/samples';

const CASE_ID = 'case_ai_service';

let database: Database;
let h: Harness;

beforeAll(async () => {
  database = await openSharedDatabase();
  h = await createHarness({ database });
  await ingestSample(h.repos(CONTOSO), SAMPLE_FILES.caseTwo, {
    tenantId: CONTOSO,
    caseId: CASE_ID,
  });
}, TEST_DATABASE_STARTUP_TIMEOUT_MS);

afterAll(async () => {
  await h.close();
  await database.close();
});

function timelineTask() {
  const normalized = normalizeSample(SAMPLE_FILES.caseTwo, { tenantId: CONTOSO, caseId: CASE_ID });
  const pack = getCompiledPack(normalized.case.workload);
  if (!pack) throw new Error('missing knowledge pack');
  const engineCtx: EngineContext = {
    tenantId: CONTOSO,
    caseId: CASE_ID,
    runId: 'run_ai_service',
    now: '2026-10-29T00:00:00.000Z',
    createdBy: 'system:test',
    seed: 'ai-service-test',
  };
  const view = createFullView(normalized.events, normalized.resolution);
  const analysis = runDeterministicAnalysis({
    view,
    pack,
    config: DEFAULT_ACTION_VALUE_CONFIG,
    ctx: engineCtx,
  });
  return {
    agent: 'timeline_analyzer' as const,
    input: {
      tenantId: CONTOSO,
      caseId: CASE_ID,
      analysisRunId: null,
      view,
      pack,
      config: DEFAULT_ACTION_VALUE_CONFIG,
      ctx: engineCtx,
      analysis,
      hindsight: undefined,
    },
  };
}

describe('effectiveModelConfig', () => {
  const env = (overrides: Record<string, string> = {}) =>
    loadConfig({ APP_ENV: 'test', DATABASE_URL: 'pglite://memory', ...overrides });

  it('never lets a tenant exceed the operator limits', () => {
    const config = env({
      AI_MAX_INPUT_TOKENS: '4000',
      AI_MAX_OUTPUT_TOKENS: '800',
      AI_TIMEOUT_MS: '9000',
    });
    const effective = effectiveModelConfig(
      {
        ...DEFAULT_MODEL_CONFIG,
        maxInputTokens: 50_000,
        maxOutputTokens: 4_000,
        timeoutMs: 60_000,
      },
      config,
    );
    expect(effective.maxInputTokens).toBe(4000);
    expect(effective.maxOutputTokens).toBe(800);
    expect(effective.timeoutMs).toBe(9000);
    for (const budget of Object.values(effective.agentBudgets)) {
      expect(budget.maxInputTokens).toBeLessThanOrEqual(4000);
      expect(budget.maxOutputTokens).toBeLessThanOrEqual(800);
      expect(budget.timeoutMs).toBeLessThanOrEqual(9000);
    }
  });

  it('lets a tenant spend less than the operator allows', () => {
    const config = env({ AI_MAX_INPUT_TOKENS: '100000' });
    const effective = effectiveModelConfig(
      { ...DEFAULT_MODEL_CONFIG, maxInputTokens: 3000 },
      config,
    );
    expect(effective.maxInputTokens).toBe(3000);
  });

  it('keeps the provider the operator connected, whatever the tenant setting says', () => {
    const effective = effectiveModelConfig(
      { ...DEFAULT_MODEL_CONFIG, provider: 'azure-openai' },
      env(),
    );
    expect(effective.provider).toBe('deterministic');
  });

  it('applies the stricter of the tenant and operator daily cost caps and keeps cost unknown without prices', () => {
    const capped = effectiveModelConfig(
      {
        ...DEFAULT_MODEL_CONFIG,
        costLimits: { perRequestUsd: null, perCaseUsd: null, perDayUsd: 5 },
      },
      env({
        AI_COST_LIMIT_USD_PER_DAY: '2',
        AI_UNIT_PRICE_INPUT_PER_1K: '0.01',
        AI_UNIT_PRICE_OUTPUT_PER_1K: '0.03',
      }),
    );
    expect(capped.costLimits.perDayUsd).toBe(2);
    expect(capped.unitPrices.inputPer1kUsd).toBe(0.01);
    expect(capped.unitPrices.outputPer1kUsd).toBe(0.03);

    const unpriced = effectiveModelConfig(DEFAULT_MODEL_CONFIG, env());
    expect(unpriced.unitPrices.inputPer1kUsd).toBeNull();
  });
});

describe('AiService', () => {
  it('runs a task offline, labels it simulated, persists its record and counts the call', async () => {
    const ctx = contextFor(h);
    const task = timelineTask();
    const result = await h.infra.services.ai.run(ctx, { task });

    expect(result.source).toBe('deterministic');
    expect(result.modelExecution.simulated).toBe(true);
    expect(result.modelExecution.provider).toBe('deterministic');
    expect(result.modelExecution.agent).toBe('timeline_analyzer');
    expect(result.modelExecution.usage?.estimated).toBe(true);

    const stored = await ctx.repos.telemetry.listExecutions({ caseId: CASE_ID, limit: 20 });
    expect(stored.items.map((item) => item.id)).toContain(result.modelExecution.id);
    expect(h.infra.metricsRegistry.renderPrometheus()).toContain('timeline_analyzer');
  });

  it('can leave persistence to the caller', async () => {
    const ctx = contextFor(h);
    const before = (await ctx.repos.telemetry.listExecutions({ caseId: CASE_ID, limit: 100 })).items
      .length;
    const result = await h.infra.services.ai.run(ctx, { task: timelineTask() }, { persist: false });
    const after = (await ctx.repos.telemetry.listExecutions({ caseId: CASE_ID, limit: 100 })).items;
    expect(after).toHaveLength(before);
    expect(after.map((item) => item.id)).not.toContain(result.modelExecution.id);
  });

  it('describes the deterministic provider honestly', async () => {
    const status = await h.infra.services.ai.status(contextFor(h));
    expect(status).toMatchObject({ kind: 'deterministic', simulated: true });
    expect(status.validationNote.length).toBeGreaterThan(10);
  });

  it('rebuilds a tenant orchestrator when its model setting changes', async () => {
    const ctx = contextFor(h, PERSONAS.admin);
    const before = await h.infra.services.ai.status(ctx);
    const settings = await ctx.repos.governance.getSettings();
    await ctx.repos.governance.updateSection(
      'model',
      { ...settings.model.value, maxInputTokens: 2048 },
      {
        expectedVersion: settings.model.version,
        changeNote: 'Lower the input budget',
        by: PERSONAS.admin,
      },
    );
    const after = await h.infra.services.ai.status(ctx);
    expect(after.limits.maxInputTokens).toBe(2048);
    expect(after.limits.maxInputTokens).toBeLessThan(before.limits.maxInputTokens);
  });

  it('builds the configured provider once and reports it as not simulated', async () => {
    let created = 0;
    const fake: ModelProvider = {
      kind: 'azure-openai',
      simulated: false,
      defaultModel: 'gpt-test',
      describe: () => ({
        kind: 'azure-openai',
        simulated: false,
        model: 'gpt-test',
        configured: true,
        validationNote: 'Validated against a mock only.',
      }),
      complete: () => Promise.reject(new Error('not used in this test')),
    };
    const service = createAiService(h.infra, {
      providerFactory: async () => {
        created += 1;
        return fake;
      },
    });
    const ctx = contextFor(h, PERSONAS.manager);
    const first = await service.status(ctx);
    const second = await service.status(ctx);
    expect(created).toBe(1);
    expect(first).toMatchObject({ kind: 'azure-openai', simulated: false });
    expect(second.validationNote).toContain('mock');
  });
});
