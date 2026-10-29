import type { SearchResult } from '@caseguard/schemas';
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
