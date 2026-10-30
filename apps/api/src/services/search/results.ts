import { IdSchema, SearchResultSchema, type SearchResult } from '@caseguard/schemas';
import { z } from 'zod';
import type { SearchHit, SearchHitType } from '../../db';
import { maskSecrets } from '../governance/mask-secrets';

const MAX_SNIPPET_CHARS = 300;
const MAX_TITLE_CHARS = 300;

/** Case pages that show one kind of item (the web app's deep-link sections). */
const CASE_SECTIONS: Readonly<Record<Exclude<SearchHitType, 'case' | 'skill'>, string>> = {
  claim: 'evidence',
  hypothesis: 'hypotheses',
  event: 'timeline',
  warning: 'quality',
};

/**
 * The web route that shows a hit, with the item pre-selected (`?sel=`), matching the app's deep links
 * (`/cases/[caseId]/<section>?sel=<id>`, `/skills/[skillId]`). A case-scoped hit without a case id
 * (which the repository never produces) falls back to the case list instead of a broken link.
 */
export function hrefFor(hit: Pick<SearchHit, 'type' | 'id' | 'caseId'>): string {
  const encode = encodeURIComponent;
  switch (hit.type) {
    case 'case':
      return `/cases/${encode(hit.id)}`;
    case 'skill':
      return `/skills/${encode(hit.id)}`;
    default:
      return hit.caseId === null
        ? '/cases'
        : `/cases/${encode(hit.caseId)}/${CASE_SECTIONS[hit.type]}?sel=${encode(hit.id)}`;
  }
}

function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

/**
 * One hit as an API result. Titles and snippets are already redacted text (case content is redacted at
 * ingestion); credentials are masked once more and lengths bounded, because a hit may come from an
 * external index that this API did not populate.
 */
export function toSearchResult(hit: SearchHit): SearchResult {
  const { value } = maskSecrets({ title: hit.title, snippet: hit.snippet });
  return {
    type: hit.type,
    id: hit.id,
    caseId: hit.caseId,
    title: clip(value.title, MAX_TITLE_CHARS),
    snippet: clip(value.snippet, MAX_SNIPPET_CHARS),
    href: hrefFor(hit),
    score: hit.score,
  };
}

const PATH_SEGMENT = '[A-Za-z0-9._~%-]+';
const SECTIONS = Object.values(CASE_SECTIONS).join('|');
/** Every link `hrefFor` can build and nothing else: a path of this app, never a scheme, host or script. */
const APP_HREF = new RegExp(
  `^(?:/cases|/cases/${PATH_SEGMENT}|/skills/${PATH_SEGMENT}|/cases/${PATH_SEGMENT}/(?:${SECTIONS})\\?sel=${PATH_SEGMENT})$`,
);

/** A case has itself as its case, a skill has none, anything else belongs to a case. */
function isCaseLinkConsistent(result: Pick<SearchResult, 'type' | 'id' | 'caseId'>): boolean {
  if (result.type === 'case') return result.caseId === result.id;
  if (result.type === 'skill') return result.caseId === null;
  return result.caseId !== null;
}

/**
 * What a result must satisfy to be returned: the contract of the response (`SearchResultSchema`, the
 * schema the serializer enforces) and, because a result is a link, valid CaseGuard ids, a title, a case
 * that fits the type, and an href that is one of this app's own routes.
 */
const ResultContractSchema = SearchResultSchema.extend({
  id: IdSchema,
  title: z.string().min(1),
  href: z.string().regex(APP_HREF),
}).refine(isCaseLinkConsistent, {
  message: 'The case of a hit must fit its type',
  path: ['caseId'],
});

/**
 * What a provider must hand over, checked before anything is built from it: junk (a missing title, an
 * id that is not an id) is dropped here, so building a result cannot fail on the content of one hit.
 * Lengths are not limited: the result is bounded when it is built.
 */
const ProviderHitSchema = z
  .object({
    type: SearchResultSchema.shape.type,
    id: IdSchema,
    caseId: IdSchema.nullable(),
    title: z.string().min(1),
    snippet: z.string(),
    score: z.number(),
  })
  .refine(isCaseLinkConsistent, {
    message: 'The case of a hit must fit its type',
    path: ['caseId'],
  });

/**
 * The result for a hit, or null when the hit or its result cannot satisfy the contract. Only the
 * content of a hit can make it null; a fault in building (the redactor, say) is not hidden as a dropped
 * hit and fails the request.
 */
function toContractResult(hit: SearchHit): SearchResult | null {
  if (!ProviderHitSchema.safeParse(hit).success) return null;
  const parsed = ResultContractSchema.safeParse(toSearchResult(hit));
  return parsed.success ? parsed.data : null;
}

export interface ValidResults {
  readonly results: SearchResult[];
  /** Hits that could not become a result that satisfies the contract; they were dropped. */
  readonly discarded: number;
}

/**
 * The hits as API results, in order, keeping only those that satisfy the result contract, and stopping
 * once `limit` results are collected: a hit that cannot be returned is dropped and counted instead of
 * failing the whole response, and the limit applies to what is left. Hits past the limit are not looked
 * at.
 */
export function toValidResults(hits: readonly SearchHit[], limit: number): ValidResults {
  const results: SearchResult[] = [];
  let discarded = 0;
  for (const hit of hits) {
    if (results.length >= limit) break;
    const result = toContractResult(hit);
    if (result === null) discarded += 1;
    else results.push(result);
  }
  return { results, discarded };
}
