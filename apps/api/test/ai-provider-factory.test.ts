import { noopLogger } from '@caseguard/ai';
import { loadConfig, type AppConfig } from '@caseguard/config';
import { describe, expect, it } from 'vitest';
import { createConfiguredProvider } from '../src/services/ai/provider';

const config = (extra: Record<string, string> = {}): AppConfig =>
  loadConfig({ APP_ENV: 'test', DATABASE_URL: 'pglite://memory', ...extra });

describe('the AI provider factory', () => {
  it('builds nothing for the deterministic provider: the engine runs in-process', async () => {
    expect(await createConfiguredProvider(config(), noopLogger)).toBeUndefined();
  });

  it('builds the scripted test provider for a local or test runtime, with no script, so every call falls back', async () => {
    const provider = await createConfiguredProvider(
      config({ AI_PROVIDER: 'scripted' }),
      noopLogger,
    );
    expect(provider).toMatchObject({ kind: 'scripted', simulated: true });
    expect(provider?.describe().model).toBe('scripted-test-model');
    const request = {
      requestId: 'req_factory',
      tenantId: 'tenant_a',
      agent: 'case_reasoner',
      messages: [{ role: 'user', content: 'x' }],
      structuredOutput: { name: 'x', schema: {}, strict: true },
      maxOutputTokens: 100,
      temperature: 0,
      timeoutMs: 1000,
      model: null,
      task: {},
    } as unknown as Parameters<NonNullable<typeof provider>['complete']>[0];
    await expect(provider?.complete(request)).rejects.toMatchObject({ code: 'unsupported_task' });
  });

  it('refuses to build the scripted provider for a deployed runtime, even if configuration let it through', async () => {
    const local = config({ AI_PROVIDER: 'scripted' });
    const forced: AppConfig = { ...local, runtime: { ...local.runtime, deployed: true } };
    await expect(createConfiguredProvider(forced, noopLogger)).rejects.toMatchObject({
      code: 'not_configured',
    });
  });
});
