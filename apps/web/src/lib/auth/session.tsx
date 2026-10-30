'use client';

import { ROLE_LABELS, type Permission, type Role, type Session } from '@caseguard/schemas';
import { Tooltip } from '@fluentui/react-components';
import { cloneElement, useCallback, useMemo, type ReactElement, type ReactNode } from 'react';
import type { ApiError } from '../api/errors';
import { useApiQuery } from '../api/hooks';
import { useAuth, type AuthContextValue } from './context';

export interface SessionState {
  /** The signed-in user, tenant, permissions and honesty notices from `session.me`. */
  session: Session | undefined;
  /** True while `session.me` is loading for a signed-in identity. */
  isLoading: boolean;
  error: ApiError | null;
  permissions: ReadonlySet<Permission>;
  roles: readonly Role[];
  /** Deny by default: false while loading, on error and for permissions the role does not hold. */
  can: (permission: Permission) => boolean;
  refetch: () => void;
  auth: AuthContextValue;
}

/** The current session, backed by `session.me`, with a `can(permission)` helper for gating actions. */
export function useSession(): SessionState {
  const auth = useAuth();
  const query = useApiQuery('session.me', undefined, {
    enabled: auth.status === 'ready',
    staleTime: 60_000,
  });
  const permissions = useMemo<ReadonlySet<Permission>>(
    () => new Set(query.data?.permissions ?? []),
    [query.data],
  );
  const can = useCallback(
    (permission: Permission): boolean => permissions.has(permission),
    [permissions],
  );
  const refetch = useCallback(() => {
    void query.refetch();
  }, [query]);
  return {
    session: query.data,
    isLoading: auth.status === 'ready' && query.isPending,
    error: query.error,
    permissions,
    roles: query.data?.user.roles ?? [],
    can,
    refetch,
    auth,
  };
}

/** Plain-language reason shown (as a tooltip) when an action is unavailable. */
export function permissionDeniedReason(
  permission: Permission,
  state: Pick<SessionState, 'isLoading' | 'error' | 'roles' | 'session'>,
): string {
  if (state.isLoading) return 'Checking your permissions…';
  if (state.error || !state.session)
    return 'Your permissions could not be loaded, so this action is unavailable.';
  const roles = state.roles.map((role) => ROLE_LABELS[role]).join(', ');
  return `Your role (${roles || 'none'}) does not include the "${permission}" permission.`;
}

/** Renders `children` only when the current role has `permission`; otherwise `fallback`. */
export function Can({
  permission,
  children,
  fallback = null,
}: {
  permission: Permission;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { can } = useSession();
  return <>{can(permission) ? children : fallback}</>;
}

export interface GatedActionProps {
  permission: Permission;
  /** A single Fluent `Button` (or any element accepting `disabledFocusable`). */
  children: ReactElement<{ disabledFocusable?: boolean; onClick?: unknown }>;
}

/**
 * Disables an action the current role may not perform and explains why in a tooltip. The control stays focusable
 * (`disabledFocusable`), so keyboard and screen-reader users can discover the explanation too.
 */
export function GatedAction({ permission, children }: GatedActionProps) {
  const state = useSession();
  if (state.can(permission)) return children;
  const reason = permissionDeniedReason(permission, state);
  return (
    <Tooltip content={reason} relationship="description" withArrow>
      {cloneElement(children, { disabledFocusable: true, onClick: undefined })}
    </Tooltip>
  );
}
