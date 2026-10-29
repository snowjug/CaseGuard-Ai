import type { HandlerMap } from '../http/route-binder';
import type { Infrastructure } from '../infrastructure';
import { createSearchService, type SearchServiceOptions } from '../services/search';

/**
 * search.global. Owner: API platform workstream. Results are tenant-scoped by the repositories (or by
 * the mandatory tenant filter of the optional Azure AI Search adapter); the query text is validated by
 * the contract and never logged.
 */
export function searchRoutes(
  _infra: Infrastructure,
  options: SearchServiceOptions = {},
): HandlerMap {
  const search = createSearchService(options);

  return {
    'search.global': async ({ query, ctx }) => ({
      items: await search.search(ctx, { text: query.q, limit: query.limit }),
    }),
  };
}
