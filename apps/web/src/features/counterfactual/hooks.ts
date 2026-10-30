'use client';

import type { InvestigationGraph } from '@caseguard/schemas';
import type { QueryKey } from '@tanstack/react-query';
import { asOfCall, asOfFresh } from '../../components/case/as-of';
import { keepWithinBoundary } from '../../lib/api/boundary-placeholder';
import { useApiQuery } from '../../lib/api/hooks';
import { useAuth } from '../../lib/auth/context';

/**
 * The Lab's reads. Each one is enabled only when the part of the page that shows it is on screen. None serves the answer
 * of another case or another moment while its own loads (`keepWithinBoundary`): the page shows its loading state instead.
 */

export function useForkList(caseId: string) {
  const auth = useAuth();
  const read = { params: { caseId }, query: {} };
  return useApiQuery('forks.list', read, {
    enabled: auth.status === 'ready',
    placeholderData: keepWithinBoundary(read),
  });
}

export function useScenarioList(caseId: string) {
  const auth = useAuth();
  const read = { params: { caseId }, query: {} };
  return useApiQuery('counterfactuals.list', read, {
    enabled: auth.status === 'ready',
    placeholderData: keepWithinBoundary(read),
  });
}

/** The recorded actions, for the actual track of the comparison. */
export function useRecordedActions(caseId: string, enabled: boolean) {
  const auth = useAuth();
  return useApiQuery(
    'actions.list',
    { params: { caseId }, query: {} },
    { enabled: auth.status === 'ready' && enabled },
  );
}

/**
 * What was on record at the decision instant, for the evidence inspector. The scenario cites only evidence from before
 * that instant; this read is bounded by it, so it can never contain anything later. It is an earlier view, so the server
 * meters it: no hidden retries (the page shows the wait itself) and a window already computed stays fresh.
 */
export function useDecisionTimeEvidence(caseId: string, boundary: string | null) {
  const auth = useAuth();
  return useApiQuery(
    'hypotheses.list',
    {
      params: { caseId },
      query: boundary ? { asOf: boundary } : {},
      ...asOfCall(boundary),
    },
    { enabled: auth.status === 'ready' && boundary !== null, ...asOfFresh(boundary) },
  );
}

/** The scenario a cached graph request was about (`queryKeys.request` keeps the query at position 4 of the key). */
const scenarioOfKey = (queryKey: QueryKey): string | undefined => {
  const query: unknown = queryKey[4];
  if (typeof query !== 'object' || query === null) return undefined;
  const scenarioId = (query as { scenarioId?: unknown }).scenarioId;
  return typeof scenarioId === 'string' ? scenarioId : undefined;
};

/**
 * The previous graph stays on screen only for the same case, the same moment and the same simulated path: while the graph
 * of another moment (the whole record under the decision-time view) or of another strategy's path loads, nothing of it is
 * shown, because every node and connection would describe something other than what is named above it.
 */
function keepSameGraph(read: {
  params: { caseId: string };
  query: { scenarioId?: string; asOf?: string };
}) {
  const sameMoment = keepWithinBoundary<InvestigationGraph>(read);
  return (
    previous: InvestigationGraph | undefined,
    previousQuery: { queryKey: QueryKey } | undefined,
  ): InvestigationGraph | undefined =>
    previousQuery !== undefined && scenarioOfKey(previousQuery.queryKey) === read.query.scenarioId
      ? sameMoment(previous, previousQuery)
      : undefined;
}

/**
 * The investigation graph for one view mode (the caller picks the boundary and the scenario). With a boundary it is an
 * earlier view: metered by the server, never retried behind the scenes and kept fresh once computed. A superseded
 * request is cancelled by TanStack Query's abort signal when the mode or the scenario changes.
 */
export function useGraphQuery(
  caseId: string,
  options: { scenarioId: string | null; asOf: string | null; enabled: boolean },
) {
  const auth = useAuth();
  const query: { scenarioId?: string; asOf?: string } = {};
  if (options.scenarioId) query.scenarioId = options.scenarioId;
  if (options.asOf) query.asOf = options.asOf;
  const read = { params: { caseId }, query };
  return useApiQuery(
    'graph.get',
    { ...read, ...asOfCall(options.asOf) },
    {
      enabled: auth.status === 'ready' && options.enabled,
      placeholderData: keepSameGraph(read),
      ...asOfFresh(options.asOf),
    },
  );
}

/** The post-hoc hindsight check. It is only requested when the person asks for it, never on page load. */
export function useHindsightQuery(caseId: string, scenarioId: string | null, enabled: boolean) {
  const auth = useAuth();
  return useApiQuery(
    'counterfactuals.hindsight',
    { params: { caseId, scenarioId: scenarioId ?? '' } },
    { enabled: auth.status === 'ready' && enabled && scenarioId !== null, staleTime: 60_000 },
  );
}
