import { describe, expect, it } from 'vitest';
import { ConfigError, describeConfig, loadConfig, validateConfig } from '../src';
import { PRODUCTION_ENV } from './fixtures';

/**
 * AI-3: the Azure OpenAI provider requires a bare https origin and a deployment name of 1 to 64
 * characters starting with a letter or digit, and refuses to be built otherwise (`not_configured`).
 * Configuration must refuse the same values at start-up instead of letting every analysis fail later.
 * apps/api/test/config-provider-parity.test.ts runs both against the same table so the copies of
 * the rules cannot drift apart.
 */
type Env = Record<string, string>;

const azure = (overrides: Env = {}): Env => ({
  APP_ENV: 'local',
  AI_PROVIDER: 'azure-openai',
  AZURE_OPENAI_ENDPOINT: 'https://example-openai.openai.azure.com',
  AZURE_OPENAI_DEPLOYMENT: 'gpt-test',
  ...overrides,
});

function issuesFor(env: Env): { variable: string; message: string }[] {
  const result = validateConfig(env);
  return result.ok ? [] : [...result.issues];
}

const variablesFor = (overrides: Env): string[] =>
  issuesFor(azure(overrides)).map((issue) => issue.variable);

describe('[AI-3] AZURE_OPENAI_ENDPOINT must be a bare https origin', () => {
  it.each([
    ['a bare origin', 'https://example-openai.openai.azure.com'],
    [
      'a bare origin with a trailing slash (what Azure reports)',
      'https://example-openai.openai.azure.com/',
    ],
    ['a mixed-case host', 'https://Example-OpenAI.OpenAI.Azure.com'],
    ['an explicit port', 'https://example-openai.openai.azure.com:8443'],
  ])('accepts %s', (_name, endpoint) => {
    expect(variablesFor({ AZURE_OPENAI_ENDPOINT: endpoint })).toEqual([]);
  });

  it.each([
    ['plain http', 'http://example-openai.openai.azure.com'],
    [
      'http on loopback (the provider tolerates it for mock servers; configuration does not)',
      'http://localhost:8080',
    ],
    ['a path', 'https://example-openai.openai.azure.com/openai'],
    [
      'the full request path',
      'https://example-openai.openai.azure.com/openai/deployments/gpt-test/chat/completions',
    ],
    ['a double slash', 'https://example-openai.openai.azure.com//'],
    ['a query', 'https://example-openai.openai.azure.com/?api-version=2024-10-21'],
    ['a query without a path', 'https://example-openai.openai.azure.com?x=1'],
    ['an empty query', 'https://example-openai.openai.azure.com/?'],
    ['a fragment', 'https://example-openai.openai.azure.com/#top'],
    ['an empty fragment', 'https://example-openai.openai.azure.com#'],
    ['a user name and password', 'https://user:pw@example-openai.openai.azure.com'],
    ['a user name only', 'https://user@example-openai.openai.azure.com/'],
    ['an empty user name', 'https://@example-openai.openai.azure.com/'],
    ['no scheme', 'example-openai.openai.azure.com'],
    ['a scheme without slashes', 'https:example-openai.openai.azure.com'],
    ['another scheme', 'ftp://example-openai.openai.azure.com'],
    ['no host', 'https://'],
    ['a space in the host', 'https://example openai.azure.com'],
    ['text that is not a URL', 'not a url'],
  ])('refuses %s', (_name, endpoint) => {
    const found = issuesFor(azure({ AZURE_OPENAI_ENDPOINT: endpoint }));
    expect(found.map((issue) => issue.variable)).toEqual(['AZURE_OPENAI_ENDPOINT']);
    expect(found[0]?.message).toMatch(/bare https origin/);
  });

  it('says plainly that the endpoint is missing', () => {
    const found = issuesFor({
      APP_ENV: 'local',
      AI_PROVIDER: 'azure-openai',
      AZURE_OPENAI_DEPLOYMENT: 'gpt-test',
    });
    expect(found).toEqual([
      { variable: 'AZURE_OPENAI_ENDPOINT', message: 'is required for azure-openai' },
    ]);
  });

  it('keeps the configured value as given, so the provider sees exactly what the operator set', () => {
    const config = loadConfig(
      azure({ AZURE_OPENAI_ENDPOINT: 'https://example-openai.openai.azure.com/' }),
    );
    expect(config.ai.provider === 'azure-openai' && config.ai.endpoint).toBe(
      'https://example-openai.openai.azure.com/',
    );
  });
});

