import type { Permission } from '@caseguard/schemas';

export interface GovernanceTab {
  id: string;
  label: string;
  /** Permission needed to open the tab's data; null when the tab only gathers actions that gate themselves. */
  permission: Permission | null;
  /** Who can open it, in plain words (shown when the role may not). */
  grantedTo: string;
}

const ADMIN = 'Administrators';
const REVIEW = 'Reviewers and administrators';

/** The sections of the Governance page, in the order of the section list. */
export const GOVERNANCE_TABS = [
  { id: 'model', label: 'Model', permission: 'governance:read', grantedTo: ADMIN },
  { id: 'prompts', label: 'Prompts', permission: 'governance:read', grantedTo: ADMIN },
  { id: 'scoring', label: 'Scoring', permission: 'governance:read', grantedTo: ADMIN },
  { id: 'retention', label: 'Retention', permission: 'governance:read', grantedTo: ADMIN },
  { id: 'redaction', label: 'Redaction', permission: 'governance:read', grantedTo: ADMIN },
  { id: 'flags', label: 'Feature flags', permission: 'governance:read', grantedTo: ADMIN },
  { id: 'export', label: 'Export', permission: 'governance:read', grantedTo: ADMIN },
  { id: 'roles', label: 'Roles', permission: 'governance:read', grantedTo: ADMIN },
  { id: 'audit', label: 'Audit log', permission: 'audit:read', grantedTo: REVIEW },
  { id: 'reviews', label: 'Reviewer decisions', permission: 'audit:read', grantedTo: REVIEW },
  { id: 'operations', label: 'Provider and reset', permission: null, grantedTo: ADMIN },
] as const satisfies readonly GovernanceTab[];

export type GovernanceTabId = (typeof GOVERNANCE_TABS)[number]['id'];

export const GOVERNANCE_TAB_IDS = GOVERNANCE_TABS.map(
  (tab) => tab.id,
) as readonly GovernanceTabId[];
