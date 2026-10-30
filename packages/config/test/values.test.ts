import { describe, expect, it } from 'vitest';
import { validateConfig } from '../src';

const parsed = (env: Record<string, string>) => {
  const result = validateConfig(env);
  if (!result.ok)
    throw new Error(result.issues.map((i) => `${i.variable}: ${i.message}`).join('; '));
  return result.config;
};
const variablesOf = (env: Record<string, string>): string[] => {
  const result = validateConfig(env);
  return result.ok ? [] : result.issues.map((i) => i.variable);
};

describe('value parsing', () => {
  it.each([
    ['true', true],
    ['TRUE', true],
    ['yes', true],
    ['on', true],
    ['false', false],
    ['False', false],
    ['0', false],
    ['no', false],
    ['off', false],
    ['  true  ', true],
  ])('reads %s as the boolean %s', (text, expected) => {
    expect(parsed({ TRUST_PROXY: text }).http.trustProxy).toBe(expected);
  });

  it.each([
    ['1', 1],
    ['2', 2],
    [' 3 ', 3],
  ])('reads %s as a proxy hop count', (text, expected) => {
    expect(parsed({ TRUST_PROXY: text }).http.trustProxy).toBe(expected);
  });

  it('reads a list of proxy addresses and ranges', () => {
    expect(
      parsed({ TRUST_PROXY: '10.0.0.0/8, 192.168.1.5 ,loopback,fd00::/8' }).http.trustProxy,
    ).toEqual(['10.0.0.0/8', '192.168.1.5', 'loopback', 'fd00::/8']);
  });

  it.each(['maybe', 'tru', 'enabled', '11', '10.0.0.0/33', 'fd00::/129', 'not-an-address'])(
    'rejects %s as a proxy setting',
    (text) => {
      expect(variablesOf({ TRUST_PROXY: text })).toEqual(['TRUST_PROXY']);
    },
  );

  it('does not believe the client address header unless it is switched on', () => {
    expect(parsed({}).http.trustClientIpHeader).toBe(false);
    expect(parsed({ TRUST_CLIENT_IP_HEADER: 'true' }).http.trustClientIpHeader).toBe(true);
    expect(parsed({ TRUST_CLIENT_IP_HEADER: 'off' }).http.trustClientIpHeader).toBe(false);
    expect(variablesOf({ TRUST_CLIENT_IP_HEADER: 'sometimes' })).toEqual([
      'TRUST_CLIENT_IP_HEADER',
    ]);
  });

  it.each([
    ['4000', 4000],
    [' 4001 ', 4001],
    ['1', 1],
    ['65535', 65535],
  ])('reads the port %s', (text, expected) => {
    expect(parsed({ API_PORT: text }).http.port).toBe(expected);
  });

  it.each(['abc', '0', '65536', '-1', '40.5', '12abc', '1_000', 'Infinity', 'NaN'])(
    'rejects %s as a port',
    (text) => {
      expect(variablesOf({ API_PORT: text })).toEqual(['API_PORT']);
    },
  );

  it('treats unset, empty and whitespace-only values the same way', () => {
    const base = parsed({});
    expect(parsed({ API_PORT: '', LOG_LEVEL: '   ', TRUST_PROXY: '', DB_POOL_MAX: '\t' })).toEqual(
      base,
    );
  });

  it('ignores variables it does not know', () => {
    expect(
      parsed({ PATH: '/usr/bin', HOME: '/home/x', NODE_ENV: 'development', UNRELATED: '1' }).runtime
        .env,
    ).toBe('local');
  });

  it.each([
    ['API_PORT', '70000'],
    ['DB_POOL_MAX', '0'],
    ['DB_POOL_MAX', '201'],
    ['AI_MAX_RETRIES', '11'],
    ['AI_MAX_INPUT_TOKENS', '10'],
    ['AI_TIMEOUT_MS', '10'],
    ['RATE_LIMIT_MAX', '0'],
    ['BODY_LIMIT_BYTES', '10'],
    ['OTEL_SAMPLING_RATIO', '1.5'],
    ['OTEL_SAMPLING_RATIO', '-0.1'],
    ['LOG_LEVEL', 'verbose'],
    ['APP_ENV', 'prod'],
    ['AUTH_MODE', 'basic'],
    ['STORAGE_PROVIDER', 's3'],
    ['MALWARE_SCAN_MODE', 'clamav'],
    ['CACHE_PROVIDER', 'redis'],
  ])('rejects %s=%s as out of range or unknown', (name, value) => {
    expect(variablesOf({ [name]: value })).toContain(name);
  });

  it('reads fractional values where they are meaningful', () => {
    expect(parsed({ OTEL_SAMPLING_RATIO: '0.25' }).telemetry.otelSamplingRatio).toBe(0.25);
    const priced = parsed({
      AI_COST_LIMIT_USD_PER_DAY: '12.5',
      AI_UNIT_PRICE_INPUT_PER_1K: '0.0005',
      AI_UNIT_PRICE_OUTPUT_PER_1K: '0.0015',
    });
    expect(priced.ai.limits.costLimitUsdPerDay).toBe(12.5);
    expect(priced.ai.limits.unitPriceInputPer1k).toBe(0.0005);
  });

  it('normalises CORS origins and removes duplicates', () => {
    const config = parsed({
      CORS_ALLOWED_ORIGINS: 'http://localhost:3000/, http://localhost:3000 ,http://127.0.0.1:3000',
    });
    expect(config.http.corsAllowedOrigins).toEqual([
      'http://localhost:3000',
      'http://127.0.0.1:3000',
    ]);
  });

  it('reports every invalid variable in one pass', () => {
    expect(variablesOf({ API_PORT: 'x', LOG_LEVEL: 'y', DB_POOL_MAX: 'z' }).sort()).toEqual([
      'API_PORT',
      'DB_POOL_MAX',
      'LOG_LEVEL',
    ]);
  });

  it('accepts the real process.env without throwing on a normal environment', () => {
    expect(() => validateConfig({ ...process.env, APP_ENV: undefined })).not.toThrow();
  });
});
