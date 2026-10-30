import type { HandlerMap } from '../http/route-binder';
import type { Infrastructure } from '../infrastructure';
import {
  compareCases,
  dismissWarning,
  getCoaching,
  getEventDetail,
  getFork,
  getGraph,
  getMetrics,
  getQuality,
  getTimeline,
  getTwin,
  listActions,
  listForks,
  listHypotheses,
  listLedger,
  listWarnings,
  overrideAction,
  rankActions,
  reviewClaim,
  viewDepsFor,
} from '../services/views';

/**
 * Read and review views over a stored analysis: twin.get, timeline.get, events.get, evidence.list,
 * claims.review, hypotheses.list, actions.list, actionValue.rank, actionValue.override, forks.list,
 * forks.get, graph.get, quality.get, metrics.get, warnings.list, warnings.dismiss, coaching.get,
 * compare.cases. Owner: API views workstream. The routes only map HTTP to `services/views`; the
 * binder enforces each route's permission and validates its parameters, query and body.
 *
 * Every view that accepts `asOf` recomputes the engine on what was known then (never a filtered copy
 * of the final analysis). One engine pass serves every instant of a window between two events and is
 * kept in a size-bounded cache per app; a request that has to run a cold pass spends one unit of the
 * caller's engine budget (429 with Retry-After when it is empty), and cached reads are free.
 */
export function viewsRoutes(infra: Infrastructure): HandlerMap {
  const deps = viewDepsFor(infra);

  return {
    'twin.get': ({ params, query, ctx }) => getTwin(ctx, deps, params.caseId, query),
    'timeline.get': ({ params, query, ctx }) => getTimeline(ctx, deps, params.caseId, query),
    'events.get': ({ params, query, ctx }) =>
      getEventDetail(ctx, deps, params.caseId, params.eventId, query),
    'evidence.list': ({ params, query, ctx }) => listLedger(ctx, deps, params.caseId, query),
    'claims.review': ({ params, body, ctx }) =>
      reviewClaim(ctx, params.caseId, params.claimId, body),
    'hypotheses.list': ({ params, query, ctx }) => listHypotheses(ctx, deps, params.caseId, query),
    'actions.list': ({ params, query, ctx }) => listActions(ctx, deps, params.caseId, query),
    'actionValue.rank': ({ params, query, ctx }) => rankActions(ctx, deps, params.caseId, query),
    'actionValue.override': ({ params, body, ctx }) =>
      overrideAction(ctx, deps, params.caseId, body),
    'forks.list': ({ params, query, ctx }) => listForks(ctx, deps, params.caseId, query),
    'forks.get': ({ params, query, ctx }) =>
      getFork(ctx, deps, params.caseId, params.forkId, query),
    'graph.get': ({ params, query, ctx }) => getGraph(ctx, deps, params.caseId, query),
    'quality.get': ({ params, query, ctx }) => getQuality(ctx, deps, params.caseId, query),
    'metrics.get': ({ params, query, ctx }) => getMetrics(ctx, deps, params.caseId, query),
    'warnings.list': ({ params, query, ctx }) => listWarnings(ctx, deps, params.caseId, query),
    'warnings.dismiss': ({ params, body, ctx }) =>
      dismissWarning(ctx, params.caseId, params.warningId, body),
    'coaching.get': ({ params, ctx }) => getCoaching(ctx, params.caseId),
    'compare.cases': ({ query, ctx }) => compareCases(ctx, query),
  };
}
