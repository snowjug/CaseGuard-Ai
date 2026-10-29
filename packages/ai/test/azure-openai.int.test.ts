import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AZURE_OPENAI_SCOPE,
  AzureOpenAiProvider,
  ProviderError,
  type AzureOpenAiProviderOptions,
  type ModelRequest,
  type TokenCredential,
} from '../src';
import { FakeClock, capturingLogger } from './fakes';
import { MockAzureServer, chatCompletion } from './mock-azure';

const API_KEY = 'sk-test-SECRET-KEY-0123456789abcdef';
const TOKEN = 'eyJ-test-SECRET-TOKEN-0123456789';

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

const SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: false,
};

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    requestId: 'req_azure_test',
    tenantId: 'tenant_test',
    agent: 'timeline_analyzer',
    messages: [
      { role: 'system', content: 'You are a test system prompt.' },
      { role: 'user', content: 'Return {"ok": true}.' },
    ],
    structuredOutput: { name: 'caseguard.test-output.v1', schema: SCHEMA, strict: true },
    maxOutputTokens: 500,
    temperature: 0,
    timeoutMs: 5_000,
    model: null,
    task: {
      agent: 'token_governor',
      input: {
        tenantId: 'tenant_test',
        caseId: null,
        targetAgent: 'timeline_analyzer',
        estimatedInputTokens: 10,
        providerKind: 'azure-openai',
      },
    },
    ...overrides,
  };
}

interface Harness {
  provider: AzureOpenAiProvider;
  sleeps: number[];
  clock: FakeClock;
  logger: ReturnType<typeof capturingLogger>;
  credential: TokenCredential & { calls: string[] };
}

function harness(options: Partial<AzureOpenAiProviderOptions> = {}): Harness {
  const clock = new FakeClock();
  const sleeps: number[] = [];
  const logger = capturingLogger();
  const calls: string[] = [];
  const credential = {
    calls,
    getToken: (scope: string) => {
      calls.push(scope);
      return Promise.resolve({ token: TOKEN, expiresOnTimestamp: clock.nowMs() + 3_600_000 });
    },
  };
  const provider = new AzureOpenAiProvider({
    endpoint: server.endpoint,
    deployment: 'gpt-test',
    apiVersion: '2024-10-21',
    auth: { kind: 'managed-identity', credential },
    clock,
    logger,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 0.5,
    ...options,
  });
  return { provider, sleeps, clock, logger, credential };
}

