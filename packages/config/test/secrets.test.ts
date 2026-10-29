import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  REDACTED,
  Secret,
  describeConfig,
  isSecret,
  loadConfig,
  redactSecretsInText,
  validateConfig,
} from '../src';
import { PRODUCTION_ENV } from './fixtures';

// Obviously fake values that look like what must never leak.
const DB_PASSWORD = 'pw-9f3a7c1e-fake';
const API_KEY = 'key-1b2c3d4e5f-fake';
const INSIGHTS =
  'InstrumentationKey=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa;IngestionEndpoint=https://example.test/';

const secretEnv = {
  APP_ENV: 'local',
  DATABASE_URL: `postgres://caseguard_app:${DB_PASSWORD}@db.example.test:5432/caseguard?sslmode=require`,
  AI_PROVIDER: 'azure-openai',
  AZURE_OPENAI_ENDPOINT: 'https://x.openai.azure.com',
  AZURE_OPENAI_DEPLOYMENT: 'deployment-1',
  AZURE_OPENAI_AUTH: 'api-key',
  AZURE_OPENAI_API_KEY: API_KEY,
  APPLICATIONINSIGHTS_CONNECTION_STRING: INSIGHTS,
};

describe('[NFR-SEC-06] secrets never leak from the configuration', () => {
  const config = loadConfig(secretEnv);
  const forbidden = [DB_PASSWORD, API_KEY, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'];

  it('the Secret wrapper hides its value from every default rendering', () => {
    const secret = new Secret(API_KEY);
    expect(secret.reveal()).toBe(API_KEY);
    expect(String(secret)).toBe(REDACTED);
    expect(`${secret.toString()}`).toBe(REDACTED);
    expect(JSON.stringify({ secret })).toBe(`{"secret":"${REDACTED}"}`);
    expect(inspect(secret)).toBe(`Secret(${REDACTED})`);
    expect(inspect({ nested: { secret } }, { depth: 5 })).not.toContain(API_KEY);
    expect(Object.keys(secret)).toEqual([]);
    expect(isSecret(secret)).toBe(true);
    expect(isSecret(API_KEY)).toBe(false);
  });

  it('JSON, util.inspect and structuredClone of the whole configuration contain no secret', () => {
    const rendered = [
      JSON.stringify(config),
      inspect(config, { depth: 10 }),
      JSON.stringify(structuredClone(config)),
    ].join('\n');
    for (const value of forbidden) expect(rendered).not.toContain(value);
  });

  it('the values are still available to the code that needs them', () => {
    expect(config.database.url.reveal()).toContain(DB_PASSWORD);
    expect(config.ai.provider === 'azure-openai' && config.ai.apiKey?.reveal()).toBe(API_KEY);
    expect(config.telemetry.appInsightsConnectionString?.reveal()).toBe(INSIGHTS);
  });

  it('the log-safe summary names what is configured without any credential', () => {
    const summary = describeConfig(config);
    const text = JSON.stringify(summary);
    for (const value of forbidden) expect(text).not.toContain(value);
    expect(summary.database.target).toBe(
      'postgres://caseguard_app@db.example.test:5432/caseguard?sslmode=require',
    );
    expect(summary.ai).toMatchObject({
      provider: 'azure-openai',
      auth: 'api-key',
      credentialConfigured: true,
    });
    expect(summary.telemetry.applicationInsights).toBe(true);
  });

  it('validation errors name the variable but never echo the offending value', () => {
    const hostile = {
      API_PORT: `hunter2-${API_KEY}`,
      DATABASE_URL: `mysql://user:${DB_PASSWORD}@host/db`,
      LOG_LEVEL: API_KEY,
      AZURE_OPENAI_AUTH: API_KEY,
      OTEL_SAMPLING_RATIO: API_KEY,
      APPLICATIONINSIGHTS_CONNECTION_STRING: `bad-${INSIGHTS.replace('InstrumentationKey=', 'Key=')}`,
    };
    const result = validateConfig(hostile);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const text = JSON.stringify(result.issues);
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain(DB_PASSWORD);
    expect(text).not.toContain('hunter2');
    expect(result.issues.map((i) => i.variable)).toEqual(
      expect.arrayContaining(['API_PORT', 'LOG_LEVEL']),
    );
    let message = '';
    try {
      loadConfig(hostile);
    } catch (error) {
      message = error instanceof ConfigError ? error.message : '';
    }
    expect(message).not.toContain(API_KEY);
    expect(message).not.toContain(DB_PASSWORD);
  });

  it('a semantically invalid database URL does not echo the password either', () => {
    const result = validateConfig({
      ...PRODUCTION_ENV,
      DATABASE_URL: `postgres://u:${DB_PASSWORD}@h:5432/db`,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(JSON.stringify(result.issues)).not.toContain(DB_PASSWORD);
  });

  it('redactSecretsInText masks passwords, SAS signatures and key-like values', () => {
    const text = [
      `connect postgres://user:${DB_PASSWORD}@host:5432/db now`,
      'https://account.blob.core.windows.net/c/f?sv=2024&sig=AbCdEf%2Fghij&se=2026',
      'Server=tcp:x;Password=hunter2;User Id=u',
      'https://example.test/path?token=abc123&safe=1',
    ].join('\n');
    const redacted = redactSecretsInText(text);
    expect(redacted).not.toContain(DB_PASSWORD);
    expect(redacted).not.toContain('AbCdEf');
    expect(redacted).not.toContain('hunter2');
    expect(redacted).not.toContain('abc123');
    expect(redacted).toContain('safe=1');
    expect(redactSecretsInText(redacted)).toBe(redacted);
  });
});
