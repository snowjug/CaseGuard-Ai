'use client';

import type { Permission } from '@caseguard/schemas';
import type { ReactNode } from 'react';
import { useAuth } from '../../lib/auth/context';
import { useSession } from '../../lib/auth/session';
import { IdentityRequired } from './IdentityRequired';
import { PermissionNeeded } from './PermissionNeeded';
import { QueryErrorState } from './QueryErrorState';

export interface PermissionGateProps {
  /** Any one of these permissions opens the page. */
  permission: Permission | readonly Permission[];
  subject: string;
  grantedTo: string;
  /** Shown while the session (and so the permissions) is loading. */
  skeleton: ReactNode;
  children: ReactNode;
}

/**
 * Decides before any data is requested whether the current identity may use a page: identity required, loading, a
 * session that could not be read (with Retry), "you do not have access" (a state, not an error), or the page itself.
 * The API still answers 403 for everything; this only avoids requests that are certain to fail and says why.
 */
export function PermissionGate({
  permission,
  subject,
  grantedTo,
  skeleton,
  children,
}: PermissionGateProps) {
  const auth = useAuth();
  const session = useSession();
  if (auth.status === 'unauthenticated') return <IdentityRequired />;
  if (auth.status === 'loading' || session.isLoading) return <>{skeleton}</>;
  if (session.error || !session.session) {
    return (
      <QueryErrorState error={session.error} subject="Your permissions" onRetry={session.refetch} />
    );
  }
  const needed: readonly Permission[] = typeof permission === 'string' ? [permission] : permission;
  if (!needed.some((item) => session.can(item))) {
    return <PermissionNeeded subject={subject} permission={permission} grantedTo={grantedTo} />;
  }
  return <>{children}</>;
}