describe('[AI-3] AZURE_OPENAI_DEPLOYMENT follows the provider rule', () => {
  it.each([
    ['one character', 'd'],
    ['a typical name', 'gpt-4o'],
    ['dots and underscores', 'gpt-4.1_mini'],
    ['capitals', 'Caseguard-Chat'],
    ['a leading digit', '0abc'],
    ['the longest allowed name (64)', 'a'.repeat(64)],
  ])('accepts %s', (_name, deployment) => {
    expect(variablesFor({ AZURE_OPENAI_DEPLOYMENT: deployment })).toEqual([]);
  });

  it.each([
    ['a leading hyphen', '-abc'],
    ['a leading dot', '.abc'],
    ['a leading underscore', '_abc'],
    ['65 characters (the old limit was 128)', 'a'.repeat(65)],
    ['128 characters', 'a'.repeat(128)],
    ['more than 128 characters', 'a'.repeat(129)],
    ['a space', 'has space'],
    ['a slash', 'a/b'],
    ['a colon', 'a:b'],
    ['a percent escape', 'a%20b'],
    ['a dollar sign', 'a$b'],
    ['a non-ASCII letter', 'caf\u00e9'],
  ])('refuses %s', (_name, deployment) => {
    expect(variablesFor({ AZURE_OPENAI_DEPLOYMENT: deployment })).toEqual([
      'AZURE_OPENAI_DEPLOYMENT',
    ]);
  });

  it('says plainly that the deployment is missing', () => {
    const found = issuesFor({
      APP_ENV: 'local',
      AI_PROVIDER: 'azure-openai',
      AZURE_OPENAI_ENDPOINT: 'https://example-openai.openai.azure.com',
    });
    expect(found).toEqual([
      { variable: 'AZURE_OPENAI_DEPLOYMENT', message: 'is required for azure-openai' },
    ]);
  });
});

describe('[AI-3] the endpoint and deployment rules', () => {
  it('report both variables in one pass', () => {
    expect(
      variablesFor({
        AZURE_OPENAI_ENDPOINT: 'https://example-openai.openai.azure.com/openai',
        AZURE_OPENAI_DEPLOYMENT: '-bad',
      }),
    ).toEqual(['AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_DEPLOYMENT']);
  });

  it.each(['local', 'test', 'development', 'staging', 'production'])(
    'apply in APP_ENV=%s',
    (appEnv) => {
      const env = {
        ...PRODUCTION_ENV,
        APP_ENV: appEnv,
        AI_PROVIDER: 'azure-openai',
        AZURE_OPENAI_ENDPOINT: 'https://example-openai.openai.azure.com/openai',
        AZURE_OPENAI_DEPLOYMENT: '-bad',
      };
      expect(issuesFor(env).map((issue) => issue.variable)).toEqual([
        'AZURE_OPENAI_ENDPOINT',
        'AZURE_OPENAI_DEPLOYMENT',
      ]);
      expect(
        issuesFor({
          ...env,
          AZURE_OPENAI_ENDPOINT: 'https://example-openai.openai.azure.com/',
          AZURE_OPENAI_DEPLOYMENT: 'caseguard-chat',
        }),
      ).toEqual([]);
    },
  );

  it('are not checked while the deterministic provider is active (the template passes empty values)', () => {
    for (const provider of [undefined, 'deterministic']) {
      const result = validateConfig({
        APP_ENV: 'local',
        ...(provider === undefined ? {} : { AI_PROVIDER: provider }),
        AZURE_OPENAI_ENDPOINT: 'https://example-openai.openai.azure.com/openai?x=1',
        AZURE_OPENAI_DEPLOYMENT: '-bad',
      });
      expect(result.ok, String(provider)).toBe(true);
      if (result.ok) expect(result.config.ai.provider).toBe('deterministic');
    }
  });

  it('never echo the rejected value in the issues or in the thrown error', () => {
    const secret = 'leak-3f9c1d7a-fake';
    const hostile = azure({
      AZURE_OPENAI_ENDPOINT: `https://user:${secret}@example-openai.openai.azure.com/p?key=${secret}`,
      AZURE_OPENAI_DEPLOYMENT: `${secret}/../x`,
    });
    const result = validateConfig(hostile);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.variable)).toEqual([
      'AZURE_OPENAI_ENDPOINT',
      'AZURE_OPENAI_DEPLOYMENT',
    ]);
    expect(JSON.stringify(result.issues)).not.toContain(secret);
    let message = '';
    try {
      loadConfig(hostile);
    } catch (error) {
      message = error instanceof ConfigError ? error.message : '';
    }
    expect(message).toContain('AZURE_OPENAI_ENDPOINT');
    expect(message).not.toContain(secret);
    expect(message).not.toContain('example-openai');
  });
});

