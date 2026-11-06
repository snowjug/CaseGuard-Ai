'use client';

import { ROLE_LABELS, type Permission } from '@caseguard/schemas';
import { Button, EmptyState } from '@caseguard/ui';
import { HomeIcon, LockIcon, UserRoundCogIcon } from 'lucide-react';
import { useAuth } from '../../lib/auth/context';
import { useSession } from '../../lib/auth/session';
import { LinkButton } from './LinkButton';

export interface PermissionNeededProps {
  /** What the person tried to open, as a noun phrase: "System Health". */
  subject: string;
  /** The permission(s) that would have been enough (any one of them). */
  permission: Permission | readonly Permission[];
  /** Who can open it, in plain words: "Engineers, reviewers, managers and administrators". */
  grantedTo: string;
}

/**
 * The page-level answer for a role that lacks a permission (the API would answer 403): says which permission is
 * missing, who has it, and offers the next step (another development persona, or the Command Center). It is a state,
 * not an error, so it has no Retry.
 */
export function PermissionNeeded({ subject, permission, grantedTo }: PermissionNeededProps) {
  const { roles } = useSession();
  const auth = useAuth();
  const needed: readonly Permission[] = typeof permission === 'string' ? [permission] : permission;
  const roleText = roles.map((role) => ROLE_LABELS[role]).join(', ') || 'none';
  const missing = needed.map((item) => `"${item}"`).join(' or ');
  return (
    <EmptyState
      headingLevel={2}
      icon={<LockIcon />}
      title={`You do not have access to ${subject}`}
      description={`Your role (${roleText}) does not include the ${missing} permission. ${grantedTo} can open it.`}
      action={
        <>
          {auth.dev ? (
            <Button
              variant="primary"
              icon={<UserRoundCogIcon />}
              onClick={() => auth.dev?.openPicker()}
            >
              Choose a development persona
            </Button>
          ) : null}
          <LinkButton href="/" appearance={auth.dev ? 'outline' : 'primary'} icon={<HomeIcon />}>
            Home
          </LinkButton>
        </>
      }
    />
  );
}
