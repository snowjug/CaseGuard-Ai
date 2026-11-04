import {
  RECORD_FINDINGS_LIMIT,
  SET_ASIDE_LIMIT,
  type RecordFindings,
  type SetAsideObservation,
} from '@caseguard/schemas';
import type { QueryOf } from '../../http/route-binder';
import type { RequestContext } from '../../http/request-context';
import { computationFor, type ViewDeps } from './computation';
import { loadViewState } from './state';

/**
 * What the record itself shows, read without a model: statements of the case that cannot both stand, patterns that need
 * more than one event, and the words the detectors read and did not count because the sentence does not state the fact
 * (a denial, a guess, a plan, a request). There is no stored copy: the engine reads the events of the window, so with
 * `asOf` nothing recorded later can reach the answer, and without it the answer is about the whole record. A cold pass
 * costs one unit of the caller's engine budget; a window another request already paid for is free.
 */
export async function getRecordFindings(
  ctx: RequestContext,
  deps: ViewDeps,
  caseId: string,
  query: QueryOf<'recordFindings.get'>,
): Promise<RecordFindings> {
  const state = await loadViewState(ctx, caseId);
  const analysis = await computationFor(ctx, deps, state, query.asOf ?? null).analysis();
  const { pack } = state.inputs;

  const setAside: SetAsideObservation[] = analysis.suppressed
    .slice(0, SET_ASIDE_LIMIT)
    .map((note) => ({
      signalId: note.signalId,
      signalLabel: (pack.signals.get(note.signalId)?.label ?? note.signalId).slice(0, 160),
      eventId: note.eventId,
      modality: note.modality,
      cue: note.cue === null ? null : note.cue.slice(0, 80),
      excerpt: note.excerpt.slice(0, 600),
    }));

  return {
    asOf: query.asOf ?? null,
    conflicts: analysis.conflicts.slice(0, RECORD_FINDINGS_LIMIT),
    sequenceFindings: analysis.sequenceFindings.slice(0, RECORD_FINDINGS_LIMIT),
    setAside,
    setAsideTotal: analysis.suppressedTotal,
  };
}
