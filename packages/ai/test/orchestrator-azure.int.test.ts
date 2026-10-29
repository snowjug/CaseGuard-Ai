import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL_CONFIG,
  ModelExecutionWithUsageSchema,
  type ModelConfig,
} from '@caseguard/schemas';
import { AiOrchestrator, AiTaskError, AzureOpenAiProvider, type AgentTask } from '../src';
import { CASE_ONE, prepareCase } from './helpers';
import { FakeClock, capturingLogger, capturingMetrics } from './fakes';
import { MockAzureServer, chatCompletion } from './mock-azure';
import { hypothesisTask, validOutput, viewUpTo } from './tasks';

const TOKEN = 'eyJ-orchestrated-SECRET-TOKEN-9876543210';
const one = prepareCase(CASE_ONE);
const task: AgentTask = hypothesisTask(one, viewUpTo(one, 'e14'));

let server: MockAzureServer;

beforeAll(async () => {
  server = await MockAzureServer.start();
});
afterAll(async () => {
  await server.stop();
});
beforeEach(() => {
  server.reset();
});

function wire(patch: Partial<ModelConfig> = {}) {
  const clock = new FakeClock();
  const logger = capturingLogger();
  const metrics = capturingMetrics();
  const sleeps: number[] = [];
  const scopes: string[] = [];
  const provider = new AzureOpenAiProvider({
    endpoint: server.endpoint,
    deployment: 'gpt-test',
    apiVersion: '2024-10-21',
    auth: {
      kind: 'managed-identity',
      credential: {
        getToken: (scope) => {
          scopes.push(scope);
          return Promise.resolve({ token: TOKEN, expiresOnTimestamp: clock.nowMs() + 3_600_000 });
        },
      },
    },
    clock,
    logger,
    metrics,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 0.5,
  });
  const orchestrator = new AiOrchestrator({
    config: {
      ...DEFAULT_MODEL_CONFIG,
      provider: 'azure-openai',
      azureDeployment: 'gpt-test',
      routing: { defaultModel: 'gpt-test', cheapModel: null, rules: [] },
      maxRetries: 2,
      ...patch,
    },
    provider,
    clock,
    logger,
    metrics,
    random: () => 0.5,
  });
  return { orchestrator, provider, logger, metrics, sleeps, scopes, clock };
}

const hallucinated = () => {
  const out = validOutput(hypothesisTask(one, viewUpTo(one, 'e14')));
  const item = out.hypotheses[0];
  if (item) item.eventIds = ['e99'];
  return out;
};

