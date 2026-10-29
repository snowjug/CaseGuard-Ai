import { buildDigitalTwin } from '@caseguard/domain';
import type { DigitalTwin } from '@caseguard/schemas';
import { NotFoundError } from '../../errors';
import type { QueryOf } from '../../http/route-binder';
import type { RequestContext } from '../../http/request-context';
import { computationFor, type ViewDeps } from './computation';
import { loadCaseRun, loadViewState } from './state';

/**
 * The digital twin of the case. Without `asOf` it is the stored twin. With it the engine analyses
 * only the events up to that instant, the twin builder receives only those events (and the resolution
 * only once it is within the window), and the response carries only the number of events withheld.
 */
export async function getTwin(
  ctx: RequestContext,
  deps: ViewDeps,
  caseId: string,
  query: QueryOf<'twin.get'>,
): Promise<DigitalTwin> {
  if (query.asOf === undefined) {
    await loadCaseRun(ctx, caseId);
    const twin = await ctx.repos.analysis.getTwin(caseId);
    if (twin === null) throw new NotFoundError('Digital twin', caseId);
    return twin;
  }

  const state = await loadViewState(ctx, caseId);
  const computation = computationFor(deps, state, query.asOf);
  const analysis = await computation.analysis();
  const twin = buildDigitalTwin({
    caseRecord: state.inputs.caseRecord,
    events: computation.events,
    resolution: computation.view.resolution,
    analysis,
    pack: state.inputs.pack,
    ctx: computation.engineCtx,
    asOf: query.asOf,
  });
  return { ...twin, withheldFutureEventCount: computation.withheldFutureEventCount };
}
