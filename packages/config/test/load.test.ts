import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, validateConfig } from '../src';
import { ENTRA_API, ENTRA_TENANT, PRODUCTION_ENV } from './fixtures';

/** Reads KEY=VALUE lines the way a dotenv loader would (comments and blank lines skipped). */
function parseDotenv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const equals = trimmed.indexOf('=');
    if (equals < 1) continue;
    env[trimmed.slice(0, equals)] = trimmed.slice(equals + 1);
  }
  return env;
}

describe('defaults', () => {
  it('[NFR-DX-01] an empty environment boots a safe local configuration', () => {
    const config = loadConfig({});
    expect(config.runtime).toMatchObject({
      env: 'local',
      localLike: true,
      deployed: false,
      production: false,
    });
    expect(config.http).toMatchObject({
      host: '0.0.0.0',
      port: 4000,
      corsAllowedOrigins: ['http://localhost:3000'],
    });
    expect(config.auth).toMatchObject({ mode: 'dev', devAuthEnabled: true, entra: null });
    expect(config.database).toMatchObject({
      kind: 'pglite',
      auth: 'password',
      autoMigrate: true,
      poolMax: 10,
    });
    expect(config.database.url.reveal()).toBe('pglite://.data/caseguard');
    expect(config.storage).toEqual({ provider: 'local', localDir: '.data/objects' });
    expect(config.search).toEqual({ provider: 'lexical' });
    expect(config.cache).toEqual({ provider: 'memory' });
    expect(config.ai.provider).toBe('deterministic');
    expect(config.ai.limits).toMatchObject({
      maxInputTokens: 24_000,
      maxOutputTokens: 4_000,
      timeoutMs: 30_000,
      maxRetries: 2,
      costLimitUsdPerDay: null,
      unitPriceInputPer1k: null,
      unitPriceOutputPer1k: null,
    });
    expect(config.limits).toEqual({
      rateLimitMax: 300,
      rateLimitWindowMs: 60_000,
      rateLimitAiMax: 30,
      malwareScanMode: 'none',
    });
    expect(config.http.bodyLimitBytes).toBe(1_048_576);
    expect(config.http.uploadMaxBytes).toBe(2_097_152);
    expect(config.demo).toEqual({ mode: true, autoSeed: true });
    expect(config.telemetry).toMatchObject({
      appInsightsConnectionString: null,
      otelServiceName: 'caseguard-api',
      otelSamplingRatio: 1,
    });
    expect(config.logLevel).toBe('info');
    expect(config.runtime.version).toBe('0.0.0-dev');
    expect(config.features).toMatchObject({ presentationMode: true, azureOpenAiProvider: false });
    expect(config.warnings).toEqual([]);
  });

  it('the test environment keeps demo routes but does not auto-seed', () => {
    const config = loadConfig({ APP_ENV: 'test' });
    expect(config.demo).toEqual({ mode: true, autoSeed: false });
    expect(config.auth.mode).toBe('dev');
  });

  it('a deployed environment defaults to Entra and strict settings', () => {
    const result = validateConfig({ APP_ENV: 'staging' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const variables = result.issues.map((i) => i.variable);
    expect(variables).toEqual(
      expect.arrayContaining([
        'ENTRA_TENANT_ID',
        'ENTRA_AUDIENCE',
        'ENTRA_TENANT_MAP',
        'CORS_ALLOWED_ORIGINS',
        'DATABASE_URL',
        'STORAGE_PROVIDER',
      ]),
    );
  });

  it('uses the entry point version when APP_VERSION is unset and lets APP_VERSION win', () => {
    expect(loadConfig({}, { defaultVersion: '1.2.3' }).runtime.version).toBe('1.2.3');
    expect(loadConfig({ APP_VERSION: '9.9.9' }, { defaultVersion: '1.2.3' }).runtime.version).toBe(
      '9.9.9',
    );
  });

  it('derives the OpenTelemetry service name from SERVICE_NAME', () => {
    expect(loadConfig({ SERVICE_NAME: 'caseguard-migrate' }).telemetry.otelServiceName).toBe(
      'caseguard-migrate',
    );
    expect(
      loadConfig({ SERVICE_NAME: 'a', OTEL_SERVICE_NAME: 'b' }).telemetry.otelServiceName,
    ).toBe('b');
  });

  it('freezes the configuration so it cannot be changed after start-up', () => {
    const config = loadConfig({});
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.http)).toBe(true);
    expect(() => {
      (config.http as { port: number }).port = 1;
    }).toThrow(TypeError);
  });
});

