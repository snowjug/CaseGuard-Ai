import { type BuildContext, parseUrl } from '../context';
import { Secret } from '../secret';
import type { AiConfig, AiLimits } from '../types';

const DEFAULT_API_VERSION = '2024-10-21';

function buildLimits(ctx: BuildContext): AiLimits {
  const { raw } = ctx;
  const costLimit = raw.AI_COST_LIMIT_USD_PER_DAY ?? null;
  const inputPrice = raw.AI_UNIT_PRICE_INPUT_PER_1K ?? null;
  const outputPrice = raw.AI_UNIT_PRICE_OUTPUT_PER_1K ?? null;

  // A spend cap is only enforceable with prices, and prices are never invented.
  if (costLimit !== null && (inputPrice === null || outputPrice === null)) {
    ctx.fail(
      'AI_COST_LIMIT_USD_PER_DAY',
      'needs AI_UNIT_PRICE_INPUT_PER_1K and AI_UNIT_PRICE_OUTPUT_PER_1K; prices are never assumed',
    );
  }
  return {
    maxInputTokens: raw.AI_MAX_INPUT_TOKENS ?? 24_000,
    maxOutputTokens: raw.AI_MAX_OUTPUT_TOKENS ?? 4_000,
    timeoutMs: raw.AI_TIMEOUT_MS ?? 30_000,
    maxRetries: raw.AI_MAX_RETRIES ?? 2,
    costLimitUsdPerDay: costLimit,
    unitPriceInputPer1k: inputPrice,
    unitPriceOutputPer1k: outputPrice,
  };
}

/**
 * AI provider settings. The default is the deterministic knowledge-pack provider, which needs no
 * network. Azure OpenAI uses managed identity; an API key is for local experiments only.
 */
export function buildAi(ctx: BuildContext): AiConfig {
  const { raw } = ctx;
  const limits = buildLimits(ctx);
  const provider = raw.AI_PROVIDER ?? 'deterministic';
  if (provider === 'deterministic') return { provider, limits };

  const endpoint = raw.AZURE_OPENAI_ENDPOINT;
  if (endpoint === undefined || !parseUrl(endpoint, ['https:'])) {
    ctx.fail('AZURE_OPENAI_ENDPOINT', 'is required for azure-openai and must be an https URL');
  }
  const deployment = raw.AZURE_OPENAI_DEPLOYMENT;
  if (deployment === undefined || !/^[A-Za-z0-9._-]{1,128}$/.test(deployment)) {
    ctx.fail('AZURE_OPENAI_DEPLOYMENT', 'is required for azure-openai (letters, digits, . _ -)');
  }
  const auth = raw.AZURE_OPENAI_AUTH ?? 'managed-identity';
  const apiKey = raw.AZURE_OPENAI_API_KEY;

  if (auth === 'api-key') {
    if (apiKey === undefined) {
      ctx.fail('AZURE_OPENAI_API_KEY', 'is required when AZURE_OPENAI_AUTH=api-key');
    }
    if (ctx.deployed) {
      ctx.fail(
        'AZURE_OPENAI_AUTH',
        "must be 'managed-identity' when APP_ENV is staging or production",
      );
    }
  } else if (apiKey !== undefined) {
    if (ctx.deployed) {
      ctx.fail('AZURE_OPENAI_API_KEY', 'must not be set when APP_ENV is staging or production');
    } else {
      ctx.warn(
        'AZURE_OPENAI_API_KEY is set but ignored because AZURE_OPENAI_AUTH=managed-identity.',
      );
    }
  }

  return {
    provider,
    endpoint: endpoint ?? '',
    deployment: deployment ?? '',
    apiVersion: raw.AZURE_OPENAI_API_VERSION ?? DEFAULT_API_VERSION,
    auth,
    apiKey: auth === 'api-key' && apiKey !== undefined ? new Secret(apiKey) : null,
    limits,
  };
}
