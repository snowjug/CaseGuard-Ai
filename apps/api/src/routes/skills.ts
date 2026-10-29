import type { HandlerMap } from '../http/route-binder';
import type { Infrastructure } from '../infrastructure';

/**
 * skillMatches.list, skillMatches.apply, skills.list, skills.get, skills.versions, skills.diff,
 * skills.extract, skills.transition, skills.simulationTest, skills.proposeMutation,
 * skills.versionDecision, skills.rollback, skills.apply.
 * Owner: API counterfactual/skills workstream.
 */
export function skillsRoutes(_infra: Infrastructure): HandlerMap {
  return {};
}
