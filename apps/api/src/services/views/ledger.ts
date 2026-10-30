import {
  EVIDENCE_CATEGORIES,
  type Claim,
  type Evidence,
  type EvidenceLedgerResponse,
  type Hypothesis,
  type MissingEvidence,
} from '@caseguard/schemas';
import { decodeCursor, encodeCursor } from '../../db/cursor';
import type { QueryOf } from '../../http/route-binder';
import type { RequestContext } from '../../http/request-context';
import { computationFor, type ViewDeps } from './computation';
import { hypothesisAliases } from './hypotheses';
import { canonicalInstant, compareInstants, compareText } from './instants';
import { loadStoredClaims, overlayClaims } from './overlay';
import { pageAfter, unique } from './paging';
import { loadCaseRun, loadViewState } from './state';

type LedgerQuery = QueryOf<'evidence.list'>;

const referencedEvidenceIds = (claims: readonly Claim[]): string[] =>
  unique(
    claims.flatMap((claim) => [...claim.supportingEvidenceIds, ...claim.contradictingEvidenceIds]),
  );

function countByCategory(claims: readonly Claim[]): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(
    EVIDENCE_CATEGORIES.map((category) => [category, 0]),
  );
  for (const claim of claims) counts[claim.category] = (counts[claim.category] ?? 0) + 1;
  return counts;
}

const byTimeThenId = (a: Claim, b: Claim): number =>
  compareInstants(a.timestamp, b.timestamp) || compareText(a.id, b.id);

interface LedgerCursor {
  readonly at: string;
  readonly id: string;
}

/** Validates the cursor before any work is done for it (a bad cursor is a 422, never a recomputation). */
function parseCursor(cursor: string | undefined): LedgerCursor | null {
  const decoded = decodeCursor('claims', cursor, ['timestamp', 'text']);
  return decoded === null ? null : { at: String(decoded[0]), id: String(decoded[1]) };
}

/** The claims of one view of the case, with what the response needs next to them. */
interface LedgerSource {
  readonly asOf: string | null;
  /** Every claim known in the view, reviewers' decisions applied. */
  readonly claims: readonly Claim[];
  readonly hypotheses: readonly Pick<Hypothesis, 'id' | 'key'>[];
  readonly missing: MissingEvidence[];
  readonly evidenceFor: (ids: readonly string[]) => Promise<Evidence[]>;
}

/** The same filters the data tier applies to stored claims (a hypothesis may be named by id or key). */
function matchesFilters(query: LedgerQuery, source: LedgerSource): (claim: Claim) => boolean {
  const needle = query.q?.trim().toLowerCase() ?? '';
  const aliases =
    query.hypothesisId === undefined
      ? null
      : hypothesisAliases(source.hypotheses, query.hypothesisId);
  return (claim) =>
    (query.category === undefined || claim.category === query.category) &&
    (query.reviewState === undefined || claim.reviewState === query.reviewState) &&
    (aliases === null || claim.relatedHypothesisIds.some((id) => aliases.has(id))) &&
    (needle === '' ||
      claim.text.toLowerCase().includes(needle) ||
      (claim.subject ?? '').toLowerCase().includes(needle));
}

/** Filters, orders and pages the claims of a view with an opaque keyset cursor (time, then id). */
async function pageLedger(
  source: LedgerSource,
  query: LedgerQuery,
  after: LedgerCursor | null,
): Promise<EvidenceLedgerResponse> {
  const ordered = [...source.claims].sort(byTimeThenId);
  const page = pageAfter(ordered.filter(matchesFilters(query, source)), {
    limit: query.limit,
    hasCursor: after !== null,
    isAfterCursor: (claim) => {
      if (after === null) return true;
      const order = compareInstants(claim.timestamp, after.at);
      return order > 0 || (order === 0 && compareText(claim.id, after.id) > 0);
    },
    cursorOf: (claim) => encodeCursor('claims', [canonicalInstant(claim.timestamp), claim.id]),
  });
  return {
    items: page.items,
    nextCursor: page.nextCursor,
    asOf: source.asOf,
    counts: countByCategory(ordered),
    evidence: await source.evidenceFor(referencedEvidenceIds(page.items)),
    missing: source.missing,
  };
}

