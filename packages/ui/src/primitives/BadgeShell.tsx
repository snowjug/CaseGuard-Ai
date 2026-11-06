'use client';

import type { CSSProperties, ReactNode } from 'react';
import { Badge } from '../kit/Badge';
import type { ToneName } from '../tokens/palette';
import type { PatternKind } from './patterns';

export interface BadgeShellProps {
  tone: ToneName;
  /** Ignored: badges no longer carry a texture chip (icon and word carry the meaning). */
  pattern?: PatternKind;
  icon: ReactNode;
  label: string;
  size?: 'small' | 'medium';
  borderStyle?: CSSProperties['borderStyle'];
  outlined?: boolean;
  dottedLabel?: boolean;
  iconOnly?: boolean;
  className?: string;
  title?: string;
}

/**
 * @deprecated Use `Badge` from the kit. This wrapper only keeps the screens that have not been redesigned yet compiling,
 * and goes away with the last of them.
 */
export function BadgeShell({
  tone,
  icon,
  label,
  size = 'medium',
  borderStyle = 'solid',
  outlined = false,
  dottedLabel = false,
  iconOnly = false,
  className,
  title,
}: BadgeShellProps) {
  return (
    <Badge
      tone={tone}
      icon={icon}
      size={size === 'small' ? 'sm' : 'md'}
      outlined={outlined}
      dashed={borderStyle === 'dashed'}
      dotted={dottedLabel}
      iconOnly={iconOnly}
      {...(title ? { title } : {})}
      {...(className ? { className } : {})}
    >
      {label}
    </Badge>
  );
}
