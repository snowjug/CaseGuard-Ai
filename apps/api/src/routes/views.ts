import type { HandlerMap } from '../http/route-binder';
import type { Infrastructure } from '../infrastructure';

/**
 * Read and review views over a stored analysis: twin.get, timeline.get, events.get, evidence.list,
 * claims.review, hypotheses.list, actions.list, actionValue.rank, actionValue.override, forks.list,
 * forks.get, graph.get, quality.get, metrics.get, warnings.list, warnings.dismiss, coaching.get,
 * compare.cases. Owner: API views workstream.
 */
export function viewsRoutes(_infra: Infrastructure): HandlerMap {
  return {};
}
