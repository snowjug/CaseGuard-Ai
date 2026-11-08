'use client';

import { Tooltip as FluentTooltip, makeStyles, tokens } from '@fluentui/react-components';
import type { ReactElement, ReactNode } from 'react';
import { cg } from '../tokens/cg';

type Side = 'top' | 'bottom' | 'start' | 'end';

const POSITION = {
  top: 'above',
  bottom: 'below',
  start: 'before',
  end: 'after',
} as const satisfies Record<Side, string>;

const useStyles = makeStyles({
  content: {
    maxWidth: '280px',
    padding: `${cg.space[2]} ${cg.space[3]}`,
    borderRadius: cg.radius.md,
    backgroundColor: cg.surfaceRaised,
    color: cg.text,
    border: `1px solid ${cg.glassBorder}`,
    boxShadow: cg.shadowHigh,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    fontWeight: tokens.fontWeightMedium,
  },
});

export interface TooltipProps {
  /** What the tooltip says. Short: a name for an icon, or the technical term behind a plain word. */
  content: ReactNode;
  /** The one element it belongs to; it must be focusable so keyboard users get the tooltip too. */
  children: ReactElement;
  /**
   * `label` makes the tooltip the element's accessible name (icon-only controls); `description` (default) adds it as
   * extra information. A tooltip is never the only way to understand a visible label.
   */
  relationship?: 'label' | 'description';
  side?: Side;
}

/** Tooltip on glass: opens on hover and on keyboard focus, closes on Escape, never traps focus. */
export function Tooltip({
  content,
  children,
  relationship = 'description',
  side = 'top',
}: TooltipProps) {
  const styles = useStyles();
  return (
    <FluentTooltip
      content={{ children: content, className: styles.content }}
      relationship={relationship}
      positioning={POSITION[side]}
      withArrow={false}
      showDelay={250}
      hideDelay={0}
    >
      {children}
    </FluentTooltip>
  );
}
