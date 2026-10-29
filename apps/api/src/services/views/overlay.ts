import type { CaseWarning, Claim, DecisionFork, DiagnosticAction } from '@caseguard/schemas';
import type { RequestContext } from '../../http/request-context';
import { compareInstants } from './instants';

/*
 * An as-of view is recomputed by the engine on what was known then, so its artefacts carry fresh
 * metadata. People's decisions (reviews, dismissals) and the stored `version` that optimistic locking
 * needs live in the database, so they are laid over the recomputed artefacts by their stable id.
 */

const CLAIM_PAGE = 200;

/** Every stored claim of the case, read page by page (the data tier caps a case at 10,000 claims). */
export async function loadStoredClaims(
  ctx: RequestContext,
  caseId: string,
): Promise<Map<string, Claim>> {
  const claims = new Map<string, Claim>();
  let cursor: string | undefined;
  do {
    const page = await ctx.repos.analysis.listClaims(caseId, {
      limit: CLAIM_PAGE,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const claim of page.items) claims.set(claim.id, claim);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return claims;
}

/**
 * A recomputed claim with the reviewer's decision (when there is one) and the stored version. The
 * machine classification (`aiCategory`) stays the recomputed one; the effective category follows the
 * reviewer exactly as the data tier carries a correction across a re-analysis. Inside an `asOf`
 * window the reviewer's free-text note appears only when it had been written by then: a later note is
 * written with hindsight and may cite facts the window must not reveal. The label describes the claim
 * itself, so it stays.
 */
export function overlayClaim(
  computed: Claim,
  stored: Claim | undefined,
  asOf: string | null = null,
): Claim {
  if (stored === undefined) return computed;
  const reviewed = stored.reviewState !== 'pending';
  const noteKnown =
    asOf === null || (stored.reviewedAt !== null && compareInstants(stored.reviewedAt, asOf) <= 0);
  return {
    ...computed,
    ...(reviewed
      ? {
          category: stored.reviewedCategory ?? computed.category,
          reviewedCategory: stored.reviewedCategory,
          reviewState: stored.reviewState,
          reviewReason: noteKnown ? stored.reviewReason : null,
          reviewedBy: stored.reviewedBy,
          reviewedAt: stored.reviewedAt,
        }
      : {}),
    createdAt: stored.createdAt,
    createdBy: stored.createdBy,
    updatedAt: stored.updatedAt,
    version: stored.version,
  };
}

export function overlayClaims(
  computed: readonly Claim[],
  stored: ReadonlyMap<string, Claim>,
  asOf: string | null = null,
): Claim[] {
  return computed.map((claim) => overlayClaim(claim, stored.get(claim.id), asOf));
}

/** A recomputed fork with the stored review state and version. */
export function overlayFork(
  computed: DecisionFork,
  stored: DecisionFork | undefined,
): DecisionFork {
  if (stored === undefined) return computed;
  return {
    ...computed,
    ...(stored.reviewState === 'pending'
      ? {}
      : { reviewState: stored.reviewState, reviewReason: stored.reviewReason }),
    createdAt: stored.createdAt,
    createdBy: stored.createdBy,
    updatedAt: stored.updatedAt,
    version: stored.version,
  };
}

/** A replayed warning with the stored version, so a dismissal from an as-of list is version-checked. */
export function overlayWarning(
  computed: CaseWarning,
  stored: CaseWarning | undefined,
): CaseWarning {
  if (stored === undefined) return computed;
  return {
    ...computed,
    createdAt: stored.createdAt,
    createdBy: stored.createdBy,
    updatedAt: stored.updatedAt,
    version: stored.version,
  };
}

/**
 * The decision-time form of an action recomputed for an as-of window. The note that an action
 * "retrospectively produced little information" is a hindsight judgement and, in a prefix, it would
 * merely mean that the answer has not arrived yet, so it is withheld. `lowValue` never depends on it.
 */
export function decisionTimeAction(action: DiagnosticAction): DiagnosticAction {
  return {
    ...action,
    lowValueReasons: action.lowValueReasons.filter((reason) => !/^retrospectively\b/i.test(reason)),
  };
}

/** The hindsight view of a fork is only for callers entitled to it, and never inside an as-of window. */
export function withoutHindsight(fork: DecisionFork): DecisionFork {
  return fork.retrospective === null ? fork : { ...fork, retrospective: null };
}
