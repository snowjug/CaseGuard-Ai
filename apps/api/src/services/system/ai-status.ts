import type { AiHealth } from '@caseguard/ai';
import type { ProviderStatus } from '@caseguard/schemas';
import type { RequestContext } from '../../http/request-context';
import { unavailableProvider, withConfiguration } from './provider-status';

/**
 * Runtime health of the AI provider for the caller's tenant (`ctx.services.ai`): provider status, the
 * last call, the circuit breaker. `null` when the AI service cannot report; the cause is logged, never
 * returned, because it can name endpoints or identities.
 */
export async function readAiHealth(ctx: RequestContext): Promise<AiHealth | null> {
  try {
    return await ctx.services.ai.health(ctx);
  } catch (error) {
    ctx.logger.warn({ err: error }, 'AI provider health could not be read');
    return null;
  }
}

/** `system.provider`: the AI service's runtime status plus what configuration says about it. */
export async function readProviderStatus(ctx: RequestContext): Promise<ProviderStatus> {
  try {
    return withConfiguration(await ctx.services.ai.status(ctx), ctx.config.ai);
  } catch (error) {
    ctx.logger.warn({ err: error }, 'AI provider status could not be read');
    return unavailableProvider(ctx.config.ai, ctx.now());
  }
}
