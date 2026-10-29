import type { HandlerMap } from '../http/route-binder';
import type { Infrastructure } from '../infrastructure';
import { deleteCase, getCaseDetail, listCases } from '../services/cases';

/** cases.list, cases.get, cases.delete. The routes only map HTTP to `services/cases`. */
export function casesRoutes(_infra: Infrastructure): HandlerMap {
  return {
    'cases.list': ({ query, ctx }) => listCases(ctx, query),
    'cases.get': ({ params, ctx }) => getCaseDetail(ctx, params.caseId),
    'cases.delete': ({ params, ctx }) => deleteCase(ctx, params.caseId),
  };
}
