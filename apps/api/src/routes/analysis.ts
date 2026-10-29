import type { HandlerMap } from '../http/route-binder';
import { NotFoundError } from '../errors';
import type { Infrastructure } from '../infrastructure';

/** analysis.start, analysis.latest and the job routes. The views over an analysis live in `views.ts`. */
export function analysisRoutes(_infra: Infrastructure): HandlerMap {
  return {
    'analysis.start': ({ params, body, ctx }) =>
      ctx.services.analysis.startAnalysis(ctx, params.caseId, { force: body.force }),

    'analysis.latest': async ({ params, ctx }) => {
      if ((await ctx.repos.cases.get(params.caseId)) === null) {
        throw new NotFoundError('Case', params.caseId);
      }
      return { run: await ctx.repos.analysis.getLatestRun(params.caseId) };
    },

    'jobs.get': async ({ params, ctx }) => {
      const job = await ctx.repos.jobs.get(params.jobId);
      if (job === null) throw new NotFoundError('Job', params.jobId);
      return job;
    },

    'jobs.cancel': ({ params, ctx }) => ctx.services.jobs.cancel(ctx, params.jobId),

    'jobs.list': ({ query, ctx }) => ctx.repos.jobs.list(query),
  };
}
