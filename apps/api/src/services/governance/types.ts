import type { GovernanceSection, GovernanceSettings } from '@caseguard/schemas';

/** The configured value of every governed section, typed per section (without version metadata). */
export type GovernanceValues = {
  readonly [S in GovernanceSection]: GovernanceSettings[S]['value'];
};

/** A problem with one field of a request, located like the binder's own validation errors. */
export interface FieldIssue {
  readonly path: string;
  readonly message: string;
}