/** The ledger as it stands, filtered and paged by the repository. */
async function storedLedger(
  ctx: RequestContext,
  caseId: string,
  query: LedgerQuery,
): Promise<EvidenceLedgerResponse> {
  const [page, counts, missing] = await Promise.all([
    ctx.repos.analysis.listClaims(caseId, {
      category: query.category,
      reviewState: query.reviewState,
      q: query.q,
      limit: query.limit,
      cursor: query.cursor,
    }),
    ctx.repos.analysis.countClaimsByCategory(caseId),
    ctx.repos.analysis.listMissing(caseId),
  ]);
  const evidence = await ctx.repos.analysis.listEvidence(caseId, {
    ids: referencedEvidenceIds(page.items),
  });
  return { items: page.items, nextCursor: page.nextCursor, asOf: null, counts, evidence, missing };
}

/**
 * The stored ledger filtered by hypothesis. Claims name the knowledge-pack key of the hypotheses
 * they relate to while the rest of the API names the hypothesis record, so the filter has to accept
 * both and is applied here rather than by an exact match in the data tier.
 */
async function storedLedgerByHypothesis(
  ctx: RequestContext,
  caseId: string,
  query: LedgerQuery,
  after: LedgerCursor | null,
): Promise<EvidenceLedgerResponse> {
  const [claims, hypotheses, missing] = await Promise.all([
    loadStoredClaims(ctx, caseId),
    ctx.repos.analysis.listHypotheses(caseId),
    ctx.repos.analysis.listMissing(caseId),
  ]);
  return pageLedger(
    {
      asOf: null,
      claims: [...claims.values()],
      hypotheses,
      missing,
      evidenceFor: (ids) => ctx.repos.analysis.listEvidence(caseId, { ids }),
    },
    query,
    after,
  );
}

/**
 * The ledger as it was known at `asOf`: the engine analyses only the events up to then (so a claim's
 * supporting and contradicting evidence, related hypotheses and explanation cannot mention anything
 * later), and the reviewers' decisions and stored versions are laid over the result.
 */
async function ledgerAsOf(
  ctx: RequestContext,
  deps: ViewDeps,
  caseId: string,
  query: LedgerQuery,
  asOf: string,
  after: LedgerCursor | null,
): Promise<EvidenceLedgerResponse> {
  const state = await loadViewState(ctx, caseId);
  const computation = computationFor(ctx, deps, state, asOf);
  const [analysis, stored] = await Promise.all([
    computation.analysis(),
    loadStoredClaims(ctx, caseId),
  ]);
  const evidenceById = new Map(analysis.evidence.map((item) => [item.id, item]));
  return pageLedger(
    {
      asOf,
      claims: overlayClaims(analysis.claims, stored, asOf),
      hypotheses: analysis.hypotheses,
      missing: analysis.missing,
      evidenceFor: (ids) =>
        Promise.resolve(
          ids.flatMap((id) => {
            const item = evidenceById.get(id);
            return item === undefined ? [] : [item];
          }),
        ),
    },
    query,
    after,
  );
}

export async function listLedger(
  ctx: RequestContext,
  deps: ViewDeps,
  caseId: string,
  query: LedgerQuery,
): Promise<EvidenceLedgerResponse> {
  const after = parseCursor(query.cursor);
  if (query.asOf !== undefined) return ledgerAsOf(ctx, deps, caseId, query, query.asOf, after);
  await loadCaseRun(ctx, caseId);
  return query.hypothesisId === undefined
    ? storedLedger(ctx, caseId, query)
    : storedLedgerByHypothesis(ctx, caseId, query, after);
}
