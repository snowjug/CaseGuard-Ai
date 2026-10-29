import type { HandlerMap } from '../http/route-binder';
import type { Infrastructure } from '../infrastructure';

/**
 * analysis.start, analysis.latest, jobs.get, jobs.cancel, jobs.list, twin.get, timeline.get,
 * events.get, evidence.list, claims.review, hypotheses.list, actions.list, actionValue.rank,
 * actionValue.override, forks.list, forks.get, graph.get, quality.get, metrics.get, warnings.list,
 * warnings.dismiss, coaching.get, compare.cases.
 * Owner: API analysis workstream.
 */
export function analysisRoutes(_infra: Infrastructure): HandlerMap {
  return {};
}