describe('AiOrchestrator + AzureOpenAiProvider against a local mock server [NFR-REL-01]', () => {
  it('[FR-TK-01] accepts a validated proposal received over HTTP and records measured usage', async () => {
    server.setDefault(
      chatCompletion(validOutput(hypothesisTask(one, viewUpTo(one, 'e14'))), {
        usage: { prompt: 3_100, completion: 420, cached: 100 },
      }),
    );
    const { orchestrator, scopes } = wire();
    const result = await orchestrator.runAgentTask({ task });
    expect(result.source).toBe('model');
    expect(() => ModelExecutionWithUsageSchema.parse(result.modelExecution)).not.toThrow();
    expect(result.modelExecution).toMatchObject({
      provider: 'azure-openai',
      model: 'gpt-test',
      status: 'succeeded',
      simulated: false,
      attempts: 1,
      retries: 0,
    });
    expect(result.modelExecution.usage).toMatchObject({
      promptTokens: 3_100,
      completionTokens: 420,
      cachedTokens: 100,
      tokenSource: 'measured',
      simulated: false,
    });

    expect(server.requests).toHaveLength(1);
    const sent = server.requests[0];
    expect(sent?.path).toBe('/openai/deployments/gpt-test/chat/completions');
    expect(sent?.query.get('api-version')).toBe('2024-10-21');
    expect(sent?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(scopes).toEqual(['https://cognitiveservices.azure.com/.default']);
    const body = sent?.body as {
      response_format: { type: string; json_schema: { strict: boolean } };
      messages: { role: string }[];
      tools?: unknown;
    };
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(body.tools).toBeUndefined();
  });

  it('[NFR-SEC-05] malformed JSON triggers one repair over HTTP, then falls back to deterministic code', async () => {
    server.setDefault(
      chatCompletion('{"hypotheses": [', { usage: { prompt: 500, completion: 20 } }),
    );
    const { orchestrator } = wire();
    const result = await orchestrator.runAgentTask({ task });
    expect(server.requests).toHaveLength(2);
    const repairBody = server.requests[1]?.body as {
      messages: { role: string; content: string }[];
    };
    expect(repairBody.messages).toHaveLength(3);
    expect(repairBody.messages[2]?.content).toContain('not valid JSON');
    expect(result.source).toBe('deterministic_fallback');
    expect(result.result).toEqual(validOutput(hypothesisTask(one, viewUpTo(one, 'e14'))));
    expect(result.modelExecution).toMatchObject({
      status: 'rejected_by_validation',
      repairAttempts: 1,
      attempts: 2,
      simulated: true,
    });
    expect(result.modelExecution.usage).toMatchObject({
      promptTokens: 1_000,
      completionTokens: 40,
      tokenSource: 'measured',
    });
    expect(result.rejection?.issues[0]).toMatchObject({ kind: 'schema', code: 'not_json' });
    expect(JSON.stringify(result)).not.toContain('{"hypotheses": [');
  });

  it('[NFR-SEC-05] a hallucinated citation is repaired once; a corrected reply is then accepted', async () => {
    server.enqueue(
      chatCompletion(hallucinated()),
      chatCompletion(validOutput(hypothesisTask(one, viewUpTo(one, 'e14')))),
    );
    const { orchestrator } = wire();
    const result = await orchestrator.runAgentTask({ task });
    expect(server.requests).toHaveLength(2);
    expect(result.source).toBe('model');
    expect(result.modelExecution).toMatchObject({
      repairAttempts: 1,
      attempts: 2,
      status: 'succeeded',
    });
  });

  it('[NFR-REL-01] honours Retry-After on 429 and retries inside the provider', async () => {
    server.enqueue(
      { status: 429, headers: { 'retry-after': '2' }, json: { error: { code: '429' } } },
      chatCompletion(validOutput(hypothesisTask(one, viewUpTo(one, 'e14')))),
    );
    const { orchestrator, sleeps } = wire();
    const result = await orchestrator.runAgentTask({ task });
    expect(result.source).toBe('model');
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(2_000);
    expect(sleeps[0]).toBeLessThanOrEqual(2_200);
    expect(result.modelExecution).toMatchObject({ attempts: 2, retries: 1 });
  });

  it('[NFR-REL-01] persistent 5xx errors fall back, count toward the circuit breaker and stay within the retry bound', async () => {
    server.setDefault({ status: 500, json: { error: { code: 'internal' } } });
    const { orchestrator } = wire({ maxRetries: 1 });
    const result = await orchestrator.runAgentTask({ task });
    expect(server.requests).toHaveLength(2);
    expect(result.source).toBe('deterministic_fallback');
    expect(result.modelExecution).toMatchObject({ status: 'failed', attempts: 2 });
    expect(result.modelExecution.fallbackReason).toContain('server_error');
    expect(orchestrator.getHealth().breakers[0]).toMatchObject({
      state: 'closed',
      consecutiveFailures: 1,
    });
  });

  it('[NFR-REL-01] a content-filter rejection falls back without counting against the circuit breaker', async () => {
    server.setDefault({
      status: 400,
      json: { error: { code: 'content_filter', message: 'blocked' } },
    });
    const { orchestrator } = wire();
    const result = await orchestrator.runAgentTask({ task });
    expect(server.requests).toHaveLength(1);
    expect(result.source).toBe('deterministic_fallback');
    expect(result.modelExecution.fallbackReason).toContain('content_filtered');
    expect(orchestrator.getHealth().breakers[0]).toMatchObject({
      state: 'closed',
      consecutiveFailures: 0,
    });
  });

  it('[NFR-REL-01] a hung provider times out within the configured limit and the task still completes deterministically', async () => {
    server.setDefault({ hold: true });
    const { orchestrator } = wire({ timeoutMs: 1_000, maxRetries: 0 });
    const started = Date.now();
    const result = await orchestrator.runAgentTask({ task });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.source).toBe('deterministic_fallback');
    expect(result.modelExecution.status).toBe('timed_out');
  }, 15_000);

  it('[NFR-REL-01] cancelling mid-flight aborts the HTTP call and yields a cancelled execution record', async () => {
    server.setDefault({ hold: true });
    const { orchestrator } = wire();
    const controller = new AbortController();
    const pending = orchestrator
      .runAgentTask({ task, signal: controller.signal })
      .catch((e: unknown) => e);
    await new Promise((resolve) => setTimeout(resolve, 150));
    controller.abort();
    const error = await pending;
    expect(error).toBeInstanceOf(AiTaskError);
    expect((error as AiTaskError).code).toBe('cancelled');
    expect((error as AiTaskError).execution?.status).toBe('cancelled');
    expect(orchestrator.getHealth().breakers[0]?.state).toBe('closed');
  }, 15_000);

  it('[NFR-OBS-01] the access token never appears in results, execution records, logs or metrics', async () => {
    server.enqueue(
      { status: 500, json: { error: { code: 'internal', message: `echo ${TOKEN}` } } },
      chatCompletion(validOutput(hypothesisTask(one, viewUpTo(one, 'e14')))),
    );
    const { orchestrator, logger, metrics } = wire();
    const ok = await orchestrator.runAgentTask({ task });
    server.reset();
    server.setDefault({
      status: 500,
      json: { error: { code: 'internal', message: `echo ${TOKEN}` } },
    });
    const failed = await orchestrator.runAgentTask({
      task: hypothesisTask(one, viewUpTo(one, 'e10')),
    });
    const everything = JSON.stringify({
      ok,
      failed,
      logs: logger.entries,
      metrics: metrics.entries,
      health: orchestrator.getHealth(),
    });
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain('SECRET');
  });
});
