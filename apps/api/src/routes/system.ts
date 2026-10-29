import { buildRequestMetrics } from '@caseguard/observability';
import type { HandlerMap } from '../http/route-binder';
import type { Infrastructure } from '../infrastructure';
import { buildSystemHealth, readAiHealth, readProviderStatus } from '../services/system';

/**
 * system.health, system.metrics, system.provider. Owner: API platform workstream.
 *
 * Dependency health and metrics are process-wide (health registry, metrics registry, migration status);
 * the AI provider state comes from the AI service for the caller's tenant (`ctx.services.ai`), because
 * the effective limits follow that tenant's governed model settings. Nothing here exposes tenant data
 * or secrets.
 */
export function systemRoutes(infra: Infrastructure): HandlerMap {
  // Counters start with the process, so this construction time is the `since` of the metrics.
  const since = infra.now().toISOString();

  return {
    'system.health': async ({ ctx }) => buildSystemHealth(infra, await readAiHealth(ctx)),

    'system.metrics': async () => buildRequestMetrics(infra.metricsRegistry, { since }),

    'system.provider': async ({ ctx }) => readProviderStatus(ctx),
  };
}
