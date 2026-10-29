import type { AiHealth } from '@caseguard/ai';
import { loadConfig, type AppConfig } from '@caseguard/config';
import { HealthRegistry } from '@caseguard/observability';
import {
  ProviderStatusSchema,
  SystemHealthSchema,
  type DependencyHealth,
  type ProviderStatus,
} from '@caseguard/schemas';
import { describe, expect, it, vi } from 'vitest';
import type { MigrationStatus } from '../src/db';
import { reconcileDependencies } from '../src/services/system/dependencies';
import { buildSystemHealth } from '../src/services/system/health';
import { integrationNotices } from '../src/services/system/notices';
import {
  configurationFacts,
  describeProvider,
  hostOf,
  unavailableProvider,
  withConfiguration,
} from '../src/services/system/provider-status';

const BASE_ENV = { APP_ENV: 'test', DATABASE_URL: 'pglite://memory' };
const config = (extra: Record<string, string> = {}): AppConfig =>
  loadConfig({ ...BASE_ENV, ...extra });

const AZURE_KEY = 'sk-test-never-appear-in-any-status-0123456789';
const AZURE_ENV = {
  AI_PROVIDER: 'azure-openai',
  AZURE_OPENAI_ENDPOINT: 'https://example-openai.openai.azure.com',
  AZURE_OPENAI_DEPLOYMENT: 'gpt-test',
  AZURE_OPENAI_AUTH: 'api-key',
  AZURE_OPENAI_API_KEY: AZURE_KEY,
  AI_MAX_INPUT_TOKENS: '12000',
};
const SEARCH_ENV = {
  SEARCH_PROVIDER: 'azure-ai-search',
  AZURE_SEARCH_ENDPOINT: 'https://example-search.search.windows.net',
  AZURE_SEARCH_INDEX: 'caseguard-test',
};
const ENTRA_ENV = {
  AUTH_MODE: 'entra',
  ENTRA_TENANT_ID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  ENTRA_AUDIENCE: 'api://caseguard-test',
  ENTRA_TENANT_MAP: '{"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa":"tenant_contoso_support"}',
};

const NOW = new Date('2026-01-15T09:00:00.000Z');
const AT = NOW.toISOString();

describe('[FR-TK-03] provider status from configuration (pure)', () => {
  it('describes the deterministic engine as simulated, in-process, with no network and no model', () => {
    const status = describeProvider(config().ai, NOW);
    expect(ProviderStatusSchema.parse(status)).toEqual(status);
    expect(status).toMatchObject({
      kind: 'deterministic',
      configured: true,
      healthy: true,
      simulated: true,
      model: 'deterministic-knowledge-pack',
      checkedAt: AT,
    });
    expect(status.detail.toLowerCase()).toContain('no network call');
    expect(status.detail.toLowerCase()).toContain('no language model');
    expect(status.limits).toEqual({
      maxInputTokens: 24_000,
      maxOutputTokens: 4_000,
      timeoutMs: 30_000,
      maxRetries: 2,
    });
  });

  it('describes Azure OpenAI by host, deployment, auth mode and limits - never a key or a path', () => {
    const status = describeProvider(config(AZURE_ENV).ai, NOW);
    expect(ProviderStatusSchema.parse(status)).toEqual(status);
    expect(status).toMatchObject({
      kind: 'azure-openai',
      configured: true,
      healthy: null,
      simulated: false,
      model: 'gpt-test',
    });
    expect(status.detail).toContain('example-openai.openai.azure.com');
    expect(status.detail).toContain('gpt-test');
    expect(status.detail).toContain('API-key');
    expect(status.limits.maxInputTokens).toBe(12_000);
    expect(status.validationNote.toLowerCase()).toContain('mock');
    expect(status.validationNote.toLowerCase()).toContain('not been exercised against real azure');
    expect(JSON.stringify(status)).not.toContain(AZURE_KEY);
  });

  it('names managed identity when that is the configured authentication', () => {
    const managed = config({
      ...AZURE_ENV,
      AZURE_OPENAI_AUTH: 'managed-identity',
      AZURE_OPENAI_API_KEY: '',
    });
    expect(configurationFacts(managed.ai)).toContain('managed-identity');
  });

  it('shows only the host of an endpoint', () => {
    expect(hostOf('https://user:pass@host.example.net:8443/path?q=1')).toBe(
      'host.example.net:8443',
    );
    expect(hostOf('not a url')).toBe('(unparseable endpoint)');
  });

  it('adds the configuration facts to a runtime status once and keeps the 400-character bound', () => {
    const runtime: ProviderStatus = {
      ...describeProvider(config(AZURE_ENV).ai, NOW),
      detail: 'Last call succeeded 5s ago.',
    };
    const once = withConfiguration(runtime, config(AZURE_ENV).ai);
    expect(once.detail).toBe(
      `Last call succeeded 5s ago. Endpoint example-openai.openai.azure.com, deployment "gpt-test", API-key authentication (local experiments only).`,
    );
    expect(withConfiguration(once, config(AZURE_ENV).ai)).toBe(once);

    const long = withConfiguration({ ...runtime, detail: 'x'.repeat(390) }, config(AZURE_ENV).ai);
    expect(long.detail.length).toBeLessThanOrEqual(400);
    expect(ProviderStatusSchema.parse(long)).toEqual(long);

    const deterministic = withConfiguration(
      { ...describeProvider(config().ai, NOW), detail: 'Offline.' },
      config().ai,
    );
    expect(deterministic.detail).toBe(
      'Offline. Runs in-process: no network call and no language model.',
    );
  });

  it('flags an unavailable provider as not healthy without any error text', () => {
    const status = unavailableProvider(config(AZURE_ENV).ai, NOW);
    expect(ProviderStatusSchema.parse(status)).toEqual(status);
    expect(status).toMatchObject({ kind: 'azure-openai', healthy: false, simulated: false });
    expect(status.detail).toContain('could not be initialised');
    expect(status.detail).toContain('example-openai.openai.azure.com');
    const deterministic = unavailableProvider(config().ai, NOW);
    expect(deterministic).toMatchObject({ kind: 'deterministic', healthy: false, simulated: true });
  });
});

