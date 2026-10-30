'use client';

import type { EvidenceLink } from '@caseguard/schemas';
import { UiLink } from '@caseguard/ui';
import { evidenceLinkHref, evidenceLinkLabel } from '../../lib/deep-links';
import { useInsightStyles } from './styles';

export interface EvidenceLinkListProps {
  caseId: string;
  links: readonly EvidenceLink[];
  /** Accessible name of the list, for example "Evidence for this penalty". */
  label: string;
}

/** The evidence a finding rests on, as links that open the page showing each item with it selected. */
export function EvidenceLinkList({ caseId, links, label }: EvidenceLinkListProps) {
  const styles = useInsightStyles();
  if (links.length === 0) return null;
  return (
    <ul className={styles.chips} aria-label={label}>
      {links.map((link) => (
        <li key={`${link.type}:${link.id}`}>
          <UiLink href={evidenceLinkHref(caseId, link)} className={styles.chip}>
            {evidenceLinkLabel(link)}
          </UiLink>
        </li>
      ))}
    </ul>
  );
}
