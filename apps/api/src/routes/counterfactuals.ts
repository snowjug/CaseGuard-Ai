import type { HandlerMap } from '../http/route-binder';
import type { Infrastructure } from '../infrastructure';

/**
 * counterfactuals.run, counterfactuals.list, counterfactuals.get, counterfactuals.review,
 * counterfactuals.hindsight. Thin: the work lives in `services/counterfactuals`.
 */
export function counterfactualRoutes(_infra: Infrastructure): HandlerMap {
  return {
    'counterfactuals.run': async ({ params, body, ctx }) => ({
      job: await ctx.services.counterfactuals.startRun(
        ctx,
        params.caseId,
        params.forkId,
        body.strategies,
      ),
    }),

    'counterfactuals.list': async ({ params, query, ctx }) => ({
      items: await ctx.services.counterfactuals.list(ctx, params.caseId, {
        forkId: query.forkId,
      }),
    }),

    'counterfactuals.get': ({ params, ctx }) =>
      ctx.services.counterfactuals.get(ctx, params.caseId, params.scenarioId),

    'counterfactuals.review': ({ params, body, ctx }) =>
      ctx.services.counterfactuals.review(ctx, params.caseId, params.scenarioId, body),

    'counterfactuals.hindsight': ({ params, ctx }) =>
      ctx.services.counterfactuals.hindsight(ctx, params.caseId, params.scenarioId),
  };
}
