import type { AiHealth } from '@caseguard/ai';
import {
  ProviderStatusSchema,
  RequestMetricsSchema,
  SystemHealthSchema,
  type DependencyHealth,
} from '@caseguard/schemas';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../src/db';
import {
  TEST_DATABASE_STARTUP_TIMEOUT_MS,
  withFaultInjection,
  type FaultInjectingDatabase,
} from '../src/db/testing';
import { createAiService } from '../src/services/ai';
import type { AiPort } from '../src/services/ports';
import { PERSONAS, createHarness, openSharedDatabase, type Harness } from './support/app-harness';

const API = '/api/v1';
const AZURE_KEY = 'sk-test-never-appear-in-any-response-0123456789';
const AZURE_ENV = {
  AI_PROVIDER: 'azure-openai',
  AZURE_OPENAI_ENDPOINT: 'https://example-openai.openai.azure.com',
  AZURE_OPENAI_DEPLOYMENT: 'gpt-test',
  AZURE_OPENAI_AUTH: 'api-key',
  AZURE_OPENAI_API_KEY: AZURE_KEY,
  SEARCH_PROVIDER: 'azure-ai-search',
  AZURE_SEARCH_ENDPOINT: 'https://example-search.search.windows.net',
  AZURE_SEARCH_INDEX: 'caseguard-test',
};
const READERS = [PERSONAS.engineer, PERSONAS.reviewer, PERSONAS.manager, PERSONAS.admin];

let database: Database;
let faulty: FaultInjectingDatabase;
const harnesses: Harness[] = [];

/** Each test gets its own harness: health results and metrics live in per-harness registries. */
async function harness(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
  const created = await createHarness({ database: faulty, ...options });
  harnesses.push(created);
  return created;
}

beforeAll(async () => {
  database = await openSharedDatabase();
  faulty = withFaultInjection(database);
}, TEST_DATABASE_STARTUP_TIMEOUT_MS);

afterAll(async () => {
  faulty.disarm();
  for (const created of harnesses) await created.close();
  await database.close();
});

const byName = (dependencies: DependencyHealth[]) =>
  new Map(dependencies.map((dependency) => [dependency.name, dependency]));

