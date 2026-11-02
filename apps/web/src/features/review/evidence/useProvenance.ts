'use client';

import type { EvidenceLink } from '@caseguard/schemas';
import { useMemo } from 'react';
import { useApiQuery } from '../../../lib/api/hooks';
import { useAuth } from '../../../lib/auth/context';
import { useSession } from '../../../lib/auth/session';
import { provenanceRequest } from '../model/links';
import { titlesByKey } from './provenance-view';

/**
 * `provenance.resolve` for a set of evidence links: what each one is, who wrote it and when, and, for text, whether the
 * recorded excerpt was checked against the stored message. Needs `case:read`; without it nothing is requested.
 */
export function useProvenance(caseId: string, links: readonly EvidenceLink[], enabled = true) {
  const auth = useAuth();
  const { can } = useSession();
  const request = provenanceRequest(links);
  const query = useApiQuery(
    'provenance.resolve',
    { params: { caseId }, query: { links: request.links ?? '' } },
    {
      enabled: auth.status === 'ready' && can('case:read') && enabled && request.links !== null,
      staleTime: 60_000,
    },
  );
  return { query, request };
}

/**
 * Titles for the links that arrived without a label, resolved in one request for a whole part of the page (the
 * engine labels most links itself; the decision points name their evidence by id only). A failed or slow read leaves
 * the plain "kind and short id" label in place: a chip never waits for it and never fails because of it.
 */
export function useLinkTitles(
  caseId: string,
  links: readonly EvidenceLink[],
): ReadonlyMap<string, string> {
  const unlabeled = links.filter((link) => !link.label?.trim());
  const { query } = useProvenance(caseId, unlabeled);
  const data = query.data;
  return useMemo(() => titlesByKey(data), [data]);
}