const row = (overrides: Partial<DependencyHealth>): DependencyHealth => ({
  name: 'search',
  kind: 'search',
  status: 'healthy',
  latencyMs: 1,
  detail: 'ok',
  checkedAt: AT,
  simulated: false,
  ...overrides,
});

function aiHealth(overrides: Partial<AiHealth> = {}, ai: AppConfig['ai'] = config().ai): AiHealth {
  const provider = describeProvider(ai, NOW);
  return {
    status: 'healthy',
    provider,
    dependency: {
      name: 'ai-provider',
      kind: 'ai_provider',
      status: 'healthy',
      latencyMs: 12,
      detail: provider.detail,
      checkedAt: AT,
      simulated: provider.simulated,
    },
    breakers: [],
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
    degraded: false,
    degradedReason: null,
    notes: [],
    ...overrides,
  };
}

describe('[NFR-OBS-01] dependency reconciliation (pure)', () => {
  const disabledSearch = row({
    name: 'search',
    status: 'disabled',
    latencyMs: null,
    detail: 'Not enabled in this environment.',
  });
  const disabledModel = row({
    name: 'model_provider',
    kind: 'ai_provider',
    status: 'disabled',
    latencyMs: null,
  });

  it('takes the model-provider row from the AI service under the registry name', () => {
    const azure = config({ ...AZURE_ENV, ...SEARCH_ENV });
    const degraded = aiHealth(
      {
        status: 'degraded',
        dependency: {
          name: 'ai-provider',
          kind: 'ai_provider',
          status: 'degraded',
          latencyMs: null,
          detail: 'Circuit breaker is open; requests are served by deterministic code.',
          checkedAt: AT,
          simulated: false,
        },
      },
      azure.ai,
    );
    const result = reconcileDependencies([disabledSearch, disabledModel], azure, AT, degraded);
    const model = result.find((entry) => entry.name === 'model_provider');
    expect(model).toMatchObject({ kind: 'ai_provider', status: 'degraded', simulated: false });
    expect(model?.detail).toContain('Circuit breaker is open');
    expect(result.some((entry) => entry.name === 'ai-provider')).toBe(false);
  });

  it('keeps a healthy simulated deterministic row simulated', () => {
    const standIn = row({ name: 'model_provider', kind: 'ai_provider', simulated: true });
    const result = reconcileDependencies([standIn], config(), AT, aiHealth());
    expect(result[0]).toMatchObject({ name: 'model_provider', status: 'healthy', simulated: true });
  });

  it('reports an unavailable AI service as unhealthy, simulated only for the deterministic engine', () => {
    const deterministic = reconcileDependencies([disabledModel], config(), AT, null);
    expect(deterministic[0]).toMatchObject({ status: 'unhealthy', simulated: true });
    expect(deterministic[0]?.detail).toContain('could not be initialised');
    const azure = reconcileDependencies([disabledModel], config(AZURE_ENV), AT, null);
    expect(azure[0]).toMatchObject({ status: 'unhealthy', simulated: false });
  });

  it('adds a model-provider row when the registry has none', () => {
    const result = reconcileDependencies([], config(), AT, aiHealth());
    expect(result.map((entry) => entry.name)).toEqual(['model_provider', 'cache', 'identity']);
  });

  it('marks a configured-but-unprobed Azure AI Search unknown, never healthy or disabled', () => {
    const result = reconcileDependencies(
      [disabledSearch],
      config({ ...AZURE_ENV, ...SEARCH_ENV }),
      AT,
      aiHealth(),
    );
    const search = result.find((entry) => entry.name === 'search');
    expect(search).toMatchObject({ status: 'unknown', simulated: false, latencyMs: null });
    expect(search?.detail).toContain('example-search.search.windows.net');
    expect(search?.detail).toContain('caseguard-test');
    expect(search?.detail).toContain('validated against mocks only');
  });

  it('leaves stand-ins and unconfigured disabled checks as they are', () => {
    const standIn = row({ name: 'search', status: 'healthy', simulated: true });
    expect(reconcileDependencies([standIn], config(), AT, aiHealth())[0]).toBe(standIn);
    expect(reconcileDependencies([disabledSearch], config(), AT, aiHealth())[0]).toBe(
      disabledSearch,
    );
  });

  it('adds cache and identity rows once (dev personas are simulated, Entra is unknown)', () => {
    const dev = reconcileDependencies([], config(), AT, aiHealth());
    expect(dev.find((entry) => entry.name === 'identity')).toMatchObject({
      kind: 'identity',
      status: 'healthy',
      simulated: true,
    });
    expect(dev.find((entry) => entry.name === 'cache')).toMatchObject({
      kind: 'cache',
      simulated: true,
    });
    const entra = reconcileDependencies([], config(ENTRA_ENV), AT, aiHealth());
    expect(entra.find((entry) => entry.name === 'identity')).toMatchObject({
      status: 'unknown',
      simulated: false,
    });
    const present = reconcileDependencies(
      [row({ name: 'cache', kind: 'cache' })],
      config(),
      AT,
      aiHealth(),
    );
    expect(present.filter((entry) => entry.name === 'cache')).toHaveLength(1);
  });
});