describe('[NFR-OBS-01] system.health', () => {
  it('reports dependencies, migrations and the provider, labelling stand-ins simulated', async () => {
    const h = await harness();
    const res = await h.call(PERSONAS.engineer, { method: 'GET', url: `${API}/system/health` });
    expect(res.statusCode).toBe(200);
    const report = SystemHealthSchema.parse(res.data);

    const status = await h.infra.repos.migrationStatus();
    expect(report.migrations).toEqual({
      applied: status.applied.length,
      pending: 0,
      latest: status.latest,
    });
    expect(report.migrations.applied).toBeGreaterThanOrEqual(6);
    expect(report).toMatchObject({
      status: 'healthy',
      environment: 'test',
      service: 'caseguard-api',
      provider: { kind: 'deterministic', simulated: true, healthy: true },
    });

    const dependencies = byName(report.dependencies);
    // PGlite is an in-process stand-in for PostgreSQL and its row says so. Against a real server
    // (TEST_DATABASE_URL, as in CI) the same row describes a real dependency and is not simulated.
    const isPglite = database.kind === 'pglite';
    const databaseRow = dependencies.get('database');
    expect(databaseRow).toMatchObject({ status: 'healthy', simulated: isPglite });
    expect(databaseRow?.detail).toContain('reachable');
    expect(databaseRow?.detail.includes('PostgreSQL-compatible')).toBe(isPglite);
    expect(dependencies.get('migrations')).toMatchObject({ status: 'healthy', simulated: false });
    for (const standIn of ['storage', 'search', 'model_provider']) {
      expect(dependencies.get(standIn)).toMatchObject({ status: 'healthy', simulated: true });
    }
    expect(dependencies.has('ai-provider')).toBe(false);
    expect(dependencies.get('identity')).toMatchObject({ kind: 'identity', simulated: true });
    expect(dependencies.get('cache')).toMatchObject({ kind: 'cache', simulated: true });
    expect(
      report.notices.some((notice) =>
        notice.includes('"storage" is an in-process or synthetic stand-in'),
      ),
    ).toBe(true);
    expect(report.notices.some((notice) => notice.includes('deterministic evidence engine'))).toBe(
      true,
    );
  });

  it('is readable by every telemetry:read role and refused to the rest', async () => {
    const h = await harness();
    for (const persona of READERS) {
      expect(
        (await h.call(persona, { method: 'GET', url: `${API}/system/health` })).statusCode,
      ).toBe(200);
    }
    const res = await h.call(PERSONAS.curator, { method: 'GET', url: `${API}/system/health` });
    expect(res.statusCode).toBe(403);
    expect(res.data.code).toBe('forbidden');
    expect((await h.call(null, { method: 'GET', url: `${API}/system/health` })).statusCode).toBe(
      401,
    );
  });

  it('describes configured Azure integrations as unknown and validated against mocks only', async () => {
    const h = await harness({ env: AZURE_ENV });
    const res = await h.call(PERSONAS.manager, { method: 'GET', url: `${API}/system/health` });
    expect(res.statusCode).toBe(200);
    const report = SystemHealthSchema.parse(res.data);
    const dependencies = byName(report.dependencies);
    expect(dependencies.get('search')).toMatchObject({ status: 'unknown', simulated: false });
    expect(dependencies.get('search')?.detail).toContain('example-search.search.windows.net');
    // No model call has been made, so the AI service itself reports the provider as unknown.
    expect(dependencies.get('model_provider')).toMatchObject({
      status: 'unknown',
      simulated: false,
    });
    expect(report.provider).toMatchObject({
      kind: 'azure-openai',
      healthy: null,
      simulated: false,
    });
    expect(report.provider.detail).toContain('example-openai.openai.azure.com');
    const notices = report.notices.join('\n');
    expect(notices).toContain('validated against a local mock server only');
    expect(notices).toContain('validated against mocks only');
    expect(notices).toContain('populated externally');
    expect(res.body).not.toContain(AZURE_KEY);
  });

  it('shows the AI service’s runtime state: a degraded provider and its notes', async () => {
    const degraded: AiHealth = {
      status: 'degraded',
      provider: {
        kind: 'azure-openai',
        configured: true,
        healthy: true,
        model: 'gpt-test',
        simulated: false,
        checkedAt: '2026-01-15T09:00:00.000Z',
        detail: 'Circuit breaker is open; requests are served by deterministic code.',
        validationNote: 'Validated against a local mock server only.',
        limits: { maxInputTokens: 8_000, maxOutputTokens: 2_000, timeoutMs: 10_000, maxRetries: 1 },
      },
      dependency: {
        name: 'ai-provider',
        kind: 'ai_provider',
        status: 'degraded',
        latencyMs: null,
        detail: 'Circuit breaker is open; requests are served by deterministic code.',
        checkedAt: '2026-01-15T09:00:00.000Z',
        simulated: false,
      },
      breakers: [{ name: 'azure-openai', state: 'open', consecutiveFailures: 5, openedAt: null }],
      bulkhead: { name: 'ai', active: 0, queued: 0, rejected: 0, maxConcurrent: 4, maxQueue: 16 },
      cache: {
        enabled: true,
        hits: 0,
        exactHits: 0,
        nearHits: 0,
        misses: 0,
        expirations: 0,
        evictions: 0,
        size: 0,
      },
      degraded: true,
      degradedReason: 'Circuit breaker is open; requests are served by deterministic code.',
      notes: ['Last fallback to deterministic code: provider timeout at 2026-01-15T08:59:00.000Z.'],
    };
    const ai: AiPort = {
      run: async () => {
        throw new Error('not used by the system routes');
      },
      status: async () => degraded.provider,
      health: async () => degraded,
    };
    const h = await harness({ env: AZURE_ENV, services: { ai } });
    const res = await h.call(PERSONAS.engineer, { method: 'GET', url: `${API}/system/health` });
    const report = SystemHealthSchema.parse(res.data);
    expect(byName(report.dependencies).get('model_provider')).toMatchObject({
      status: 'degraded',
      simulated: false,
    });
    expect(report.provider.limits).toEqual(degraded.provider.limits);
    expect(report.notices).toContain(degraded.notes[0]);
  });

  it('still answers, and says so, when the AI service cannot report', async () => {
    const ai: AiPort = {
      run: async () => {
        throw new Error('not used by the system routes');
      },
      status: async () => {
        throw new Error(
          `cannot build provider for ${AZURE_ENV.AZURE_OPENAI_ENDPOINT} key ${AZURE_KEY}`,
        );
      },
      health: async () => {
        throw new Error(
          `cannot build provider for ${AZURE_ENV.AZURE_OPENAI_ENDPOINT} key ${AZURE_KEY}`,
        );
      },
    };
    const h = await harness({ env: AZURE_ENV, services: { ai } });
    const health = await h.call(PERSONAS.engineer, { method: 'GET', url: `${API}/system/health` });
    expect(health.statusCode).toBe(200);
    const report = SystemHealthSchema.parse(health.data);
    expect(report.provider).toMatchObject({ kind: 'azure-openai', healthy: false });
    expect(byName(report.dependencies).get('model_provider')).toMatchObject({
      status: 'unhealthy',
    });
    expect(health.body).not.toContain(AZURE_KEY);
    expect(health.body).not.toContain('cannot build provider');

    const provider = await h.call(PERSONAS.engineer, {
      method: 'GET',
      url: `${API}/system/provider`,
    });
    expect(provider.statusCode).toBe(200);
    expect(ProviderStatusSchema.parse(provider.data)).toMatchObject({
      healthy: false,
      kind: 'azure-openai',
    });
    expect(provider.body).not.toContain(AZURE_KEY);
  });

  it('still answers, and says so, when the migration table cannot be read', async () => {
    const h = await harness();
    faulty.arm({ match: /FROM schema_migrations/i });
    try {
      const res = await h.call(PERSONAS.engineer, { method: 'GET', url: `${API}/system/health` });
      expect(res.statusCode).toBe(200);
      const report = SystemHealthSchema.parse(res.data);
      expect(report.status).toBe('unhealthy');
      expect(report.migrations).toEqual({ applied: 0, pending: 0, latest: null });
      expect(byName(report.dependencies).get('migrations')?.status).toBe('unhealthy');
      expect(
        report.notices.some((notice) => notice.includes('Migration status is unavailable')),
      ).toBe(true);
      // The registry's own check detail is a scrubbed one-liner; the notice added here carries no error text.
      expect(report.notices.join(' ')).not.toContain('injected failure');
    } finally {
      faulty.disarm();
    }
  });
});

