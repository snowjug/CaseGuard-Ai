import type { AiHealth } from '@caseguard/ai';
import type { AppConfig } from '@caseguard/config';
import { STANDARD_HEALTH_CHECKS } from '@caseguard/observability';
import type { DependencyHealth } from '@caseguard/schemas';
import { hostOf } from './provider-status';

/*
 * The health registry only probes what the container registered, and it registers in-process
 * stand-ins only. When a real provider is configured its check is "disabled" there, which would read as
 * "not used". These helpers keep the dependency list honest: the AI provider row comes from the AI
 * service's runtime state, a configured-but-unprobed integration is `unknown` (never `healthy`), and the
 * cache and identity rows exist so every dependency of the platform is visible.
 */

const SEARCH = STANDARD_HEALTH_CHECKS.search.name;
const MODEL_PROVIDER = STANDARD_HEALTH_CHECKS.modelProvider.name;
/** The dependency contract bounds `detail`; the registry applies the same bound to its own rows. */
const MAX_DETAIL_CHARS = 400;

/** The model-provider row from the AI service's health, under the registry's dependency name. */
export function modelProviderRow(
  ai: AiHealth | null,
  config: AppConfig,
  checkedAt: string,
): DependencyHealth {
  if (ai !== null) return { ...ai.dependency, name: MODEL_PROVIDER, kind: 'ai_provider' };
  return {
    name: MODEL_PROVIDER,
    kind: 'ai_provider',
    status: 'unhealthy',
    latencyMs: null,
    detail: 'The AI provider could not be initialised; see the server log.',
    checkedAt,
    simulated: config.ai.provider === 'deterministic',
  };
}

function searchNotProbed(
  dependency: DependencyHealth,
  config: AppConfig,
  checkedAt: string,
): DependencyHealth | null {
  if (dependency.status !== 'disabled') return null;
  if (dependency.name !== SEARCH || config.search.provider !== 'azure-ai-search') return null;
  return {
    ...dependency,
    status: 'unknown',
    simulated: false,
    latencyMs: null,
    checkedAt,
    detail:
      `Azure AI Search is configured (${hostOf(config.search.endpoint)}, index "${config.search.index}") but not probed here; implemented, validated against mocks only. Searches fall back to built-in lexical search when it fails.`.slice(
        0,
        MAX_DETAIL_CHARS,
      ),
  };
}

function cacheRow(checkedAt: string): DependencyHealth {
  return {
    name: 'cache',
    kind: 'cache',
    status: 'healthy',
    latencyMs: null,
    detail: 'In-process memory cache. A shared cache (Redis) is reserved but not implemented.',
    checkedAt,
    simulated: true,
  };
}

function identityRow(config: AppConfig, checkedAt: string): DependencyHealth {
  if (config.auth.mode === 'dev') {
    return {
      name: 'identity',
      kind: 'identity',
      status: 'healthy',
      latencyMs: null,
      detail:
        'Development personas: synthetic identities, not a real identity provider. Disabled in staging and production.',
      checkedAt,
      simulated: true,
    };
  }
  return {
    name: 'identity',
    kind: 'identity',
    status: 'unknown',
    latencyMs: null,
    detail:
      'Microsoft Entra ID tokens are validated on every request. The integration is implemented and unit-tested with locally generated keys only; the key endpoint is not probed here.',
    checkedAt,
    simulated: false,
  };
}

/**
 * Registry results made honest: the model-provider row reflects the AI service (or its failure), an
 * unprobed Azure AI Search is `unknown`, and the cache and identity rows are added once.
 */
export function reconcileDependencies(
  dependencies: readonly DependencyHealth[],
  config: AppConfig,
  checkedAt: string,
  ai: AiHealth | null,
): DependencyHealth[] {
  const reconciled = dependencies.map((dependency) =>
    dependency.name === MODEL_PROVIDER
      ? modelProviderRow(ai, config, checkedAt)
      : (searchNotProbed(dependency, config, checkedAt) ?? dependency),
  );
  const present = new Set(dependencies.map((dependency) => dependency.name));
  if (!present.has(MODEL_PROVIDER)) reconciled.push(modelProviderRow(ai, config, checkedAt));
  if (!present.has('cache')) reconciled.push(cacheRow(checkedAt));
  if (!present.has('identity')) reconciled.push(identityRow(config, checkedAt));
  return reconciled;
}
