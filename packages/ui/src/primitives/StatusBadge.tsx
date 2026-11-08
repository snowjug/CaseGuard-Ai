'use client';

import { Badge } from '../kit/Badge';
import { STATUS_META, type BadgeStatus } from './status-meta';

export interface StatusBadgeProps {
  /** Quality status: productive / uncertain / unsupported / missing / neutral. */
  status: BadgeStatus;
  /** Visible text. Defaults to the status name ("Productive", "Uncertain", ...). */
  label?: string;
  size?: 'small' | 'medium';
  /**
   * Hides the text and exposes it as the accessible name. Prefer the text form: the label is part of the
   * "never colour alone" rule (colour + icon + label).
   */
  iconOnly?: boolean;
  className?: string;
}

/** Status pill: tone colours, a status icon and a text label. Missing evidence has a dashed outline. */
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
    <Badge
      tone={meta.tone}
      icon={<Icon />}
      size={size === 'small' ? 'sm' : 'md'}
      iconOnly={iconOnly}
      dashed={status === 'missing'}
      outlined={status === 'missing'}
      title={meta.description}
      {...(className ? { className } : {})}
    >
      {label ?? meta.label}
    </Badge>
  );
}
