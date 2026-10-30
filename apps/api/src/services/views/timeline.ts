import { buildTimelineResponse, type DeterministicAnalysis } from '@caseguard/domain';
import type { TimelineResponse } from '@caseguard/schemas';
import { decodeCursor, encodeCursor } from '../../db/cursor';
import type { QueryOf } from '../../http/route-binder';
import type { RequestContext } from '../../http/request-context';
import { computationFor, type ViewDeps } from './computation';
import { hypothesisAliases } from './hypotheses';
import { canonicalInstant, compareInstants } from './instants';
import { loadStoredClaims, overlayClaims } from './overlay';
import { pageAfter } from './paging';
import { loadScenario, scenarioForWindow } from './scenarios';
import { loadViewState } from './state';
import { applyTimelineFilters, parseTimelineFilters } from './timeline-filters';
import { openWarningCount } from './warnings';

/** Events that bear on one hypothesis: they carry evidence linked to it, a related claim or a step aimed at it. */
export function eventsRelatedTo(
  hypothesisId: string,
  analysis: DeterministicAnalysis,
): Set<string> {
  const aliases = hypothesisAliases(analysis.hypotheses, hypothesisId);
  const eventOfEvidence = new Map(analysis.evidence.map((item) => [item.id, item.eventId]));
  const related = new Set<string>();
  for (const link of analysis.links) {
    const eventId = aliases.has(link.hypothesisId)
      ? eventOfEvidence.get(link.evidenceId)
      : undefined;
    if (eventId !== undefined) related.add(eventId);
  }
  for (const claim of analysis.claims) {
    if (claim.eventId !== null && claim.relatedHypothesisIds.some((id) => aliases.has(id))) {
      related.add(claim.eventId);
    }
  }
  for (const action of analysis.actions) {
    const aimedAt = action.targetHypothesisIds.some((id) => aliases.has(id));
    if (aimedAt || (action.statedHypothesisId !== null && aliases.has(action.statedHypothesisId))) {
      related.add(action.eventId);
    }
  }
  return related;
}

/**
 * The chronological timeline of the record, or of what was known at `asOf`. Inside a window the
 * engine analyses only the events up to then, later events never reach the builder, and the response
 * carries only the number of events withheld. Filters, the zoom window and the keyset cursor are
 * applied here; delays and repeats are limited to the events on the page.
 */
export async function getTimeline(
  ctx: RequestContext,
  deps: ViewDeps,
  caseId: string,
  query: QueryOf<'timeline.get'>,
): Promise<TimelineResponse> {
  const asOf = query.asOf ?? null;
  const filters = parseTimelineFilters(query, asOf);
  const decoded = decodeCursor('events', query.cursor, ['timestamp', 'int']);
  const after = decoded === null ? null : { at: String(decoded[0]), sequence: Number(decoded[1]) };

  const state = await loadViewState(ctx, caseId);
  const computation = computationFor(ctx, deps, state, asOf);
  const [analysis, stored, scenario, openWarnings] = await Promise.all([
    computation.analysis(),
    loadStoredClaims(ctx, caseId),
    query.scenarioId === undefined ? null : loadScenario(ctx, caseId, query.scenarioId),
    openWarningCount(ctx, caseId, computation),
  ]);
  const reviewed: DeterministicAnalysis = {
    ...analysis,
    claims: overlayClaims(analysis.claims, stored, asOf),
  };

  const whole = buildTimelineResponse({
    caseRecord: state.inputs.caseRecord,
    events: computation.events,
    analysis: reviewed,
    asOf,
    scenario: scenarioForWindow(scenario, asOf),
    offset: 0,
    limit: Math.max(1, computation.events.length),
    openWarningCount: openWarnings,
  });

  const related =
    filters.hypothesisId === null ? null : eventsRelatedTo(filters.hypothesisId, reviewed);
  const matching = applyTimelineFilters(whole.events, filters, related);
  const page = pageAfter(matching, {
    limit: query.limit,
    hasCursor: after !== null,
    isAfterCursor: (event) => {
      if (after === null) return true;
      const order = compareInstants(event.timestamp, after.at);
      return order > 0 || (order === 0 && event.sequence > after.sequence);
    },
    cursorOf: (event) =>
      encodeCursor('events', [canonicalInstant(event.timestamp), event.sequence]),
  });
  const onPage = new Set(page.items.map((event) => event.id));

  return {
    ...whole,
    events: page.items,
    nextCursor: page.nextCursor,
    total: matching.length,
    delays: whole.delays.filter((delay) => onPage.has(delay.toEventId)),
    repeats: whole.repeats.filter((repeat) => onPage.has(repeat.eventId)),
    withheldFutureEventCount: computation.withheldFutureEventCount,
  };
}
