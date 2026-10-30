import { AzureOpenAiProvider } from '@caseguard/ai';
import { validateConfig } from '@caseguard/config';
import { describe, expect, it } from 'vitest';

/**
 * AI-3. packages/config cannot import packages/ai, so it carries a copy of the two input rules the
 * Azure OpenAI provider enforces when it is built (`parseEndpoint` and `assertDeployment` in
 * packages/ai/src/providers/azure/http.ts). A value that configuration accepts but the provider
 * refuses lets the API start and then fail every analysis with `not_configured`. This test runs both
 * against the same inputs, so a change to either rule shows up here: configuration may be stricter
 * than the provider (it is https only and refuses `@`, `?` and `#` outright), never looser.
 * It needs no database, network or running API.
 */
const GOOD_ENDPOINT = 'https://example-openai.openai.azure.com';
const GOOD_DEPLOYMENT = 'gpt-test';

interface Settings {
  endpoint: string;
  deployment: string;
}

/** The values the API would hand to the provider, or null when start-up would be refused. */
function configured(endpoint: string, deployment: string): Settings | null {
  const result = validateConfig({
    APP_ENV: 'local',
    AI_PROVIDER: 'azure-openai',
    AZURE_OPENAI_ENDPOINT: endpoint,
    AZURE_OPENAI_DEPLOYMENT: deployment,
  });
  if (!result.ok || result.config.ai.provider !== 'azure-openai') return null;
  return { endpoint: result.config.ai.endpoint, deployment: result.config.ai.deployment };
}

function providerAccepts(settings: Settings): boolean {
  try {
    new AzureOpenAiProvider({
      ...settings,
      apiVersion: '2024-10-21',
      auth: { kind: 'api-key', apiKey: 'placeholder' },
      allowApiKey: true,
    });
    return true;
  } catch {
    return false;
  }
}

type Row = readonly [value: string, configuration: boolean, provider: boolean];

const ENDPOINTS: readonly Row[] = [
  [GOOD_ENDPOINT, true, true],
  [`${GOOD_ENDPOINT}/`, true, true],
  ['https://Example-OpenAI.OpenAI.Azure.com', true, true],
  [`${GOOD_ENDPOINT}:8443`, true, true],
  // The provider is looser here on purpose; configuration refuses these.
  ['http://localhost:8080', false, true],
  [`${GOOD_ENDPOINT}/?`, false, true],
  [`${GOOD_ENDPOINT}#`, false, true],
  ['https://@example-openai.openai.azure.com/', false, true],
  ['https:example-openai.openai.azure.com', false, true],
  // Both refuse.
  ['http://example-openai.openai.azure.com', false, false],
  [`${GOOD_ENDPOINT}/openai`, false, false],
  [`${GOOD_ENDPOINT}//`, false, false],
  [`${GOOD_ENDPOINT}/?api-version=2024-10-21`, false, false],
  [`${GOOD_ENDPOINT}?x=1`, false, false],
  [`${GOOD_ENDPOINT}/#top`, false, false],
  ['https://user:pw@example-openai.openai.azure.com', false, false],
  ['https://user@example-openai.openai.azure.com/', false, false],
  ['example-openai.openai.azure.com', false, false],
  ['ftp://example-openai.openai.azure.com', false, false],
  ['https://', false, false],
  ['not a url', false, false],
];

const DEPLOYMENTS: readonly Row[] = [
  ['d', true, true],
  ['gpt-4o', true, true],
  ['gpt-4.1_mini', true, true],
  ['Caseguard-Chat', true, true],
  ['0abc', true, true],
  ['a'.repeat(64), true, true],
  ['-abc', false, false],
  ['.abc', false, false],
  ['_abc', false, false],
  ['a'.repeat(65), false, false],
  ['a'.repeat(128), false, false],
  ['has space', false, false],
  ['a/b', false, false],
  ['a:b', false, false],
  ['a%20b', false, false],
  ['caf\u00e9', false, false],
];

describe('[AI-3] configuration and the Azure OpenAI provider agree', () => {
  it.each(ENDPOINTS)('endpoint %s: configuration=%s provider=%s', (endpoint, config, provider) => {
    const actual = {
      configuration: configured(endpoint, GOOD_DEPLOYMENT) !== null,
      provider: providerAccepts({ endpoint, deployment: GOOD_DEPLOYMENT }),
    };
    expect(actual).toEqual({ configuration: config, provider });
    expect(actual.configuration && !actual.provider).toBe(false);
  });

  it.each(DEPLOYMENTS)(
    'deployment %s: configuration=%s provider=%s',
    (deployment, config, provider) => {
      const actual = {
        configuration: configured(GOOD_ENDPOINT, deployment) !== null,
        provider: providerAccepts({ endpoint: GOOD_ENDPOINT, deployment }),
      };
      expect(actual).toEqual({ configuration: config, provider });
      expect(actual.configuration && !actual.provider).toBe(false);
    },
  );

  it('whatever configuration accepts, the provider builds from it (endpoint sweep)', () => {
    const rest = GOOD_ENDPOINT.slice('https://'.length);
    const candidates = [
      ...['/', '//', '/x', '?', '#', '?x=1', '#x', ':443', ':0', ':99999', ':abc', '@'].flatMap(
        (suffix) => [`${GOOD_ENDPOINT}${suffix}`, `${GOOD_ENDPOINT}/${suffix}`],
      ),
      ...['', 'a@', 'a:b@', '.', 'x.', '-', '[::1]', '10.0.0.4', '0x7f.1'].map(
        (host) => `https://${host}${rest}`,
      ),
      ...['https:', 'https:/', 'https:///', 'https:\\\\', 'HTTPS://', 'http://', 'file://'].map(
        (scheme) => `${scheme}${rest}`,
      ),
    ];
    const accepted = candidates.flatMap((endpoint) => {
      const settings = configured(endpoint, GOOD_DEPLOYMENT);
      return settings === null ? [] : [{ endpoint, settings }];
    });
    expect(accepted.length).toBeGreaterThan(0);
    const looser = accepted.filter(({ settings }) => !providerAccepts(settings));
    expect(looser.map(({ endpoint }) => endpoint)).toEqual([]);
  });

  it('whatever configuration accepts, the provider builds from it (deployment sweep)', () => {
    const printable = Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) =>
      String.fromCharCode(0x20 + i),
    );
    const others = ['\u00e9', '\u00df', '\u0130', '\u0661', '\u200b', '\uff21', '\u2028'];
    const candidates = [...printable, ...others].flatMap((char) => [
      char,
      `${char}abc`,
      `abc${char}`,
      `ab${char}c`,
    ]);
    for (const length of [1, 2, 63, 64, 65, 100, 128]) candidates.push('a'.repeat(length));

    const accepted = candidates.flatMap((deployment) => {
      const settings = configured(GOOD_ENDPOINT, deployment);
      return settings === null ? [] : [{ deployment, settings }];
    });
    expect(accepted.length).toBeGreaterThan(0);
    const looser = accepted.filter(({ settings }) => !providerAccepts(settings));
    expect(looser.map(({ deployment }) => deployment)).toEqual([]);
  });
});
