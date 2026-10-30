import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_CONFIG } from '@caseguard/schemas';
import {
  AiOrchestrator,
  AzureOpenAiProvider,
  ProviderError,
  type AzureOpenAiProviderOptions,
  type ModelRequest,
  type TokenCredential,
} from '../src';
import { FakeClock, capturingLogger, capturingMetrics } from './fakes';
import { MockAzureServer } from './mock-azure';
import { hypTask, one } from './orchestrator-harness';
import { classifierTask, coachTask, forkTask, qualityTask, timelineTask } from './tasks';

const TOKEN = 'eyJ-cause-test-SECRET-TOKEN-0123456789';

const SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: false,
};

function request(): ModelRequest {
  return {
    requestId: 'req_cause',
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
  };
}

const goodCredential: TokenCredential = {
  getToken: () => Promise.resolve({ token: TOKEN, expiresOnTimestamp: Date.now() + 3_600_000 }),
};

function providerWith(
  options: Partial<AzureOpenAiProviderOptions> & { credential?: TokenCredential },
) {
  const logger = capturingLogger();
  const { credential, ...rest } = options;
  const provider = new AzureOpenAiProvider({
    endpoint: 'https://secret-resource.openai.azure.com',
    deployment: 'gpt-test',
    apiVersion: '2024-10-21',
    auth: { kind: 'managed-identity', credential: credential ?? goodCredential },
    clock: new FakeClock(),
    logger,
    sleep: () => Promise.resolve(),
    random: () => 0.5,
    ...rest,
  });
  return { provider, logger };
}

const caught = async (promise: Promise<unknown>): Promise<ProviderError> => {
  const error = await promise.catch((e: unknown) => e);
  if (!(error instanceof ProviderError)) throw new Error('expected a ProviderError');
  return error;
};

describe('the cause of a failed call is kept, sanitised [NFR-OBS-01]', () => {
  it('[NFR-OBS-01] a DNS failure says so (ENOTFOUND) without naming the host', async () => {
    const dns = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND secret-resource.openai.azure.com'), {
        code: 'ENOTFOUND',
      }),
    });
    const { provider } = providerWith({ fetch: () => Promise.reject(dns), maxRetries: 0 });
    const error = await caught(provider.complete(request()));
    expect(error).toMatchObject({ code: 'network', causeCode: 'ENOTFOUND', attempts: 1 });
    expect(error.message).not.toContain('secret-resource');
  });

  it('[NFR-OBS-01] a refused connection and a TLS failure are told apart from DNS', async () => {
    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:443'), {
        code: 'ECONNREFUSED',
      }),
    });
    const tls = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' }),
    });
    for (const [failure, expected] of [
      [refused, 'ECONNREFUSED'],
      [tls, 'CERT_HAS_EXPIRED'],
    ] as const) {
      const { provider } = providerWith({ fetch: () => Promise.reject(failure), maxRetries: 0 });
      const error = await caught(provider.complete(request()));
      expect(error.causeCode).toBe(expected);
      expect(error.message).not.toMatch(/10\.1\.2\.3|certificate/);
    }
  });

  it('[NFR-OBS-01] a failure with no usable code has no cause code rather than a made-up one', async () => {
    const { provider } = providerWith({
      fetch: () => Promise.reject(new TypeError('fetch failed')),
      maxRetries: 0,
    });
    expect((await caught(provider.complete(request()))).causeCode).toBeNull();
  });

  it('[NFR-OBS-01] a managed-identity failure is told apart from a network failure, and leaks nothing', async () => {
    const credential: TokenCredential = {
      getToken: () =>
        Promise.reject(
          Object.assign(
            new Error(
              'No managed identity endpoint at http://169.254.169.254/metadata with secret-guid',
            ),
            { name: 'CredentialUnavailableError' },
          ),
        ),
    };
    const { provider } = providerWith({
      credential,
      fetch: () => Promise.reject(new Error('unused')),
    });
    const error = await caught(provider.complete(request()));
    expect(error).toMatchObject({ code: 'unauthorized', causeCode: 'CredentialUnavailableError' });
    expect(error.message).toBe('An Azure OpenAI access token could not be acquired.');
    expect(JSON.stringify(error.message)).not.toMatch(/169\.254|secret-guid/);
  });

  it('[NFR-OBS-01] an OAuth error code from the token service is kept; its description is not', async () => {
    const credential: TokenCredential = {
      getToken: () =>
        Promise.reject(
          Object.assign(
            new Error('AADSTS700016: Application with identifier secret-app-id was not found'),
            {
              name: 'AuthenticationError',
              errorResponse: {
                error: 'unauthorized_client',
                errorDescription: 'AADSTS700016: secret-app-id',
              },
            },
          ),
        ),
    };
    const { provider } = providerWith({
      credential,
      fetch: () => Promise.reject(new Error('unused')),
    });
    const error = await caught(provider.complete(request()));
    expect(error.causeCode).toBe('AuthenticationError:unauthorized_client');
    expect(error.message).not.toContain('secret-app-id');
  });

  it('[NFR-OBS-01] the retry log line carries the cause code of each failed attempt', async () => {
    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    });
    const { provider, logger } = providerWith({
      fetch: () => Promise.reject(refused),
      maxRetries: 2,
    });
    const error = await caught(provider.complete(request()));
    expect(error).toMatchObject({ code: 'network', causeCode: 'ECONNREFUSED', attempts: 3 });
    const retries = logger.entries.filter((e) => e.fields.event === 'ai.provider.retry');
    expect(retries).toHaveLength(2);
    for (const line of retries) {
      expect(line.fields).toMatchObject({ code: 'network', causeCode: 'ECONNREFUSED' });
    }
    expect(JSON.stringify(logger.entries)).not.toMatch(/secret-resource|https?:\/\//);
  });
});

