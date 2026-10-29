import {
  ROLES,
  type AssignRolesBody,
  type AuthMode,
  type Role,
  type User,
} from '@caseguard/schemas';
import {
  ConflictError,
  NotFoundError,
  ValidationFailedError,
  VersionConflictError,
} from '../../errors';
import type { RequestContext } from '../../http/request-context';

export type RolesContext = Pick<RequestContext, 'repos' | 'auth' | 'audit'> & {
  readonly config: { readonly auth: { readonly mode: AuthMode } };
};

export type RoleRefusal = 'entra_managed' | 'empty_roles' | 'last_administrator';

export type RoleChangeDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: RoleRefusal; readonly message: string };

const MESSAGES: Record<RoleRefusal, string> = {
  entra_managed: 'Roles are managed in Microsoft Entra ID',
  empty_roles: 'At least one role is required',
  last_administrator: 'A tenant must keep at least one active administrator',
};

const refuse = (reason: RoleRefusal): RoleChangeDecision => ({
  ok: false,
  reason,
  message: MESSAGES[reason],
});

/** Canonical order, no duplicates, so before/after comparisons and audit records are stable. */
export function normalizeRoles(roles: readonly Role[]): Role[] {
  const wanted = new Set(roles);
  return ROLES.filter((role) => wanted.has(role));
}

/**
 * Whether `target` may take `nextRoles`: never an empty set, and never a change that leaves the tenant
 * without an active administrator (a tenant with none could not be administered again). A tenant that
 * already has no administrator is not blocked, so it can be repaired.
 */
export function planRoleChange(input: {
  readonly users: readonly User[];
  readonly target: User;
  readonly nextRoles: readonly Role[];
}): RoleChangeDecision {
  if (input.nextRoles.length === 0) return refuse('empty_roles');
  const roster = input.users.some((user) => user.id === input.target.id)
    ? input.users
    : [...input.users, input.target];
  const countAdministrators = (rolesOf: (user: User) => readonly Role[]): number =>
    roster.filter((user) => user.status === 'active' && rolesOf(user).includes('administrator'))
      .length;
  const before = countAdministrators((user) => user.roles);
  const after = countAdministrators((user) =>
    user.id === input.target.id ? input.nextRoles : user.roles,
  );
  return before > 0 && after === 0 ? refuse('last_administrator') : { ok: true };
}

/** A role change refused by policy; the transaction rolls back and a `denied` audit event is written. */
class RoleChangeRefusedError extends ConflictError {
  constructor(readonly reason: RoleRefusal) {
    super(MESSAGES[reason], { reason });
  }
}

async function recordRefusal(
  ctx: Pick<RolesContext, 'audit'>,
  userId: string,
  reason: RoleRefusal,
): Promise<void> {
  await ctx.audit({
    action: 'roles.assigned',
    targetType: 'user',
    targetId: userId,
    caseId: null,
    outcome: 'denied',
    details: { userId, reason },
  });
}

/** The tenant's users (at most the repository's cap), with their roles. */
export function listUsers(ctx: Pick<RolesContext, 'repos'>): Promise<User[]> {
  return ctx.repos.governance.listUsers();
}

/**
 * Replaces a user's roles. Roles come from token claims in Entra mode, so there the answer is a 409.
 * Otherwise: optimistic lock on the user's `version`, no empty set, no removal of the last
 * administrator, and the before/after roles are audited in the SAME transaction as the update.
 */
export async function assignRoles(
  ctx: RolesContext,
  userId: string,
  body: AssignRolesBody,
): Promise<User> {
  if (ctx.config.auth.mode === 'entra') {
    await recordRefusal(ctx, userId, 'entra_managed');
    throw new ConflictError(MESSAGES.entra_managed, { reason: 'entra_managed' });
  }
  const nextRoles = normalizeRoles(body.roles);
  if (nextRoles.length === 0) {
    throw new ValidationFailedError(MESSAGES.empty_roles, [
      { path: 'body.roles', message: 'Choose at least one role.' },
    ]);
  }

  try {
    return await ctx.repos.transaction(async (tx) => {
      const target = await tx.governance.getUser(userId);
      if (target === null) throw new NotFoundError('User', userId);
      if (target.version !== body.expectedVersion) {
        throw new VersionConflictError('User', body.expectedVersion, target.version);
      }
      // Appending the audit event first takes the tenant's audit-chain lock (an advisory lock on
      // PostgreSQL) for the rest of the transaction. That serialises concurrent role changes of one
      // tenant, so the administrator count read below cannot be invalidated by a parallel change.
      await ctx.audit(
        {
          action: 'roles.assigned',
          targetType: 'user',
          targetId: userId,
          caseId: null,
          outcome: 'success',
          details: {
            userId,
            fromRoles: target.roles,
            toRoles: nextRoles,
            fromVersion: target.version,
            toVersion: target.version + 1,
          },
        },
        tx,
      );
      const decision = planRoleChange({
        users: await tx.governance.listUsers(),
        target,
        nextRoles,
      });
      if (!decision.ok) throw new RoleChangeRefusedError(decision.reason);
      return tx.governance.updateUserRoles(userId, nextRoles, body.expectedVersion);
    });
  } catch (error) {
    if (error instanceof RoleChangeRefusedError) await recordRefusal(ctx, userId, error.reason);
    throw error;
  }
}
