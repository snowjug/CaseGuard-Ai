import { describe, expect, it } from 'vitest';
import { validateConfig } from '../src';
import { ENTRA_TENANT, PRODUCTION_ENV } from './fixtures';

type Env = Record<string, string>;

function issuesFor(env: Env): { variable: string; message: string }[] {
  const result = validateConfig(env);
  return result.ok ? [] : [...result.issues];
}

const withProd = (overrides: Env): Env => ({ ...PRODUCTION_ENV, ...overrides });

describe('[NFR-SEC-03] production safety guards', () => {
  const refused: [string, Env, string][] = [
    ['development identity', withProd({ AUTH_MODE: 'dev' }), 'AUTH_MODE'],
    ['the persona login', withProd({ DEV_AUTH_ENABLED: 'true' }), 'DEV_AUTH_ENABLED'],
    ['demo mode', withProd({ DEMO_MODE: 'true' }), 'DEMO_MODE'],
    ['demo auto-seed', withProd({ DEMO_MODE: 'true', DEMO_AUTO_SEED: 'true' }), 'DEMO_AUTO_SEED'],
    [
      'embedded PGlite',
      withProd({ DATABASE_URL: 'pglite://.data/caseguard', DATABASE_AUTH: 'password' }),
      'DATABASE_URL',
    ],
    [
      'a database URL without TLS',
      withProd({ DATABASE_URL: 'postgres://caseguard_app@db.example.test:5432/caseguard' }),
      'DATABASE_URL',
    ],
    [
      'TLS disabled explicitly',
      withProd({
        DATABASE_URL: 'postgres://caseguard_app@db.example.test:5432/caseguard?sslmode=disable',
      }),
      'DATABASE_URL',
    ],
    [
      'a password in an Entra database URL',
      withProd({
        DATABASE_URL:
          'postgres://caseguard_app:placeholder@db.example.test:5432/caseguard?sslmode=require',
      }),
      'DATABASE_URL',
    ],
    ['password auth without credentials', withProd({ DATABASE_AUTH: 'password' }), 'DATABASE_URL'],
    ['local object storage', withProd({ STORAGE_PROVIDER: 'local' }), 'STORAGE_PROVIDER'],
    [
      'an http CORS origin',
      withProd({ CORS_ALLOWED_ORIGINS: 'http://caseguard.example.test' }),
      'CORS_ALLOWED_ORIGINS',
    ],
    ['a wildcard CORS origin', withProd({ CORS_ALLOWED_ORIGINS: '*' }), 'CORS_ALLOWED_ORIGINS'],
    [
      'a wildcard inside a list',
      withProd({ CORS_ALLOWED_ORIGINS: 'https://a.example.test,https://*.example.test' }),
      'CORS_ALLOWED_ORIGINS',
    ],
    ['a missing CORS allowlist', withProd({ CORS_ALLOWED_ORIGINS: '' }), 'CORS_ALLOWED_ORIGINS'],
    [
      'an API-key model credential',
      withProd({
        AI_PROVIDER: 'azure-openai',
        AZURE_OPENAI_ENDPOINT: 'https://x.openai.azure.com',
        AZURE_OPENAI_DEPLOYMENT: 'd',
        AZURE_OPENAI_AUTH: 'api-key',
        AZURE_OPENAI_API_KEY: 'placeholder',
      }),
      'AZURE_OPENAI_AUTH',
    ],
    [
      'a stray model key with managed identity',
      withProd({
        AI_PROVIDER: 'azure-openai',
        AZURE_OPENAI_ENDPOINT: 'https://x.openai.azure.com',
        AZURE_OPENAI_DEPLOYMENT: 'd',
        AZURE_OPENAI_API_KEY: 'placeholder',
      }),
      'AZURE_OPENAI_API_KEY',
    ],
    ['the malware test hook', withProd({ MALWARE_SCAN_MODE: 'eicar-test' }), 'MALWARE_SCAN_MODE'],
  ];

  it.each(refused)('refuses %s when APP_ENV=production', (_name, env, variable) => {
    const found = issuesFor(env);
    expect(found.map((i) => i.variable)).toContain(variable);
  });

  it('the baseline production environment itself is valid', () => {
    expect(issuesFor(PRODUCTION_ENV)).toEqual([]);
  });

  it('staging applies the same transport and storage rules', () => {
    expect(issuesFor({ ...PRODUCTION_ENV, APP_ENV: 'staging' })).toEqual([]);
    const found = issuesFor({
      ...PRODUCTION_ENV,
      APP_ENV: 'staging',
      STORAGE_PROVIDER: 'local',
      DATABASE_URL: 'pglite://memory',
      DATABASE_AUTH: 'password',
    });
    expect(found.map((i) => i.variable)).toEqual(
      expect.arrayContaining(['STORAGE_PROVIDER', 'DATABASE_URL']),
    );
  });

  it('refuses persona login combined with Entra', () => {
    const found = issuesFor({ ...PRODUCTION_ENV, APP_ENV: 'local', DEV_AUTH_ENABLED: 'true' });
    expect(found.map((i) => i.variable)).toEqual(['DEV_AUTH_ENABLED']);
    expect(found[0]?.message).toMatch(/cannot be enabled while AUTH_MODE=entra/);
  });

  it('refuses development identity without its second switch', () => {
    const found = issuesFor({ APP_ENV: 'local', AUTH_MODE: 'dev', DEV_AUTH_ENABLED: 'false' });
    expect(found.map((i) => i.variable)).toContain('DEV_AUTH_ENABLED');
  });

  it('[SEC-1] refuses development identity in the deployed development environment, demo or not', () => {
    // APP_ENV=development is the internet-facing Azure development environment, not a laptop.
    const result = validateConfig({
      ...PRODUCTION_ENV,
      APP_ENV: 'development',
      AUTH_MODE: 'dev',
      DEV_AUTH_ENABLED: 'true',
      DEMO_MODE: 'true',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.variable)).toEqual(['AUTH_MODE', 'DEV_AUTH_ENABLED']);
    for (const issue of result.issues) expect(issue.message).toMatch(/local or test/);
  });
});

