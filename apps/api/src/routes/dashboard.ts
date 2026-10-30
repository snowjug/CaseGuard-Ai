import type { HandlerMap } from '../http/route-binder';
import type { Infrastructure } from '../infrastructure';
import { getAnalyticsOverview } from '../services/analytics';
import { getCommandCenter } from '../services/dashboard';
import { getEfficiencyOverview } from '../services/efficiency';

/**
 * dashboard.commandCenter, efficiency.overview, efficiency.executions, analytics.overview. Owner: API
 * insights workstream (`search.global` has its own group, `routes/search.ts`).
 *
 * Only maps HTTP to the services under `services/{dashboard,efficiency,analytics}`. All four are reads
 * through the caller's tenant-bound repositories; permissions come from the contract (`case:read`,
 * `telemetry:read`, `analytics:read`), so a manager sees analytics and a reviewer does not.
 */
export function dashboardRoutes(infra: Infrastructure): HandlerMap {
  return {
    'dashboard.commandCenter': ({ query, ctx }) => getCommandCenter(ctx, infra, query),

    'efficiency.overview': ({ query, ctx }) => getEfficiencyOverview(ctx, query),

    'efficiency.executions': ({ query, ctx }) => ctx.repos.telemetry.listExecutions(query),

    'analytics.overview': ({ ctx }) => getAnalyticsOverview(ctx),
  };
}
