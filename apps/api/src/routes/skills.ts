import type { HandlerMap } from '../http/route-binder';
import type { Infrastructure } from '../infrastructure';
import { engineBudgetFor, type EngineBudgetCaller } from '../services/engine-budget';

/**
 * skillMatches.list, skillMatches.apply, skills.list, skills.get, skills.versions, skills.diff,
 * skills.extract, skills.transition, skills.simulationTest, skills.proposeMutation,
 * skills.versionDecision, skills.rollback, skills.apply. Thin: the work lives in `services/skills`.
 *
 * Matching and applying run the engine on what was known at an instant. Every pass that no cache
 * serves spends one unit of the caller's engine budget, the same bucket the views draw from (429
 * with Retry-After when it is empty); the services announce such a pass before it starts.
 */
export function skillsRoutes(infra: Infrastructure): HandlerMap {
  const budget = engineBudgetFor(infra);
  const metered = (caller: EngineBudgetCaller) => ({
    beforeColdPass: () => budget.charge(caller),
  });

  return {
    'skillMatches.list': async ({ params, query, ctx }) => ({
      items: await ctx.services.skills.matchForCase(ctx, params.caseId, {
        asOf: query.asOf,
        ...metered(ctx),
      }),
    }),

    'skillMatches.apply': ({ params, ctx }) =>
      ctx.services.skills.applyMatch(ctx, params.caseId, params.matchId, metered(ctx)),

    'skills.list': ({ query, ctx }) => ctx.services.skills.list(ctx, query),

    'skills.get': ({ params, ctx }) => ctx.services.skills.get(ctx, params.skillId),

    'skills.versions': async ({ params, ctx }) => ({
      items: await ctx.services.skills.versions(ctx, params.skillId),
    }),

    'skills.diff': ({ params, query, ctx }) =>
      ctx.services.skills.diff(ctx, params.skillId, query.fromVersionId, query.toVersionId),

    'skills.extract': async ({ params, body, ctx }) => ({
      job: await ctx.services.skills.startExtraction(ctx, params.caseId, body.scenarioId),
    }),

    'skills.transition': ({ params, body, ctx }) =>
      ctx.services.skills.transition(ctx, params.skillId, body),

    'skills.simulationTest': ({ params, body, ctx }) =>
      ctx.services.skills.runValidation(ctx, params.skillId, body),

    'skills.proposeMutation': async ({ params, body, ctx }) => ({
      job: await ctx.services.skills.startMutation(ctx, params.skillId, body.sourceCaseId),
    }),

    'skills.versionDecision': ({ params, body, ctx }) =>
      ctx.services.skills.decideVersion(ctx, params.skillId, params.versionId, body),

    'skills.rollback': ({ params, body, ctx }) =>
      ctx.services.skills.rollback(ctx, params.skillId, body),

    'skills.apply': ({ params, body, ctx }) =>
      ctx.services.skills.applyToCase(ctx, params.caseId, body.skillId, metered(ctx)),
  };
}