describe('real environments', () => {
  it('a complete production environment is accepted', () => {
    const config = loadConfig(PRODUCTION_ENV);
    expect(config.runtime.production).toBe(true);
    expect(config.auth.mode).toBe('entra');
    expect(config.auth.entra).toMatchObject({
      tenantId: ENTRA_TENANT,
      audience: `api://${ENTRA_API}`,
      issuer: `https://login.microsoftonline.com/${ENTRA_TENANT}/v2.0`,
      jwksUri: `https://login.microsoftonline.com/${ENTRA_TENANT}/discovery/v2.0/keys`,
    });
    expect(config.auth.entra?.tenantMap).toEqual({ [ENTRA_TENANT]: 'tenant_contoso_support' });
    expect(config.auth.entra?.roleMap['CaseGuard.Engineer']).toBe('engineer');
    expect(config.database).toMatchObject({ kind: 'postgres', auth: 'entra', autoMigrate: false });
    expect(config.storage).toEqual({
      provider: 'azure-blob',
      account: 'stcaseguardprod',
      container: 'cases',
    });
    expect(config.demo).toEqual({ mode: false, autoSeed: false });
  });

  it('accepts the environment the Container Apps template produces, including empty optional values', () => {
    const containerApps = {
      ...PRODUCTION_ENV,
      APP_ENV: 'production',
      APP_VERSION: '1.0.0',
      GIT_COMMIT: '0123456789abcdef',
      LOG_LEVEL: 'info',
      TRUST_PROXY: 'true',
      ENTRA_ROLE_MAP: JSON.stringify({
        'CaseGuard.Engineer': 'engineer',
        'CaseGuard.Reviewer': 'reviewer',
        'CaseGuard.Manager': 'manager',
        'CaseGuard.SkillCurator': 'skill_curator',
        'CaseGuard.Administrator': 'administrator',
      }),
      DB_AUTO_MIGRATE: 'false',
      DB_POOL_MAX: '5',
      AZURE_STORAGE_CONTAINER: 'cases',
      SEARCH_PROVIDER: 'lexical',
      AZURE_SEARCH_ENDPOINT: '',
      AZURE_SEARCH_INDEX: 'caseguard',
      CACHE_PROVIDER: 'memory',
      AI_PROVIDER: 'deterministic',
      AZURE_OPENAI_ENDPOINT: '',
      AZURE_OPENAI_DEPLOYMENT: '',
      AZURE_OPENAI_API_VERSION: '2024-10-21',
      AZURE_OPENAI_AUTH: '',
      AI_MAX_INPUT_TOKENS: '24000',
      AI_MAX_OUTPUT_TOKENS: '4000',
      AI_TIMEOUT_MS: '30000',
      AI_MAX_RETRIES: '2',
      AI_COST_LIMIT_USD_PER_DAY: '',
      AI_UNIT_PRICE_INPUT_PER_1K: '',
      AI_UNIT_PRICE_OUTPUT_PER_1K: '',
      OTEL_SAMPLING_RATIO: '1',
      APPLICATIONINSIGHTS_CONNECTION_STRING:
        'InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://example.test/',
      AZURE_CLIENT_ID: '00000000-0000-0000-0000-000000000001',
      SERVICE_NAME: 'caseguard-api',
      OTEL_SERVICE_NAME: 'caseguard-api',
      API_HOST: '0.0.0.0',
      API_PORT: '4000',
    };
    const config = loadConfig(containerApps);
    expect(config.search).toEqual({ provider: 'lexical' });
    expect(config.ai.provider).toBe('deterministic');
    expect(config.ai.limits.costLimitUsdPerDay).toBeNull();
    expect(config.auth.azureClientId).toBe('00000000-0000-0000-0000-000000000001');
    expect(config.telemetry.appInsightsConnectionString).not.toBeNull();
    expect(config.http.trustProxy).toBe(true);
  });

  it('accepts Azure OpenAI with managed identity and Azure AI Search', () => {
    const config = loadConfig({
      ...PRODUCTION_ENV,
      AI_PROVIDER: 'azure-openai',
      AZURE_OPENAI_ENDPOINT: 'https://example-openai.openai.azure.com/',
      AZURE_OPENAI_DEPLOYMENT: 'gpt-reasoning',
      SEARCH_PROVIDER: 'azure-ai-search',
      AZURE_SEARCH_ENDPOINT: 'https://example-search.search.windows.net',
      AI_COST_LIMIT_USD_PER_DAY: '25',
      AI_UNIT_PRICE_INPUT_PER_1K: '0.001',
      AI_UNIT_PRICE_OUTPUT_PER_1K: '0.002',
    });
    expect(config.ai).toMatchObject({
      provider: 'azure-openai',
      auth: 'managed-identity',
      apiVersion: '2024-10-21',
      apiKey: null,
    });
    expect(config.ai.limits).toMatchObject({
      costLimitUsdPerDay: 25,
      unitPriceInputPer1k: 0.001,
      unitPriceOutputPer1k: 0.002,
    });
    expect(config.search).toMatchObject({ provider: 'azure-ai-search', index: 'caseguard' });
    expect(config.features.azureOpenAiProvider).toBe(true);
  });

  it('[NFR-DX-01] the committed .env.example is a valid configuration', () => {
    const text = readFileSync(resolve(import.meta.dirname, '../../../.env.example'), 'utf8');
    const env = parseDotenv(text);
    expect(Object.keys(env).length).toBeGreaterThan(20);
    const config = loadConfig(env);
    expect(config.runtime.env).toBe('local');
    expect(config.auth.devAuthEnabled).toBe(true);
    expect(config.demo.autoSeed).toBe(true);
  });

  it('throws a ConfigError that lists every problem at once', () => {
    let caught: unknown;
    try {
      loadConfig({ APP_ENV: 'production', AUTH_MODE: 'dev' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const error = caught as ConfigError;
    expect(error.issues.length).toBeGreaterThan(3);
    expect(error.message).toMatch(/Invalid configuration \(\d+ problems\)/);
    expect(error.message).toContain('AUTH_MODE');
  });
});