describe('a deployment that does not exist, against the local mock server [NFR-REL-01]', () => {
  let server: MockAzureServer;
  beforeAll(async () => {
    server = await MockAzureServer.start();
  });
  afterAll(async () => {
    await server.stop();
  });
  beforeEach(() => {
    server.reset();
    server.setDefault({
      status: 404,
      json: {
        error: { code: 'DeploymentNotFound', message: 'The API deployment does not exist.' },
      },
    });
  });

  it('[NFR-OBS-01] the HTTP status and the service error code reach the typed error', async () => {
    const { provider } = providerWith({ endpoint: server.endpoint, maxRetries: 2 });
    const error = await caught(provider.complete(request()));
    expect(error).toMatchObject({
      code: 'bad_request',
      status: 404,
      causeCode: 'DeploymentNotFound',
      attempts: 1,
    });
    expect(server.requests).toHaveLength(1);
  });

  it('[NFR-REL-01] the orchestrator stops after three failing calls and says why, without leaking the endpoint or token', async () => {
    const clock = new FakeClock();
    const logger = capturingLogger();
    const metrics = capturingMetrics();
    const provider = new AzureOpenAiProvider({
      endpoint: server.endpoint,
      deployment: 'gpt-test',
      apiVersion: '2024-10-21',
      auth: { kind: 'managed-identity', credential: goodCredential },
      clock,
      logger,
      metrics,
      sleep: () => Promise.resolve(),
      random: () => 0.5,
    });
    const orchestrator = new AiOrchestrator({
      config: {
        ...DEFAULT_MODEL_CONFIG,
        provider: 'azure-openai',
        azureDeployment: 'gpt-test',
        routing: { defaultModel: 'gpt-test', cheapModel: null, rules: [] },
      },
      provider,
      clock,
      logger,
      metrics,
      random: () => 0.5,
    });

    const tasks = [
      hypTask,
      timelineTask(one),
      classifierTask(one),
      forkTask(one),
      qualityTask(one),
      coachTask(one),
    ];
    const statuses: string[] = [];
    for (const task of tasks) {
      statuses.push((await orchestrator.runAgentTask({ task })).modelExecution.status);
    }

    expect(server.requests).toHaveLength(3);
    expect(statuses).toEqual([
      'failed',
      'failed',
      'failed',
      'circuit_open',
      'circuit_open',
      'circuit_open',
    ]);
    const health = orchestrator.getHealth();
    expect(health).toMatchObject({ status: 'degraded', misconfigured: true });
    expect(health.provider.healthy).toBe(false);
    expect(health.provider.detail).toContain('HTTP 404');
    expect(health.provider.detail).toContain('DeploymentNotFound');
    expect(health.lastFailure).toMatchObject({
      code: 'bad_request',
      status: 404,
      causeCode: 'DeploymentNotFound',
      configurationFault: true,
    });

    const failures = logger.entries.filter((e) => e.fields.event === 'ai.provider.failure');
    expect(failures).toHaveLength(3);
    expect(failures[0]?.fields).toMatchObject({
      status: 404,
      causeCode: 'DeploymentNotFound',
      configurationFault: true,
    });
    const everything = JSON.stringify({
      logs: logger.entries.filter((e) => e.fields.event !== 'ai.model.execution'),
      health,
    });
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toMatch(/127\.0\.0\.1|https?:\/\//);
  }, 120_000);
});