describe('[NFR-OBS-01] system.metrics', () => {
  it('reports in-process counters since the process started, including security events', async () => {
    const h = await harness();
    await h.call(PERSONAS.engineer, { method: 'GET', url: `${API}/me` });
    await h.call(PERSONAS.engineer, { method: 'GET', url: `${API}/me` });
    await h.call(PERSONAS.engineer, { method: 'GET', url: `${API}/governance/settings` });
    await h.call(null, { method: 'GET', url: `${API}/me` });

    const res = await h.call(PERSONAS.engineer, { method: 'GET', url: `${API}/system/metrics` });
    expect(res.statusCode).toBe(200);
    const metrics = RequestMetricsSchema.parse(res.data);
    expect(metrics.since).toBe('2026-01-15T09:00:00.000Z');
    expect(metrics.totalRequests).toBeGreaterThanOrEqual(4);
    expect(metrics.errorRequests).toBe(0);
    expect(metrics.errorRate).toBe(0);
    expect(metrics.securityEvents).toMatchObject({ forbidden: 1, authFailures: 1 });
    const me = metrics.byRoute.find(
      (entry) => entry.route === `${API}/me` && entry.method === 'GET',
    );
    expect(me?.count).toBe(3);
    expect(metrics.modelExecutions).toEqual({ total: 0, failures: 0, avgLatencyMs: 0 });
  });

  it('is limited to telemetry:read holders', async () => {
    const h = await harness();
    for (const persona of READERS) {
      expect(
        (await h.call(persona, { method: 'GET', url: `${API}/system/metrics` })).statusCode,
      ).toBe(200);
    }
    expect(
      (await h.call(PERSONAS.curator, { method: 'GET', url: `${API}/system/metrics` })).statusCode,
    ).toBe(403);
    expect((await h.call(null, { method: 'GET', url: `${API}/system/metrics` })).statusCode).toBe(
      401,
    );
  });
});