describe('[AI-3] describeConfig and the Azure OpenAI settings', () => {
  const API_KEY = 'key-1b2c3d4e5f-fake';

  it('names the endpoint origin and the deployment, and never the key', () => {
    const config = loadConfig(
      azure({
        AZURE_OPENAI_AUTH: 'api-key',
        AZURE_OPENAI_API_KEY: API_KEY,
        AZURE_OPENAI_ENDPOINT: 'https://example-openai.openai.azure.com/',
      }),
    );
    const summary = describeConfig(config);
    expect(summary.ai).toEqual({
      provider: 'azure-openai',
      endpoint: 'https://example-openai.openai.azure.com',
      deployment: 'gpt-test',
      auth: 'api-key',
      credentialConfigured: true,
      costCapConfigured: false,
    });
    expect(JSON.stringify(summary)).not.toContain(API_KEY);
  });

  it('keeps a non-default port in the origin', () => {
    const config = loadConfig(
      azure({ AZURE_OPENAI_ENDPOINT: 'https://example-openai.openai.azure.com:8443' }),
    );
    expect(describeConfig(config).ai.endpoint).toBe('https://example-openai.openai.azure.com:8443');
  });

  it('reports nothing about Azure OpenAI while the deterministic provider is active', () => {
    const summary = describeConfig(loadConfig({ APP_ENV: 'local' }));
    expect(summary.ai).toEqual({
      provider: 'deterministic',
      endpoint: null,
      deployment: null,
      auth: null,
      credentialConfigured: false,
      costCapConfigured: false,
    });
  });

  it('prints only the origin even if a configuration object were built by hand with a hostile endpoint', () => {
    const config = loadConfig(azure());
    if (config.ai.provider !== 'azure-openai') throw new Error('expected azure-openai');
    const hostile = {
      ...config,
      ai: {
        ...config.ai,
        endpoint: 'https://u-3f9c:pw-7a1d@host.example.test:8443/openai?api-key=key-5e2b#frag-9c',
      },
    };
    const text = JSON.stringify(describeConfig(hostile));
    expect(describeConfig(hostile).ai.endpoint).toBe('https://host.example.test:8443');
    for (const leak of ['u-3f9c', 'pw-7a1d', 'key-5e2b', 'frag-9c', 'api-key']) {
      expect(text).not.toContain(leak);
    }
    const broken = { ...config, ai: { ...config.ai, endpoint: 'not a url' } };
    expect(describeConfig(broken).ai.endpoint).toBe('invalid');
  });
});