describe('entra settings', () => {
  const entra = (overrides: Env): Env => ({ ...PRODUCTION_ENV, ...overrides });

  it.each([
    ['a tenant id that is not a GUID', { ENTRA_TENANT_ID: 'contoso' }, 'ENTRA_TENANT_ID'],
    ['a missing audience', { ENTRA_AUDIENCE: '' }, 'ENTRA_AUDIENCE'],
    ['an audience with whitespace', { ENTRA_AUDIENCE: 'api://a b' }, 'ENTRA_AUDIENCE'],
    ['a non-https issuer', { ENTRA_ISSUER: 'http://issuer.example.test' }, 'ENTRA_ISSUER'],
    [
      'a non-https JWKS URI',
      { ENTRA_JWKS_URI: 'http://issuer.example.test/keys' },
      'ENTRA_JWKS_URI',
    ],
    ['a missing tenant map', { ENTRA_TENANT_MAP: '' }, 'ENTRA_TENANT_MAP'],
    ['an empty tenant map', { ENTRA_TENANT_MAP: '{}' }, 'ENTRA_TENANT_MAP'],
    ['a tenant map that is not JSON', { ENTRA_TENANT_MAP: '{not json' }, 'ENTRA_TENANT_MAP'],
    [
      'a tenant map keyed by a non-GUID',
      { ENTRA_TENANT_MAP: '{"contoso":"tenant_contoso_support"}' },
      'ENTRA_TENANT_MAP',
    ],
    [
      'a role map with an unknown role',
      { ENTRA_ROLE_MAP: '{"CaseGuard.Root":"root"}' },
      'ENTRA_ROLE_MAP',
    ],
    ['a role map that is an array', { ENTRA_ROLE_MAP: '["engineer"]' }, 'ENTRA_ROLE_MAP'],
  ] satisfies [string, Env, string][])('refuses %s', (_name, overrides, variable) => {
    expect(issuesFor(entra(overrides)).map((i) => i.variable)).toContain(variable);
  });

  it('accepts overridden issuer, JWKS and role map', () => {
    const result = validateConfig(
      entra({
        ENTRA_ISSUER: 'https://sts.windows.net/tenant/',
        ENTRA_JWKS_URI: 'https://login.microsoftonline.com/common/discovery/keys',
        ENTRA_ROLE_MAP: '{"Reviewer":"reviewer"}',
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.auth.entra).toMatchObject({
      issuer: 'https://sts.windows.net/tenant/',
      jwksUri: 'https://login.microsoftonline.com/common/discovery/keys',
      roleMap: { Reviewer: 'reviewer' },
    });
  });

  it('keeps several tenant mappings', () => {
    const second = '99999999-8888-7777-6666-555555555555';
    const result = validateConfig(
      entra({
        ENTRA_TENANT_MAP: JSON.stringify({
          [ENTRA_TENANT]: 'tenant_contoso_support',
          [second]: 'tenant_fabrikam_lab',
        }),
      }),
    );
    expect(result.ok && Object.keys(result.config.auth.entra?.tenantMap ?? {})).toHaveLength(2);
  });
});

describe('provider requirements', () => {
  const local = (overrides: Env): Env => ({ APP_ENV: 'local', ...overrides });

  it.each([
    ['azure-blob without an account', { STORAGE_PROVIDER: 'azure-blob' }, 'AZURE_STORAGE_ACCOUNT'],
    [
      'azure-blob with an invalid account name',
      { STORAGE_PROVIDER: 'azure-blob', AZURE_STORAGE_ACCOUNT: 'Bad_Name' },
      'AZURE_STORAGE_ACCOUNT',
    ],
    [
      'azure-blob with an invalid container',
      {
        STORAGE_PROVIDER: 'azure-blob',
        AZURE_STORAGE_ACCOUNT: 'stcaseguard',
        AZURE_STORAGE_CONTAINER: 'Bad Container',
      },
      'AZURE_STORAGE_CONTAINER',
    ],
    [
      'azure-ai-search without an endpoint',
      { SEARCH_PROVIDER: 'azure-ai-search' },
      'AZURE_SEARCH_ENDPOINT',
    ],
    [
      'azure-ai-search with an http endpoint',
      { SEARCH_PROVIDER: 'azure-ai-search', AZURE_SEARCH_ENDPOINT: 'http://search.example.test' },
      'AZURE_SEARCH_ENDPOINT',
    ],
    [
      'azure-openai without an endpoint',
      { AI_PROVIDER: 'azure-openai', AZURE_OPENAI_DEPLOYMENT: 'd' },
      'AZURE_OPENAI_ENDPOINT',
    ],
    [
      'azure-openai without a deployment',
      { AI_PROVIDER: 'azure-openai', AZURE_OPENAI_ENDPOINT: 'https://x.openai.azure.com' },
      'AZURE_OPENAI_DEPLOYMENT',
    ],
    [
      'azure-openai api-key auth without a key',
      {
        AI_PROVIDER: 'azure-openai',
        AZURE_OPENAI_ENDPOINT: 'https://x.openai.azure.com',
        AZURE_OPENAI_DEPLOYMENT: 'd',
        AZURE_OPENAI_AUTH: 'api-key',
      },
      'AZURE_OPENAI_API_KEY',
    ],
    ['a cost cap without prices', { AI_COST_LIMIT_USD_PER_DAY: '10' }, 'AI_COST_LIMIT_USD_PER_DAY'],
    [
      'a cost cap with only one price',
      { AI_COST_LIMIT_USD_PER_DAY: '10', AI_UNIT_PRICE_INPUT_PER_1K: '0.01' },
      'AI_COST_LIMIT_USD_PER_DAY',
    ],
    ['entra database auth with PGlite', { DATABASE_AUTH: 'entra' }, 'DATABASE_AUTH'],
    ['a database URL with the wrong scheme', { DATABASE_URL: 'mysql://h/db' }, 'DATABASE_URL'],
    ['a PGlite URL without a target', { DATABASE_URL: 'pglite://' }, 'DATABASE_URL'],
    [
      'a PostgreSQL URL without a database',
      { DATABASE_URL: 'postgres://u@h:5432/' },
      'DATABASE_URL',
    ],
    [
      'an invalid connection string',
      { APPLICATIONINSIGHTS_CONNECTION_STRING: 'not-a-connection-string' },
      'APPLICATIONINSIGHTS_CONNECTION_STRING',
    ],
    [
      'auto-seed without demo mode',
      { DEMO_MODE: 'false', DEMO_AUTO_SEED: 'true' },
      'DEMO_AUTO_SEED',
    ],
    [
      'a CORS origin with a path',
      { CORS_ALLOWED_ORIGINS: 'http://localhost:3000/app' },
      'CORS_ALLOWED_ORIGINS',
    ],
    [
      'a CORS entry that is not a URL',
      { CORS_ALLOWED_ORIGINS: 'localhost:3000' },
      'CORS_ALLOWED_ORIGINS',
    ],
  ] satisfies [string, Env, string][])('refuses %s', (_name, overrides, variable) => {
    expect(issuesFor(local(overrides)).map((i) => i.variable)).toContain(variable);
  });

  it('turning demo mode off locally also stops auto-seeding', () => {
    const result = validateConfig({ DEMO_MODE: 'false' });
    expect(result.ok && result.config.demo).toEqual({ mode: false, autoSeed: false });
  });

  it('warns when a deployed environment trusts every forwarded hop, but not for a hop count', () => {
    const every = validateConfig(withProd({ TRUST_PROXY: 'true' }));
    expect(every.ok && every.config.warnings.join('\n')).toMatch(/TRUST_PROXY=true trusts every/);
    const counted = validateConfig(withProd({ TRUST_PROXY: '1' }));
    expect(counted.ok && counted.config.warnings.join('\n')).not.toMatch(/TRUST_PROXY/);
    const local = validateConfig({ TRUST_PROXY: 'true' });
    expect(local.ok && local.config.warnings.join('\n')).not.toMatch(/TRUST_PROXY/);
  });

  it('warns about an ineffective AI rate limit and a stray key', () => {
    const result = validateConfig({
      RATE_LIMIT_MAX: '10',
      RATE_LIMIT_AI_MAX: '50',
      AI_PROVIDER: 'azure-openai',
      AZURE_OPENAI_ENDPOINT: 'https://x.openai.azure.com',
      AZURE_OPENAI_DEPLOYMENT: 'd',
      AZURE_OPENAI_API_KEY: 'placeholder-key',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.warnings.join('\n')).toMatch(/RATE_LIMIT_AI_MAX/);
    expect(result.config.warnings.join('\n')).toMatch(/AZURE_OPENAI_API_KEY is set but ignored/);
  });

  it('accepts an api-key credential for local experiments and keeps it secret', () => {
    const config = (() => {
      const result = validateConfig({
        AI_PROVIDER: 'azure-openai',
        AZURE_OPENAI_ENDPOINT: 'https://x.openai.azure.com',
        AZURE_OPENAI_DEPLOYMENT: 'd',
        AZURE_OPENAI_AUTH: 'api-key',
        AZURE_OPENAI_API_KEY: 'placeholder-key',
      });
      if (!result.ok) throw new Error('expected a valid configuration');
      return result.config;
    })();
    expect(config.ai.provider === 'azure-openai' && config.ai.apiKey?.reveal()).toBe(
      'placeholder-key',
    );
  });
});

describe('the scripted test provider is for local and test runtimes only', () => {
  it.each(['local', 'test'])('is accepted when APP_ENV is %s, and needs nothing else', (appEnv) => {
    const result = validateConfig({ APP_ENV: appEnv, AI_PROVIDER: 'scripted' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.ai.provider).toBe('scripted');
    expect(result.config.ai.limits).toBeDefined();
  });

  it('is accepted with no APP_ENV at all, which is a local run', () => {
    const result = validateConfig({ AI_PROVIDER: 'scripted' });
    expect(result.ok && result.config.ai.provider).toBe('scripted');
  });

  it.each(['development', 'staging', 'production'])(
    'is refused when APP_ENV is %s, and the refusal names AI_PROVIDER',
    (appEnv) => {
      const found = issuesFor({ ...PRODUCTION_ENV, APP_ENV: appEnv, AI_PROVIDER: 'scripted' });
      expect(found.map((i) => i.variable)).toEqual(['AI_PROVIDER']);
      expect(found[0]?.message).toMatch(/test-only provider/);
      expect(found[0]?.message).toMatch(/local or test/);
    },
  );

  it('is refused in a deployed environment whatever else is set, demo mode included', () => {
    const found = issuesFor({
      ...PRODUCTION_ENV,
      AI_PROVIDER: 'scripted',
      DEMO_MODE: 'true',
      DEMO_AUTO_SEED: 'true',
    });
    expect(found.map((i) => i.variable)).toContain('AI_PROVIDER');
  });

  it('does not change the deterministic default, or what the deployed environments accept', () => {
    const local = validateConfig({ APP_ENV: 'local' });
    expect(local.ok && local.config.ai.provider).toBe('deterministic');
    expect(issuesFor(PRODUCTION_ENV)).toEqual([]);
    expect(issuesFor({ ...PRODUCTION_ENV, AI_PROVIDER: 'deterministic' })).toEqual([]);
  });

  it('still refuses a value that is not a provider', () => {
    expect(
      issuesFor({ APP_ENV: 'local', AI_PROVIDER: 'scripted-model' }).map((i) => i.variable),
    ).toEqual(['AI_PROVIDER']);
  });
});
