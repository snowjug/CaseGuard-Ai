import type { CaseEvent, Claim, Evidence, EventDetail } from '@caseguard/schemas';
import { NotFoundError } from '../../errors';
import type { QueryOf } from '../../http/route-binder';
import type { RequestContext } from '../../http/request-context';
import { computationFor, type ViewDeps } from './computation';
import { compareInstants, compareText, knownBy } from './instants';
import { loadStoredClaims, overlayClaims } from './overlay';
import { loadViewState } from './state';

const reference = ({
  id,
  timestamp,
  type,
  title,
}: CaseEvent): EventDetail['responses'][number] => ({
  id,
  timestamp,
  type,
  title,
});

interface Derived {
  readonly claims: Claim[];
  readonly evidence: Evidence[];
}

const byTimeThenId = (a: Claim, b: Claim): number =>
  compareInstants(a.timestamp, b.timestamp) || compareText(a.id, b.id);

/** What the stored analysis derived from one event. */
async function storedDerived(
  ctx: RequestContext,
  caseId: string,
  eventId: string,
  at: string,
): Promise<Derived> {
  const [claims, evidence] = await Promise.all([
    loadStoredClaims(ctx, caseId),
    ctx.repos.analysis.listEvidence(caseId, { asOf: at }),
  ]);
  return {
    claims: [...claims.values()].filter((claim) => claim.eventId === eventId).sort(byTimeThenId),
    evidence: evidence.filter((item) => item.eventId === eventId),
  };
}

/** What the engine derives from one event when it analyses only what was known at `asOf`. */
async function derivedAsOf(
  ctx: RequestContext,
  deps: ViewDeps,
  caseId: string,
  eventId: string,
  asOf: string,
): Promise<Derived> {
  const state = await loadViewState(ctx, caseId);
  const computation = computationFor(deps, state, asOf);
  const [analysis, stored] = await Promise.all([
    computation.analysis(),
    loadStoredClaims(ctx, caseId),
  ]);
  return {
    claims: overlayClaims(
      analysis.claims.filter((claim) => claim.eventId === eventId),
      stored,
      asOf,
    ).sort(byTimeThenId),
    evidence: analysis.evidence.filter((item) => item.eventId === eventId),
  };
}

/**
 * One source event with the claims and evidence derived from it. It reads the immutable record, so
 * it works before the case is analysed (the derived lists are then empty). Inside an `asOf` window an
 * event recorded later is a 404 (never "exists but withheld"), replies are limited to what was
 * recorded by then, and the derived content is the engine's analysis of that window.
 */
export async function getEventDetail(
  ctx: RequestContext,
  deps: ViewDeps,
  caseId: string,
  eventId: string,
  query: QueryOf<'events.get'>,
): Promise<EventDetail> {
  const asOf = query.asOf ?? null;
  const known = knownBy(asOf);
  if ((await ctx.repos.cases.get(caseId)) === null) throw new NotFoundError('Case', caseId);
  const event = await ctx.repos.cases.getEvent(caseId, eventId);
  if (event === null || !known(event.timestamp)) throw new NotFoundError('Event', eventId);

  const [visible, run] = await Promise.all([
    ctx.repos.cases.getAllEvents(caseId, asOf === null ? {} : { asOf }),
    ctx.repos.analysis.getLatestRun(caseId),
  ]);
  const parent =
    event.inResponseTo === null
      ? undefined
      : visible.find((item) => item.id === event.inResponseTo);

  let derived: Derived = { claims: [], evidence: [] };
  if (run !== null) {
    derived =
      asOf === null
        ? await storedDerived(ctx, caseId, eventId, event.timestamp)
        : await derivedAsOf(ctx, deps, caseId, eventId, asOf);
  }

  return {
    event,
    claims: derived.claims,
    evidence: derived.evidence,
    inResponseTo: parent === undefined ? null : reference(parent),
    responses: visible.filter((item) => item.inResponseTo === eventId).map(reference),
  };
}
