import type { HandlerMap } from '../http/route-binder';
import type { Infrastructure } from '../infrastructure';

/** system.health, system.metrics, system.provider. Owner: API platform workstream. */
export function systemRoutes(_infra: Infrastructure): HandlerMap {
  return {};
}
