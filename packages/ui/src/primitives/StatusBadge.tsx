'use client';

import { BadgeShell } from './BadgeShell';
import { STATUS_META, type BadgeStatus } from './status-meta';

export interface StatusBadgeProps {
  /** Quality status: productive / uncertain / unsupported / missing / neutral. */
  status: BadgeStatus;
  /** Visible text. Defaults to the status name ("Productive", "Uncertain", ...). */
  label?: string;
  size?: 'small' | 'medium';
  /**
   * Hides the text and exposes it as the accessible name. Prefer the text form: the label is part of the
   * "never colour alone" rule (colour + icon + label + pattern).
   */
  iconOnly?: boolean;
  className?: string;
}

/**
 * Status pill: a tone-coloured border, a pattern chip (dots = uncertain, cross-hatch = unsupported,
 * outline-only = missing), a status icon and a text label.
 */
export function StatusBadge({
  status,
  label,
  size = 'medium',
  iconOnly = false,
  className,
}: StatusBadgeProps) {
  const meta = STATUS_META[status];
  const Icon = meta.icon;
  return (
    <BadgeShell
      tone={meta.tone}
      pattern={meta.pattern}
      icon={<Icon />}
      label={label ?? meta.label}
      size={size}
      iconOnly={iconOnly}
      borderStyle={status === 'missing' ? 'dashed' : 'solid'}
      outlined={status === 'missing'}
      title={meta.description}
      {...(className ? { className } : {})}
    />
  );
}
