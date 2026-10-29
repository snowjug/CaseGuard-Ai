import type { AnalysisRun, Case } from '@caseguard/schemas';
import { ConflictError, NotFoundError } from '../../errors';
import type { RequestContext } from '../../http/request-context';
import { loadAnalysisInputs, type AnalysisInputs } from '../analysis/inputs';

export const NOT_ANALYSED_MESSAGE = 'This case has not been analysed yet. Start an analysis first.';

/** A case that exists in the caller's tenant together with its latest analysis run. */
export interface CaseRun {
  readonly caseRecord: Case;
  readonly run: AnalysisRun;
}

/**
 * The cheap loader for views that serve stored artefacts: 404 for an unknown or other-tenant case,
 * 409 when the case has never been analysed.
 */
export async function loadCaseRun(ctx: RequestContext, caseId: string): Promise<CaseRun> {
  const [caseRecord, run] = await Promise.all([
    ctx.repos.cases.get(caseId),
    ctx.repos.analysis.getLatestRun(caseId),
  ]);
  if (caseRecord === null) throw new NotFoundError('Case', caseId);
  if (run === null) throw new ConflictError(NOT_ANALYSED_MESSAGE);
  return { caseRecord, run };
}

/** Everything a view needs to recompute from the immutable record: the analysis inputs and the latest run. */
export interface ViewState {
  readonly inputs: AnalysisInputs;
  /** Null while the case has never been analysed. */
  readonly run: AnalysisRun | null;
}

/**
 * The single loader of a case's stored state for views that may recompute: the analysis inputs (404
 * for an unknown or other-tenant case) and the latest run.
 */
export async function loadViewState(ctx: RequestContext, caseId: string): Promise<ViewState> {
  const [inputs, run] = await Promise.all([
    loadAnalysisInputs(ctx, caseId),
    ctx.repos.analysis.getLatestRun(caseId),
  ]);
  return { inputs, run };
}

/** The run of an artefact view; 409 when the case has never been analysed. */
export function requireRun(state: ViewState): AnalysisRun {
  if (state.run === null) throw new ConflictError(NOT_ANALYSED_MESSAGE);
  return state.run;
}
