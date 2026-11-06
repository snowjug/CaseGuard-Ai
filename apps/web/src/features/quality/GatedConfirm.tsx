'use client';

import type { Permission } from '@caseguard/schemas';
import { ConfirmDialog, Tooltip, type ConfirmDialogProps } from '@caseguard/ui';
import { cloneElement, type ReactElement } from 'react';
import { permissionDeniedReason, useSession } from '../../lib/auth/session';

export interface GatedConfirmProps extends Omit<ConfirmDialogProps, 'trigger'> {
  /** The permission the action needs. Without it the opener is disabled and says why. */
  permission: Permission;
  /** The opener: a `Button` (the kit's, or Fluent's while a screen is still on it). */
  trigger: ReactElement<{ disabledFocusable?: boolean }>;
  /** Set when the API already said this step is not available: the opener is disabled with this explanation. */
  blockedReason?: string | null;
}

/**
 * A consequential action behind a confirmation dialog, with the two reasons it may be unavailable made visible: the role
 * lacks the permission, or the API's own check says the step is blocked right now. In both cases the opener stays
 * focusable and a tooltip explains why, so keyboard and screen-reader users get the explanation too. The API still
 * answers 403 or 409 for anything that gets past this.
 */
export function GatedConfirm({ permission, trigger, blockedReason, ...dialog }: GatedConfirmProps) {
  const session = useSession();
  const reason = session.can(permission)
    ? (blockedReason ?? null)
    : permissionDeniedReason(permission, session);
  if (reason !== null) {
    return <Tooltip content={reason}>{cloneElement(trigger, { disabledFocusable: true })}</Tooltip>;
  }
  return <ConfirmDialog trigger={trigger} {...dialog} />;
}
