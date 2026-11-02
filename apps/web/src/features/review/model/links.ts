import { PROVENANCE_MAX_LINKS, type EvidenceLink } from '@caseguard/schemas';

/**
 * Evidence links of the guided review: de-duplication, plain-language names for what a link points at, and the
 * `links=` query of `provenance.resolve`. Pure, so the drawer and every chip agree on what a link is.
 */

type LinkRef = Pick<EvidenceLink, 'type' | 'id'>;

/** What a link points at, in the words a person uses (the review never says "claim", "fork" or "hypothesis"). */
export const LINK_TYPE_WORDS: Record<EvidenceLink['type'], string> = {
  event: 'Message or event',
  claim: 'Statement',
  evidence: 'Evidence',
  fork: 'Decision point',
  action: 'Step taken',
  hypothesis: 'Possible cause',
  requirement: 'Missing information',
  scenario: 'Simulated path',
};

/** `evidence:evd_1`, the form used in the address and in the `links` query. */
export function linkKey(link: LinkRef): string {
  return `${link.type}:${link.id}`;
}

/** Parses `type:id` back into a link, or `null` when it is not one (a hand-edited address must not break the page). */
export function parseLinkKey(key: string | null | undefined): EvidenceLink | null {
  if (!key) return null;
  const colon = key.indexOf(':');
  if (colon <= 0) return null;
  const type = key.slice(0, colon);
  const id = key.slice(colon + 1);
  if (
    !Object.hasOwn(LINK_TYPE_WORDS, type) ||
    id.length === 0 ||
    id.length > 120 ||
    /[\s,]/.test(id)
  ) {
    return null;
  }
  return { type: type as EvidenceLink['type'], id };
}

/** The links without repeats, in their first order; a repeat that carries a label fills in an earlier one that has none. */
export function uniqueLinks(links: readonly EvidenceLink[]): EvidenceLink[] {
  const seen = new Map<string, EvidenceLink>();
  for (const link of links) {
    const key = linkKey(link);
    const known = seen.get(key);
    if (!known) seen.set(key, link);
    else if (!known.label && link.label) seen.set(key, { ...known, label: link.label });
  }
  return [...seen.values()];
}

/** Links to events by id, for the places the API names an event without a title. */
export const eventLinks = (ids: readonly string[]): EvidenceLink[] =>
  ids.map((id) => ({ type: 'event', id }));

/** Links to evidence by id. */
export const evidenceLinks = (ids: readonly string[]): EvidenceLink[] =>
  ids.map((id) => ({ type: 'evidence', id }));

export interface ProvenanceRequest {
  /** The `links` query value, or `null` when there is nothing to ask. */
  links: string | null;
  /** The links the request covers, in order. */
  asked: EvidenceLink[];
  /** Links that cannot be put in the query (an id with a comma) or did not fit: shown, but not checked. */
  left: EvidenceLink[];
}

/**
 * The `links` query for a set of links: at most `PROVENANCE_MAX_LINKS`, without repeats, and without an id that the
 * comma-separated form cannot carry. Whatever is left out is reported so the drawer can say so instead of dropping it.
 */
export function provenanceRequest(links: readonly EvidenceLink[]): ProvenanceRequest {
  const asked: EvidenceLink[] = [];
  const left: EvidenceLink[] = [];
  for (const link of uniqueLinks(links)) {
    const carriable = link.id.length > 0 && !/[,\s]/.test(link.id);
    if (carriable && asked.length < PROVENANCE_MAX_LINKS) asked.push(link);
    else left.push(link);
  }
  return {
    links: asked.length > 0 ? asked.map(linkKey).join(',') : null,
    asked,
    left,
  };
}
