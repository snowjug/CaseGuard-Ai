import { mergeHandlers, type HandlerMap } from '../http/route-binder';
import type { Infrastructure } from '../infrastructure';
import { analysisRoutes } from './analysis';
import { casesRoutes } from './cases';
import { counterfactualRoutes } from './counterfactuals';
import { dashboardRoutes } from './dashboard';
import { demoRoutes } from './demo';
import { governanceRoutes } from './governance';
import { ingestionRoutes } from './ingestion';
import { searchRoutes } from './search';
import { sessionRoutes } from './session';
import { skillsRoutes } from './skills';
import { systemRoutes } from './system';
import { viewsRoutes } from './views';

/**
 * Every handler of the API, one group per area. A route may be claimed by exactly one group
 * (`mergeHandlers` throws otherwise); `missingHandlers` lists contract routes nobody claimed.
 */
export function createHandlers(infra: Infrastructure): HandlerMap {
  return mergeHandlers(
    sessionRoutes(infra),
    ingestionRoutes(infra),
    casesRoutes(infra),
    analysisRoutes(infra),
    viewsRoutes(infra),
    counterfactualRoutes(infra),
    skillsRoutes(infra),
    governanceRoutes(infra),
    searchRoutes(infra),
    dashboardRoutes(infra),
    demoRoutes(infra),
    systemRoutes(infra),
  );
}
