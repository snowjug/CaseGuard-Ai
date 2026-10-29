import { PERMISSIONS, type Permission, type Role } from '@caseguard/schemas';
import { AuthorizationError } from './errors';

/*
 * Role -> permission matrix (NFR-SEC-02). The model is deny-by-default: a permission that is not
 * listed here is not granted. Keep each role's list explicit so a review shows exactly what changed.
 *
 * Separation of duties that a static matrix cannot express (a skill's approver must differ from its
 * requester) is enforced by `requireDistinctApprover` and by the domain lifecycle.
 */

const ENGINEER_PERMISSIONS = [
  'case:read',
  'case:ingest',
  'case:analyze',
  'counterfactual:run',
  'skill:read',
  'skill:apply',
  'skill:extract',
  'warning:dismiss',
  'quality:read',
  'telemetry:read',
] as const satisfies readonly Permission[];

/** Reviewers read what engineers read, and add the review/override rights; they never ingest or run. */
const REVIEWER_PERMISSIONS = [
  'case:read',
  'skill:read',
  'quality:read',
  'telemetry:read',
  'evidence:review',
  'fork:review',
  'counterfactual:review',
  'quality:review',
  'actionvalue:override',
  'skill:review',
  'skill:validate',
  'audit:read',
] as const satisfies readonly Permission[];

/** Managers are strictly read-only: no permission outside the `:read` family. */
const MANAGER_PERMISSIONS = [
  'case:read',
  'quality:read',
  'analytics:read',
  'telemetry:read',
  'skill:read',
] as const satisfies readonly Permission[];

/** Curators own the skill lifecycle end to end; approval still needs a distinct approver. */
const SKILL_CURATOR_PERMISSIONS = [
  'case:read',
  'skill:read',
  'skill:extract',
  'skill:mutate',
  'skill:validate',
  'skill:review',
  'skill:approve',
  'skill:publish',
  'skill:retire',
  'skill:rollback',
  'skill:apply',
] as const satisfies readonly Permission[];

/** Administrators hold every permission, including governance, role management, export and demo control. */
const ADMINISTRATOR_PERMISSIONS: readonly Permission[] = [...PERMISSIONS];

export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = Object.freeze({
  engineer: Object.freeze([...ENGINEER_PERMISSIONS]),
  reviewer: Object.freeze([...REVIEWER_PERMISSIONS]),
  manager: Object.freeze([...MANAGER_PERMISSIONS]),
  skill_curator: Object.freeze([...SKILL_CURATOR_PERMISSIONS]),
  administrator: Object.freeze([...ADMINISTRATOR_PERMISSIONS]),
});

/** Unknown role strings (for example from a forged token) grant nothing. */
function grantsOf(role: string): readonly Permission[] {
  return Object.hasOwn(ROLE_PERMISSIONS, role) ? ROLE_PERMISSIONS[role as Role] : [];
}

/** Union of the permissions granted by `roles`, in the canonical `PERMISSIONS` order. */
export function permissionsFor(roles: readonly Role[]): Permission[] {
  const granted = new Set<Permission>();
  for (const role of roles) {
    for (const permission of grantsOf(role)) granted.add(permission);
  }
  return PERMISSIONS.filter((permission) => granted.has(permission));
}

/** True when at least one of `roles` grants `permission`. */
export function hasPermission(roles: readonly Role[], permission: Permission): boolean {
  return roles.some((role) => grantsOf(role).includes(permission));
}

/** Throws `AuthorizationError` (403) unless the authenticated caller holds `permission`. */
export function requirePermission(
  auth: { readonly permissions: readonly Permission[] },
  permission: Permission,
): void {
  const known = (PERMISSIONS as readonly string[]).includes(permission);
  if (!known || !auth.permissions.includes(permission)) {
    throw new AuthorizationError(undefined, known ? permission : null);
  }
}

/** Separation of duties: the person approving something must not be the one who requested it. */
export function requireDistinctApprover(requesterId: string, approverId: string): void {
  if (requesterId.length === 0 || approverId.length === 0 || requesterId === approverId) {
    throw new AuthorizationError('Approval requires a reviewer who did not create or request it');
  }
}