describe('[FR-TK-03] system.provider', () => {
  it('reports the deterministic engine as simulated, in-process, with no network and no model', async () => {
    const h = await harness();
    const res = await h.call(PERSONAS.engineer, { method: 'GET', url: `${API}/system/provider` });
    expect(res.statusCode).toBe(200);
    const status = ProviderStatusSchema.parse(res.data);
    expect(status).toMatchObject({
      kind: 'deterministic',
      configured: true,
      simulated: true,
      healthy: true,
      model: 'deterministic-knowledge-pack',
    });
    expect(status.detail.toLowerCase()).toContain('no network call');
    expect(status.detail.toLowerCase()).toContain('no language model');
    expect(status.limits).toMatchObject({
      maxInputTokens: 24_000,
      maxOutputTokens: 4_000,
      timeoutMs: 30_000,
      maxRetries: 2,
    });
  });

  it('reports effective limits: the governed model settings tightened by the deployment', async () => {
    const h = await harness({ env: { AI_MAX_INPUT_TOKENS: '16000' } });
    const res = await h.call(PERSONAS.engineer, { method: 'GET', url: `${API}/system/provider` });
    expect(ProviderStatusSchema.parse(res.data).limits.maxInputTokens).toBe(16_000);
  });

  it('reports Azure OpenAI by host, deployment, auth mode and limits - never keys - with a mocks-only note', async () => {
    const h = await harness({ env: AZURE_ENV });
    const res = await h.call(PERSONAS.reviewer, { method: 'GET', url: `${API}/system/provider` });
    expect(res.statusCode).toBe(200);
    const status = ProviderStatusSchema.parse(res.data);
    expect(status).toMatchObject({
      kind: 'azure-openai',
      simulated: false,
      healthy: null,
      model: 'gpt-test',
    });
    expect(status.detail).toContain('example-openai.openai.azure.com');
    expect(status.detail).toContain('gpt-test');
    expect(status.detail).toContain('API-key authentication');
    expect(status.validationNote).toContain('validated against a local mock server only');
    expect(res.body).not.toContain(AZURE_KEY);
  });

  it('reports a provider that could not be created as not healthy, serving deterministic code, without echoing the endpoint', async () => {
    const h = await harness({ env: AZURE_ENV });
    // Configuration refuses endpoints the provider would refuse, so the failure is injected: the real
    // service, with a factory that fails and a message that names the endpoint and the key.
    Object.assign(h.infra.services, {
      ai: createAiService(h.infra, {
        providerFactory: async () => {
          throw new Error(
            `cannot build provider for ${AZURE_ENV.AZURE_OPENAI_ENDPOINT} key ${AZURE_KEY}`,
          );
        },
      }),
    });
    const res = await h.call(PERSONAS.reviewer, { method: 'GET', url: `${API}/system/provider` });
    expect(res.statusCode).toBe(200);
    const status = ProviderStatusSchema.parse(res.data);
    expect(status).toMatchObject({ kind: 'deterministic', simulated: true, healthy: false });
    expect(status.detail).toContain('could not be created');
    expect(res.body).not.toContain('cannot build provider');
    expect(res.body).not.toContain(AZURE_KEY);

    const health = SystemHealthSchema.parse(
      (await h.call(PERSONAS.reviewer, { method: 'GET', url: `${API}/system/health` })).data,
    );
    expect(byName(health.dependencies).get('model_provider')).toMatchObject({
      status: 'degraded',
      simulated: true,
    });
  });

  it('is limited to telemetry:read holders', async () => {
    const h = await harness();
    expect(
      (await h.call(PERSONAS.curator, { method: 'GET', url: `${API}/system/provider` })).statusCode,
    ).toBe(403);
    expect((await h.call(null, { method: 'GET', url: `${API}/system/provider` })).statusCode).toBe(
      401,
    );
  });
});
