import type { CaseWarning, Claim, DecisionFork, DiagnosticAction } from '@caseguard/schemas';
import type { RequestContext } from '../../http/request-context';

/*
 * An as-of view is recomputed by the engine on what was known then, so its artefacts carry fresh
 * metadata. People's decisions (reviews, dismissals) and the stored `version` that optimistic locking
 * needs live in the database, so they are laid over the recomputed artefacts by their stable id.
 *
 * POLICY for human input inside a window. A decision (a claim's corrected label, its state, note and
 * who/when; a reviewer's action-value override; a warning dismissal) takes part in a view only from the
 * moment it was made. A review recorded after the window is information the window did not have: its
 * note may cite later facts, and even a bare label can carry hindsight (a reviewer who knows the root
 * cause upgrades an assumption to a confirmed fact). So an earlier window shows the machine
 * classification, a claim that is still `pending`, no override and the warning as open. The one trace
 * of an override is a count: an action ranking says how many it cannot show (`withheldOverrides`),
 * never what they are, and lists only those decided, and about an instant, by the end of its window
 * (`overrides.ts`). It does take from a later decision the stored `version` number, because the
 * optimistic lock of a review started from that window needs it (it tells that something was edited,
 * not what or when). The whole record (no `asOf`) shows every decision. The same rule keeps
 * `updatedAt`, which a later decision moves, out of a window.
 */

/** True when a decision recorded at `at` already existed in the window ending at `asOf` (null: no window). */
export function knownInWindow(at: string | null, asOf: string | null): boolean {
  return asOf === null || (at !== null && Date.parse(at) <= Date.parse(asOf));
}

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
 * A recomputed claim with the reviewer's decision (when it existed in the window) and the stored
 * version. The machine classification (`aiCategory`) stays the recomputed one; the effective category
 * follows the reviewer exactly as the data tier carries a correction across a re-analysis. See the
 * policy above: inside a window a review made after it is invisible, label and note alike.
 */
export function overlayClaim(
  computed: Claim,
  stored: Claim | undefined,
  asOf: string | null = null,
): Claim {
  if (stored === undefined) return computed;
  const reviewed = stored.reviewState !== 'pending' && knownInWindow(stored.reviewedAt, asOf);
  return {
    ...computed,
    ...(reviewed
      ? {
          category: stored.reviewedCategory ?? computed.category,
          reviewedCategory: stored.reviewedCategory,
          reviewState: stored.reviewState,
          reviewReason: stored.reviewReason,
          reviewedBy: stored.reviewedBy,
          reviewedAt: stored.reviewedAt,
        }
      : {}),
    createdAt: stored.createdAt,
    createdBy: stored.createdBy,
    ...(asOf === null ? { updatedAt: stored.updatedAt } : {}),
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

/**
 * A recomputed fork with the stored review state and version. A fork records no time for its review,
 * only when it was last updated, so inside a window the review is shown only if the fork had not been
 * updated after it: later than that, the window cannot tell when the review was made and withholds it.
 */
export function overlayFork(
  computed: DecisionFork,
  stored: DecisionFork | undefined,
  asOf: string | null = null,
): DecisionFork {
  if (stored === undefined) return computed;
  const reviewed = stored.reviewState !== 'pending' && knownInWindow(stored.updatedAt, asOf);
  return {
    ...computed,
    ...(reviewed ? { reviewState: stored.reviewState, reviewReason: stored.reviewReason } : {}),
    createdAt: stored.createdAt,
    createdBy: stored.createdBy,
    ...(asOf === null || reviewed ? { updatedAt: stored.updatedAt } : {}),
    version: stored.version,
  };
}

/**
 * A replayed warning with the stored version, so a dismissal from an as-of list is version-checked.
 * The replay already applied the dismissals that existed in the window; the stored `updatedAt`, which
 * a later resolution or dismissal moves, stays out.
 */
export function overlayWarning(
  computed: CaseWarning,
  stored: CaseWarning | undefined,
): CaseWarning {
  if (stored === undefined) return computed;
  return {
    ...computed,
    createdAt: stored.createdAt,
    createdBy: stored.createdBy,
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
