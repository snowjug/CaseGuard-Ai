import {
  AZURE_VALIDATION_NOTE,
  DeterministicProvider,
  SCRIPTED_MODEL,
  SCRIPTED_VALIDATION_NOTE,
} from '@caseguard/ai';
import type { AiConfig } from '@caseguard/config';
import type { ProviderStatus } from '@caseguard/schemas';

const MAX_DETAIL_CHARS = 400;

/** The host of a configured endpoint, for display. Never includes a path, query or credentials. */
export function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return '(unparseable endpoint)';
  }
}

const clip = (text: string): string =>
  text.length <= MAX_DETAIL_CHARS ? text : `${text.slice(0, MAX_DETAIL_CHARS - 1)}…`;

function limitsOf(ai: AiConfig): ProviderStatus['limits'] {
  return {
    maxInputTokens: ai.limits.maxInputTokens,
    maxOutputTokens: ai.limits.maxOutputTokens,
    timeoutMs: ai.limits.timeoutMs,
    maxRetries: ai.limits.maxRetries,
  };
}

/**
 * What deployment configuration says about the provider and a runtime status does not: for the
 * deterministic engine that it is in-process with no network and no model; for Azure OpenAI the
 * endpoint host, deployment and authentication mode. Never a key, a path or a query string.
 */
export function configurationFacts(ai: AiConfig): string {
  if (ai.provider === 'deterministic') {
    return 'Runs in-process: no network call and no language model.';
  }
  if (ai.provider === 'scripted') {
    return 'Test double that replays a script: no network call and no language model. Allowed only when APP_ENV is local or test.';
  }
  const authentication =
    ai.auth === 'managed-identity'
      ? 'managed-identity authentication'
      : 'API-key authentication (local experiments only)';
  return `Endpoint ${hostOf(ai.endpoint)}, deployment "${ai.deployment}", ${authentication}.`;
}

/** Adds the configuration facts to a runtime status (once), keeping the contract's 400-character bound. */
export function withConfiguration(status: ProviderStatus, ai: AiConfig): ProviderStatus {
  const facts = configurationFacts(ai);
  return status.detail.includes(facts)
    ? status
    : { ...status, detail: clip(`${status.detail} ${facts}`) };
}

/**
 * Status derived from configuration only (no runtime state): the deterministic engine is simulated and
 * healthy; a remote provider's health is unknown because no call is made. Used as the base of
 * `unavailableProvider` and as the documented shape of the answer.
 */
export function describeProvider(ai: AiConfig, now: Date): ProviderStatus {
  const checkedAt = now.toISOString();
  if (ai.provider === 'deterministic') {
    const descriptor = new DeterministicProvider().describe();
    return {
      kind: 'deterministic',
      configured: true,
      healthy: true,
      model: descriptor.model,
      simulated: true,
      checkedAt,
      detail: clip(
        `In-process deterministic knowledge-pack engine. Results are simulated or estimated and labelled as such. ${configurationFacts(ai)}`,
      ),
      validationNote: descriptor.validationNote,
      limits: limitsOf(ai),
    };
  }
  if (ai.provider === 'scripted') {
    return {
      kind: 'scripted',
      configured: true,
      healthy: true,
      model: SCRIPTED_MODEL,
      simulated: true,
      checkedAt,
      detail: clip(
        `Scripted test provider. Every reply comes from a script, so nothing it returns says anything about a real model. ${configurationFacts(ai)}`,
      ),
      validationNote: SCRIPTED_VALIDATION_NOTE,
      limits: limitsOf(ai),
    };
  }
  return {
    kind: 'azure-openai',
    configured: true,
    healthy: null,
    model: ai.deployment,
    simulated: false,
    checkedAt,
    detail: clip(
      `${configurationFacts(ai)} This status reflects configuration only: no call is made to check it, so health is unknown until a model call succeeds.`,
    ),
    validationNote: AZURE_VALIDATION_NOTE,
    limits: limitsOf(ai),
  };
}

/**
 * The answer when the AI service cannot report (for example an endpoint the provider refuses, or
 * unreadable settings): what is configured, flagged not healthy, with no error text.
 */
export function unavailableProvider(ai: AiConfig, now: Date): ProviderStatus {
  return {
    ...describeProvider(ai, now),
    healthy: false,
    detail: clip(
      `The AI provider could not be initialised, so no model call can be made; see the server log. ${configurationFacts(ai)}`,
    ),
  };
}