describe('[NFR-OBS-01] integration notices (pure)', () => {
  it('says the deterministic engine and lexical search are what runs by default', () => {
    const notices = integrationNotices(config()).join('\n').toLowerCase();
    expect(notices).toContain('deterministic evidence engine');
    expect(notices).toContain('lexical');
    expect(notices).toContain('development sign-in');
  });

  it('describes every configured external integration as validated against mocks only', () => {
    const notices = integrationNotices(
      config({
        ...AZURE_ENV,
        ...SEARCH_ENV,
        STORAGE_PROVIDER: 'azure-blob',
        AZURE_STORAGE_ACCOUNT: 'caseguardtest',
        ...ENTRA_ENV,
        DATABASE_URL: 'postgres://app@db.example.invalid:5432/caseguard',
      }),
    ).join('\n');
    expect(notices).toContain('validated against a local mock server only');
    expect(notices).toContain('validated against mocks only');
    expect(notices).toContain('validated against a local fake client only');
    expect(notices).toContain('locally generated keys only');
    expect(notices).toContain('PGlite');
  });
});

describe('[NFR-OBS-01] system.health (registry-backed, no database)', () => {
  const status = (overrides: Partial<MigrationStatus> = {}): MigrationStatus => ({
    applied: [
      { name: '0001_foundation', checksum: 'a', appliedAt: AT },
      { name: '0002_tenancy', checksum: 'b', appliedAt: AT },
    ],
    pending: ['0003_cases'],
    latest: '0002_tenancy',
    checksumMismatch: [],
    ...overrides,
  });

  function registry(): HealthRegistry {
    const health = new HealthRegistry({
      service: 'caseguard-api',
      version: '0.0.0-test',
      environment: 'test',
      clock: () => NOW.getTime(),
    });
    health.registerStandard('database', () => ({ detail: 'pglite reachable' }));
    health.registerStandard('storage', () => ({ detail: 'local object store reachable' }), {
      simulated: true,
    });
    health.registerStandard('search', () => ({ detail: 'lexical search runs in-process' }), {
      simulated: true,
    });
    health.registerStandard('modelProvider', () => ({ detail: 'deterministic engine' }), {
      simulated: true,
    });
    return health;
  }

  const deps = (
    overrides: { config?: AppConfig; migrationStatus?: () => Promise<MigrationStatus> } = {},
  ) => ({
    config: overrides.config ?? config(),
    health: registry(),
    repos: { migrationStatus: overrides.migrationStatus ?? (async () => status()) },
    logger: { warn: vi.fn() },
    now: () => NOW,
  });

  it('reports counts, labels stand-ins simulated and validates against the contract', async () => {
    const input = deps();
    const report = await buildSystemHealth(input, aiHealth());
    expect(SystemHealthSchema.parse(report)).toEqual(report);
    expect(report.migrations).toEqual({ applied: 2, pending: 1, latest: '0002_tenancy' });
    expect(report.provider.kind).toBe('deterministic');
    expect(report.provider.detail).toContain('no network call and no language model');
    const byName = new Map(report.dependencies.map((entry) => [entry.name, entry]));
    expect(byName.get('database')).toMatchObject({ status: 'healthy', simulated: false });
    expect(byName.get('storage')).toMatchObject({ simulated: true });
    expect(byName.get('search')).toMatchObject({ simulated: true });
    expect(byName.get('model_provider')).toMatchObject({ status: 'healthy', simulated: true });
    expect(byName.has('identity')).toBe(true);
    expect(byName.has('cache')).toBe(true);
    expect(report.notices.some((notice) => notice.includes('stand-in'))).toBe(true);
    expect(report.notices.some((notice) => notice.includes('deterministic evidence engine'))).toBe(
      true,
    );
    expect(input.logger.warn).not.toHaveBeenCalled();
  });

  it('carries the AI service’s runtime state and notes into the report', async () => {
    const azure = config({ ...AZURE_ENV, ...SEARCH_ENV });
    const ai = aiHealth(
      {
        status: 'degraded',
        degraded: true,
        degradedReason: 'Circuit breaker is open.',
        dependency: {
          name: 'ai-provider',
          kind: 'ai_provider',
          status: 'degraded',
          latencyMs: null,
          detail: 'Circuit breaker is open; requests are served by deterministic code.',
          checkedAt: AT,
          simulated: false,
        },
        notes: ['Last fallback to deterministic code: timeout.'],
      },
      azure.ai,
    );
    const report = await buildSystemHealth(deps({ config: azure }), ai);
    expect(SystemHealthSchema.parse(report)).toEqual(report);
    expect(report.provider).toMatchObject({ kind: 'azure-openai', simulated: false });
    expect(report.provider.detail).toContain('example-openai.openai.azure.com');
    const byName = new Map(report.dependencies.map((entry) => [entry.name, entry]));
    expect(byName.get('model_provider')).toMatchObject({ status: 'degraded', simulated: false });
    expect(byName.get('search')?.status).toBe('healthy');
    expect(report.notices).toContain('Last fallback to deterministic code: timeout.');
    expect(
      report.notices.filter((notice) =>
        notice.includes('validated against a local mock server only'),
      ),
    ).toHaveLength(1);
  });

  it('reports an AI service that could not initialise as unhealthy, still answering', async () => {
    const report = await buildSystemHealth(deps({ config: config(AZURE_ENV) }), null);
    expect(SystemHealthSchema.parse(report)).toEqual(report);
    expect(report.provider).toMatchObject({ healthy: false, kind: 'azure-openai' });
    expect(
      new Map(report.dependencies.map((entry) => [entry.name, entry])).get('model_provider'),
    ).toMatchObject({
      status: 'unhealthy',
    });
    expect(report.notices.some((notice) => notice.includes('could not be initialised'))).toBe(true);
    expect(JSON.stringify(report)).not.toContain(AZURE_KEY);
  });

  it('still answers when the database cannot be queried for migration status', async () => {
    const input = deps({
      migrationStatus: async () => {
        throw new Error('connection refused to db.internal:5432 password=hunter2');
      },
    });
    const report = await buildSystemHealth(input, aiHealth());
    expect(SystemHealthSchema.parse(report)).toEqual(report);
    expect(report.migrations).toEqual({ applied: 0, pending: 0, latest: null });
    expect(
      report.notices.some((notice) => notice.includes('Migration status is unavailable')),
    ).toBe(true);
    expect(JSON.stringify(report)).not.toContain('hunter2');
    expect(input.logger.warn).toHaveBeenCalledTimes(1);
  });

  it('warns when an applied migration changed after it ran', async () => {
    const report = await buildSystemHealth(
      deps({ migrationStatus: async () => status({ checksumMismatch: ['0001_foundation'] }) }),
      aiHealth(),
    );
    expect(report.notices.some((notice) => notice.includes('changed after they ran'))).toBe(true);
  });
});
