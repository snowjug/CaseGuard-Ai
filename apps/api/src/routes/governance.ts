import type { HandlerMap } from '../http/route-binder';
import type { Infrastructure } from '../infrastructure';

/**
 * governance.get, governance.update, governance.prompts, governance.users, governance.assignRoles,
 * governance.audit, governance.auditVerify, governance.reviews, governance.export.
 * Owner: API platform workstream.
 */
export function governanceRoutes(_infra: Infrastructure): HandlerMap {
  return {};
}
