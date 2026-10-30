import type { EvidenceLink } from '@caseguard/schemas';
import { shortId } from './format';

/**
 * Deep links into case pages. Every case page reads the selected item from `?sel=<id>` (see `useSelectionState`), so a
 * link such as an evidence reference on a warning opens the right page with the item already selected.
 */

export function caseHref(caseId: string, section?: string): string {
  const base = `/cases/${encodeURIComponent(caseId)}`;
  return section ? `${base}/${section}` : base;
}

const SECTION_BY_LINK_TYPE: Record<EvidenceLink['type'], string> = {
  event: 'timeline',
  action: 'timeline',
  claim: 'evidence',
  evidence: 'evidence',
  requirement: 'evidence',
  hypothesis: 'hypotheses',
  fork: 'counterfactual',
  scenario: 'counterfactual',
};

export const EVIDENCE_LINK_TYPE_LABELS: Record<EvidenceLink['type'], string> = {
  event: 'Event',
  action: 'Action',
  claim: 'Claim',
  evidence: 'Evidence',
  requirement: 'Requirement',
  hypothesis: 'Hypothesis',
  fork: 'Decision fork',
  scenario: 'Scenario',
};

/** The page that shows `link`, with the item selected. */
export function evidenceLinkHref(caseId: string, link: Pick<EvidenceLink, 'type' | 'id'>): string {
  return `${caseHref(caseId, SECTION_BY_LINK_TYPE[link.type])}?sel=${encodeURIComponent(link.id)}`;
}

/** Link text: the server-provided label, or the kind and a short id. */
export function evidenceLinkLabel(link: Pick<EvidenceLink, 'type' | 'id' | 'label'>): string {
  const label = link.label?.trim();
  return label ? label : `${EVIDENCE_LINK_TYPE_LABELS[link.type]} ${shortId(link.id, 12)}`;
}
