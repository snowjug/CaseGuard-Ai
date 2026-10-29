import type { Page, ReviewDecision } from '@caseguard/schemas';
import type { RequestContext } from '../../http/request-context';
import { maskSecrets } from './mask-secrets';

export type ReviewReadContext = Pick<RequestContext, 'repos'>;

export interface ReviewListQuery {
  readonly caseId?: string | undefined;
  readonly limit: number;
  readonly cursor?: string | undefined;
}

/**
 * Reviewer decisions, newest first, optionally for one case. The values and the reason are free text
 * written by people, so credentials are masked defensively before they leave the API.
 */
export async function listReviewDecisions(
  ctx: ReviewReadContext,
  query: ReviewListQuery,
): Promise<Page<ReviewDecision>> {
  const page = await ctx.repos.reviews.list(query);
  return { ...page, items: page.items.map((decision) => maskSecrets(decision).value) };
}
