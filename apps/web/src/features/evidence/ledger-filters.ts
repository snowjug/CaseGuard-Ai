import {
  EVIDENCE_CATEGORIES,
  type Claim,
  type ClaimFlag,
  type EvidenceCategory,
  type ReviewState,
} from '@caseguard/schemas';
import { boundedString } from '../../lib/url-codecs';
import { codecs } from '../../lib/url-state';

/** Claims requested per page; further pages load as the list is scrolled. */
export const PAGE_SIZE = 100;

export const REVIEW_FILTERS = ['all', 'pending', 'confirmed', 'corrected', 'rejected'] as const;
export const REVIEW_FILTER_LABELS: Record<(typeof REVIEW_FILTERS)[number], string> = {
  all: 'Any review state',
  pending: 'Awaiting review',
  confirmed: 'Confirmed by a reviewer',
  corrected: 'Corrected by a reviewer',
  rejected: 'Rejected by a reviewer',
};

export const LEDGER_FILTERS = {
  category: codecs.enumOf(['all', ...EVIDENCE_CATEGORIES] as const, 'all'),
  review: codecs.enumOf(REVIEW_FILTERS, 'all'),
  hyp: codecs.optionalString(),
  q: boundedString(200),
} as const;

export interface LedgerFilterValues {
  category: 'all' | EvidenceCategory;
  review: (typeof REVIEW_FILTERS)[number];
  hyp: string | null;
  q: string;
}

/** The query of `evidence.list` for the filters (all applied by the server), the debounced search and the boundary. */
export function ledgerQuery(
  filters: LedgerFilterValues,
  search: string,
  asOf: string | null,
): {
  limit: number;
  asOf?: string;
  category?: EvidenceCategory;
  reviewState?: ReviewState;
  hypothesisId?: string;
  q?: string;
} {
  return {
    limit: PAGE_SIZE,
    ...(asOf ? { asOf } : {}),
    ...(filters.category !== 'all' ? { category: filters.category } : {}),
    ...(filters.review !== 'all' ? { reviewState: filters.review } : {}),
    ...(filters.hyp ? { hypothesisId: filters.hyp } : {}),
    ...(search ? { q: search } : {}),
  };
}

export function activeLedgerFilters(filters: LedgerFilterValues): number {
  return (
    (filters.category !== 'all' ? 1 : 0) +
    (filters.review !== 'all' ? 1 : 0) +
    (filters.hyp ? 1 : 0) +
    (filters.q.trim() ? 1 : 0)
  );
}

export const CLAIM_FLAG_LABELS: Record<ClaimFlag, string> = {
  unsupported_root_cause: 'Root cause without support',
  assumption_as_fact: 'Assumption stated as fact',
  ignored_contradiction: 'Contradiction ignored',
  template_without_evidence: 'Template without evidence',
  contradicted: 'Contradicted by evidence',
  unvalidated_closure: 'Closed without validation',
};

/**
 * The claim as it was known at the boundary. The API withholds a reviewer's decision made after `asOf` (category, state,
 * reason, author and time), so normally this returns the claim as it is; it stays as a guard so that a decision from the
 * future can never be shown, whatever a response carries. Without a boundary the claim is returned unchanged.
 */
export function claimAsKnown(claim: Claim, asOf: string | null): Claim {
  if (asOf === null || claim.reviewedAt === null) return claim;
  if (Date.parse(claim.reviewedAt) <= Date.parse(asOf)) return claim;
  return {
    ...claim,
    category: claim.aiCategory,
    reviewedCategory: null,
    reviewState: 'pending',
    reviewReason: null,
    reviewedBy: null,
    reviewedAt: null,
  };
}

/** True when the claim carries a reviewer decision that differs from the original machine classification. */
export function isCorrected(
  claim: Pick<Claim, 'category' | 'aiCategory' | 'reviewState'>,
): boolean {
  return claim.reviewState === 'corrected' && claim.category !== claim.aiCategory;
}