describe('AzureOpenAiProvider against a local mock server [NFR-REL-01]', () => {
  it('[FR-TK-01] sends the chat-completions shape with strict structured output and no tools', async () => {
    server.enqueue(
      chatCompletion({ ok: true }, { usage: { prompt: 321, completion: 45, cached: 100 } }),
    );
    const { provider } = harness();
    const response = await provider.complete(request());

    const recorded = server.requests[0];
    expect(recorded?.method).toBe('POST');
    expect(recorded?.path).toBe('/openai/deployments/gpt-test/chat/completions');
    expect(recorded?.query.get('api-version')).toBe('2024-10-21');
    const body = recorded?.body as Record<string, unknown>;
    expect(body.messages).toEqual(request().messages);
    expect(body.max_tokens).toBe(500);
    expect(body.temperature).toBe(0);
    expect(body.stream).toBe(false);
    expect(body.tools).toBeUndefined();
    expect(body.functions).toBeUndefined();
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'caseguard_test-output_v1', strict: true, schema: SCHEMA },
    });
    expect(recorded?.rawBody).not.toContain('"task"');

    expect(response.output).toEqual({ ok: true });
    expect(response.provider).toBe('azure-openai');
    expect(response.simulated).toBe(false);
    expect(response.model).toBe('gpt-mock-2026-01-01');
    expect(response.finishReason).toBe('stop');
    expect(response.attempts).toBe(1);
    expect(response.retries).toBe(0);
  });

  it('[FR-TK-01] reads measured token usage including cached tokens from the response', async () => {
    server.enqueue(
      chatCompletion({ ok: true }, { usage: { prompt: 321, completion: 45, cached: 100 } }),
    );
    const { provider } = harness();
    const { usage } = await provider.complete(request());
    expect(usage).toEqual({
      promptTokens: 321,
      completionTokens: 45,
      cachedTokens: 100,
      totalTokens: 366,
      source: 'measured',
    });
  });

  it('[FR-TK-01] labels usage as estimated when the response carries none', async () => {
    server.enqueue(chatCompletion({ ok: true }, { usage: null }));
    const { usage } = await harness().provider.complete(request());
    expect(usage.source).toBe('estimated');
    expect(usage.promptTokens).toBeGreaterThan(0);
  });

  it('[FR-TK-02] routes to the requested deployment and rejects unsafe deployment names', async () => {
    server.enqueue(chatCompletion({ ok: true }));
    const { provider } = harness();
    await provider.complete(request({ model: 'gpt-mini-test' }));
    expect(server.requests[0]?.path).toBe('/openai/deployments/gpt-mini-test/chat/completions');
    await expect(provider.complete(request({ model: '../evil?x=1' }))).rejects.toMatchObject({
      code: 'not_configured',
    });
  });

  it('[NFR-SEC-03] managed identity: bearer token from the injected credential with the cognitive-services scope, cached until near expiry', async () => {
    server.setDefault(chatCompletion({ ok: true }));
    const { provider, credential, clock } = harness();
    await provider.complete(request());
    await provider.complete(request());
    expect(credential.calls).toEqual([AZURE_OPENAI_SCOPE]);
    expect(server.requests.every((r) => r.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(server.requests.every((r) => r.headers['api-key'] === undefined)).toBe(true);

    clock.advance(3_600_000 - 60_000);
    await provider.complete(request());
    expect(credential.calls).toHaveLength(2);
  });

  it('[NFR-SEC-03] a 401 refreshes the token once and retries; a second 401 is final', async () => {
    server.enqueue(
      { status: 401, json: { error: { code: 'Unauthorized' } } },
      chatCompletion({ ok: true }),
    );
    const { provider, credential } = harness();
    await expect(provider.complete(request())).resolves.toMatchObject({
      output: { ok: true },
      retries: 1,
    });
    expect(credential.calls).toHaveLength(2);

    server.reset();
    server.setDefault({ status: 401, json: { error: { code: 'Unauthorized' } } });
    await expect(harness().provider.complete(request())).rejects.toMatchObject({
      code: 'unauthorized',
      status: 401,
    });
    expect(server.requests).toHaveLength(2);
  });

  it('[NFR-SEC-03] api-key mode sends the api-key header only, and only when explicitly allowed', async () => {
    server.enqueue(chatCompletion({ ok: true }));
    const { provider } = harness({ auth: { kind: 'api-key', apiKey: API_KEY }, allowApiKey: true });
    await provider.complete(request());
    expect(server.requests[0]?.headers['api-key']).toBe(API_KEY);
    expect(server.requests[0]?.headers.authorization).toBeUndefined();

    expect(() => harness({ auth: { kind: 'api-key', apiKey: API_KEY } })).toThrow(
      /local experiments only/,
    );
    expect(() => harness({ auth: { kind: 'api-key', apiKey: '' }, allowApiKey: true })).toThrow(
      ProviderError,
    );
  });

  it('[NFR-REL-01] retries a 429 and honours Retry-After (seconds)', async () => {
    server.enqueue(
      { status: 429, headers: { 'retry-after': '2' }, json: { error: { code: '429' } } },
      chatCompletion({ ok: true }),
    );
    const { provider, sleeps } = harness();
    const response = await provider.complete(request());
    expect(response.output).toEqual({ ok: true });
    expect(response.attempts).toBe(2);
    expect(response.retries).toBe(1);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(2000);
    expect(sleeps[0]).toBeLessThanOrEqual(2200);
  });

  it('[NFR-REL-01] honours retry-after-ms and HTTP-date Retry-After', async () => {
    server.enqueue(
      { status: 429, headers: { 'retry-after-ms': '750' }, json: {} },
      chatCompletion({ ok: true }),
    );
    const a = harness();
    await a.provider.complete(request());
    expect(a.sleeps[0]).toBeGreaterThanOrEqual(750);
    expect(a.sleeps[0]).toBeLessThanOrEqual(825);

    server.reset();
    const date = new Date(Date.now() + 3_000).toUTCString();
    server.enqueue(
      { status: 503, headers: { 'retry-after': date }, json: {} },
      chatCompletion({ ok: true }),
    );
    const b = harness({ clock: { nowMs: () => Date.now() } });
    await b.provider.complete(request());
    expect(b.sleeps[0]).toBeGreaterThanOrEqual(1_000);
    expect(b.sleeps[0]).toBeLessThanOrEqual(3_400);
  });

  it('[NFR-REL-01] fails fast when the server asks for a longer wait than allowed', async () => {
    server.enqueue({
      status: 429,
      headers: { 'retry-after': '600' },
      json: { error: { code: 'rate_limit' } },
    });
    const { provider, sleeps } = harness();
    await expect(provider.complete(request())).rejects.toMatchObject({
      code: 'rate_limited',
      status: 429,
      retryAfterMs: 600_000,
    });
    expect(sleeps).toEqual([]);
    expect(server.requests).toHaveLength(1);
  });

  it('[NFR-REL-01] retries a 500 with jittered exponential backoff, then succeeds', async () => {
    server.enqueue(
      { status: 500, json: { error: { code: 'InternalServerError' } } },
      { status: 502, json: {} },
      chatCompletion({ ok: true }),
    );
    const { provider, sleeps } = harness({
      retry: { baseDelayMs: 100, maxDelayMs: 10_000, maxRetryAfterMs: 15_000 },
    });
    const response = await provider.complete(request());
    expect(response.attempts).toBe(3);
    expect(response.retries).toBe(2);
    // random() = 0.5 -> 0.75 x the exponential ceiling (100, then 200).
    expect(sleeps).toEqual([75, 150]);
  });

  it('[NFR-REL-01] stops after the bounded number of retries and reports a typed, sanitised error', async () => {
    server.setDefault({
      status: 500,
      json: { error: { code: 'InternalServerError', message: 'secret internal detail' } },
    });
    const { provider } = harness({ maxRetries: 2 });
    const error = await provider.complete(request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code: 'server_error', status: 500, attempts: 3 });
    expect((error as Error).message).not.toContain('secret internal detail');
    expect(server.requests).toHaveLength(3);
  });

  it('[NFR-REL-01] the per-request retry budget overrides the provider default', async () => {
    server.setDefault({ status: 503, json: {} });
    const { provider } = harness({ maxRetries: 5 });
    await expect(provider.complete(request({ maxRetries: 0 }))).rejects.toMatchObject({
      code: 'server_error',
      attempts: 1,
    });
    expect(server.requests).toHaveLength(1);
  });

  it('[NFR-REL-01] does not retry client errors', async () => {
    server.enqueue({ status: 400, json: { error: { code: 'invalid_request_error' } } });
    await expect(harness().provider.complete(request())).rejects.toMatchObject({
      code: 'bad_request',
      status: 400,
    });
    expect(server.requests).toHaveLength(1);

    server.reset();
    server.enqueue({ status: 403, json: { error: { code: 'AccessDenied' } } });
    await expect(harness().provider.complete(request())).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('[NFR-REL-01] retries when the connection drops, then succeeds', async () => {
    server.enqueue({ destroy: true }, chatCompletion({ ok: true }));
    const { provider } = harness();
    const response = await provider.complete(request());
    expect(response.attempts).toBe(2);
  });

  it('[NFR-REL-01] enforces the total deadline (timeout)', async () => {
    server.setDefault({ hold: true });
    const started = Date.now();
    await expect(harness().provider.complete(request({ timeoutMs: 200 }))).rejects.toMatchObject({
      code: 'timeout',
    });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('[NFR-REL-01] supports cancellation through an AbortSignal', async () => {
    server.setDefault({ hold: true });
    const controller = new AbortController();
    const pending = harness().provider.complete(
      request({ signal: controller.signal, timeoutMs: 10_000 }),
    );
    setTimeout(() => controller.abort(), 100);
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });

    const already = new AbortController();
    already.abort();
    await expect(
      harness().provider.complete(request({ signal: already.signal })),
    ).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('[NFR-REL-01] never follows redirects', async () => {
    server.setDefault({ status: 302, headers: { location: '/elsewhere' }, json: {} });
    await expect(harness({ maxRetries: 0 }).provider.complete(request())).rejects.toBeInstanceOf(
      ProviderError,
    );
    expect(server.requests.map((r) => r.path)).not.toContain('/elsewhere');
  });

  it('[NFR-SEC-05] maps content-filter verdicts (HTTP 400 and finish_reason) to a non-retryable typed error', async () => {
    server.enqueue({
      status: 400,
      json: {
        error: { code: 'content_filter', innererror: { code: 'ResponsibleAIPolicyViolation' } },
      },
    });
    await expect(harness().provider.complete(request())).rejects.toMatchObject({
      code: 'content_filtered',
    });
    expect(server.requests).toHaveLength(1);

    server.reset();
    server.enqueue(chatCompletion('', { finishReason: 'content_filter' }));
    await expect(harness().provider.complete(request())).rejects.toMatchObject({
      code: 'content_filtered',
    });
  });

  it('[NFR-SEC-05] rejects refusals and tool calls instead of passing them on', async () => {
    server.enqueue(chatCompletion('', { refusal: 'I cannot help with that.' }));
    await expect(harness().provider.complete(request())).rejects.toMatchObject({
      code: 'model_refusal',
    });

    server.reset();
    server.enqueue(
      chatCompletion('', {
        finishReason: 'tool_calls',
        toolCalls: [
          { id: 'call_1', type: 'function', function: { name: 'send_email', arguments: '{}' } },
        ],
      }),
    );
    await expect(harness().provider.complete(request())).rejects.toMatchObject({
      code: 'tool_call_blocked',
    });
  });

  it('[NFR-SEC-05] reports malformed or truncated JSON without throwing, so the caller can repair or fall back', async () => {
    server.enqueue(chatCompletion('{"ok": tru', { finishReason: 'length' }));
    const response = await harness().provider.complete(request());
    expect(response.output).toBeUndefined();
    expect(response.parseError).toMatch(/not valid JSON/);
    expect(response.finishReason).toBe('length');
    expect(response.outputText).toBe('{"ok": tru');
  });

  it('[NFR-SEC-05] tolerates a markdown fence around valid JSON but nothing else', async () => {
    server.enqueue(chatCompletion('```json\n{"ok": true}\n```'));
    await expect(harness().provider.complete(request())).resolves.toMatchObject({
      output: { ok: true },
    });
  });

  it('[NFR-SEC-05] caps the response size', async () => {
    server.enqueue({
      status: 200,
      text: JSON.stringify({ choices: [{ message: { content: 'x'.repeat(5_000) } }] }),
    });
    await expect(
      harness({ maxResponseBytes: 1_000 }).provider.complete(request()),
    ).rejects.toMatchObject({ code: 'response_too_large' });
  });

  it('[NFR-SEC-06] no secret ever appears in logs or errors, even if the service echoes it back', async () => {
    const echo = {
      error: { code: 'InternalServerError', message: `bad key ${API_KEY} and token ${TOKEN}` },
    };
    server.setDefault({ status: 500, headers: { 'x-echo': API_KEY }, json: echo });
    const { provider, logger } = harness({
      auth: { kind: 'api-key', apiKey: API_KEY },
      allowApiKey: true,
      maxRetries: 2,
    });
    const error = await provider.complete(request()).catch((e: unknown) => e);
    const serialised = JSON.stringify({
      error: {
        message: (error as Error).message,
        name: (error as Error).name,
        stack: (error as Error).stack,
      },
      logs: logger.entries,
    });
    expect(serialised).not.toContain(API_KEY);
    expect(serialised).not.toContain('SECRET');
    expect(logger.entries.length).toBeGreaterThan(0);

    server.reset();
    server.setDefault({ status: 500, json: echo });
    const bearer = harness({ maxRetries: 1 });
    const bearerError = await bearer.provider.complete(request()).catch((e: unknown) => e);
    expect(
      JSON.stringify({ m: (bearerError as Error).message, l: bearer.logger.entries }),
    ).not.toContain(TOKEN);
  });

  it('[NFR-SEC-03] validates the endpoint: https only (loopback excepted), no credentials, bare origin', () => {
    const base = {
      deployment: 'gpt-test',
      apiVersion: '2024-10-21',
      auth: { kind: 'api-key', apiKey: API_KEY } as const,
      allowApiKey: true,
    };
    expect(
      () => new AzureOpenAiProvider({ ...base, endpoint: 'http://contoso.openai.azure.com' }),
    ).toThrow(/https/);
    expect(
      () =>
        new AzureOpenAiProvider({
          ...base,
          endpoint: 'https://user:pass@contoso.openai.azure.com',
        }),
    ).toThrow(/credentials/);
    expect(
      () =>
        new AzureOpenAiProvider({
          ...base,
          endpoint: 'https://contoso.openai.azure.com/openai?x=1',
        }),
    ).toThrow(/bare origin/);
    expect(() => new AzureOpenAiProvider({ ...base, endpoint: 'not a url' })).toThrow(/valid URL/);
    expect(
      () => new AzureOpenAiProvider({ ...base, endpoint: 'https://contoso.openai.azure.com' }),
    ).not.toThrow();
    expect(
      () => new AzureOpenAiProvider({ ...base, endpoint: 'http://127.0.0.1:9' }),
    ).not.toThrow();
  });

  it('[FR-GV-01] reports honestly that it was validated against a local mock only', () => {
    const descriptor = harness().provider.describe();
    expect(descriptor.simulated).toBe(false);
    expect(descriptor.validationNote).toMatch(/local mock server only/i);
    expect(descriptor.validationNote).toMatch(/not been exercised against real Azure/i);
  });
});
