import {
  AzureOpenAiProvider,
  type AzureAuth,
  type Logger as AiLogger,
  type ModelProvider,
} from '@caseguard/ai';
import type { AppConfig } from '@caseguard/config';

/** Builds the provider the operator configured; `undefined` means "use the deterministic provider". */
export type ProviderFactory = (
  config: AppConfig,
  logger: AiLogger,
) => Promise<ModelProvider | undefined>;

/**
 * Azure OpenAI is reached with the container's managed identity (`DefaultAzureCredential`); an API key
 * is accepted only outside deployed environments (the configuration loader already refuses it there,
 * this is the second lock). `@azure/identity` loads lazily so a deterministic deployment never pays
 * for it. NOT validated against a live Azure OpenAI deployment: see `AZURE_VALIDATION_NOTE`.
 */
export const createConfiguredProvider: ProviderFactory = async (config, logger) => {
  const ai = config.ai;
  if (ai.provider !== 'azure-openai') return undefined;

  let auth: AzureAuth;
  if (ai.auth === 'api-key' && ai.apiKey !== null) {
    auth = { kind: 'api-key', apiKey: ai.apiKey.reveal() };
  } else {
    const { DefaultAzureCredential } = await import('@azure/identity');
    const credential = new DefaultAzureCredential(
      config.auth.azureClientId ? { managedIdentityClientId: config.auth.azureClientId } : {},
    );
    auth = { kind: 'managed-identity', credential };
  }

  return new AzureOpenAiProvider({
    endpoint: ai.endpoint,
    deployment: ai.deployment,
    apiVersion: ai.apiVersion,
    auth,
    allowApiKey: !config.runtime.deployed,
    maxRetries: ai.limits.maxRetries,
    logger,
  });
};
