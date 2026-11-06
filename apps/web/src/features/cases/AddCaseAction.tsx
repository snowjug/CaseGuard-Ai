'use client';

import { Button, ButtonLink } from '@caseguard/ui';
import { PlusIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { GatedAction, useSession } from '../../lib/auth/session';
import { ADD_CASE_HREF } from '../../lib/nav';

export interface AddCaseActionProps {
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  /** Where it leads (default the add-a-case page; the sample case passes its own address). */
  href?: string;
  icon?: ReactNode;
  children?: ReactNode;
}

/**
 * The way into adding a case: a link for a role that may, and the same button disabled (still focusable) with the reason
 * on hover for one that may not, so nobody is left wondering where the button went.
 */
export function AddCaseAction({
  variant = 'primary',
  size,
  href = ADD_CASE_HREF,
  icon = <PlusIcon />,
  children = 'Add a case',
}: AddCaseActionProps) {
  const { can } = useSession();
  const look = { variant, ...(size ? { size } : {}) };
  if (can('case:ingest')) {
    return (
      <ButtonLink href={href} icon={icon} {...look}>
        {children}
      </ButtonLink>
    );
  }
  return (
    <GatedAction permission="case:ingest">
      <Button icon={icon} disabledFocusable {...look}>
        {children}
      </Button>
    </GatedAction>
  );
}
