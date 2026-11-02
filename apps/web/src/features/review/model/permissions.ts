import type { Permission } from '@caseguard/schemas';

/** Who can read or do what, in the words of the other pages that explain a missing permission. */
export const WHO_CAN: Partial<Record<Permission, string>> = {
  'case:read': 'Everyone with access to the case',
  'quality:read': 'Engineers, reviewers, managers and administrators',
  'skill:read': 'Engineers, reviewers, managers, skill curators and administrators',
  'counterfactual:run': 'Engineers and administrators',
  'skill:apply': 'Engineers, skill curators and administrators',
  'skill:extract': 'Engineers, skill curators and administrators',
};

export const whoCan = (permission: Permission): string => WHO_CAN[permission] ?? 'Another role';

/**
 * The sentence that says a part is not shown because the role lacks a permission: which role, which permission, who can
 * see it. `where` is the place it is left out of ("here", "in this report").
 */
export function permissionSentence(options: {
  permission: Permission;
  /** What is left out, as a noun phrase: "the case quality result". */
  what: string;
  role: string;
  /** True when `what` names more than one thing. */
  several?: boolean;
  where?: string;
}): string {
  const { permission, what, role, several = false, where = 'here' } = options;
  return `Your role (${role}) does not include the “${permission}” permission, so ${what} cannot be shown ${where}. ${whoCan(permission)} can see ${several ? 'them' : 'it'}.`;
}
