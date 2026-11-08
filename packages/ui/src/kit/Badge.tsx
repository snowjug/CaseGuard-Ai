'use client';

import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import type { CSSProperties, ReactNode } from 'react';
import { cg } from '../tokens/cg';
import type { ToneName } from '../tokens/palette';

const useStyles = makeStyles({
  root: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: cg.space[1],
    maxWidth: '100%',
    boxSizing: 'border-box',
    whiteSpace: 'nowrap',
    fontWeight: tokens.fontWeightSemibold,
    lineHeight: '1',
    verticalAlign: 'middle',
    borderRadius: cg.radius.pill,
    border: '1px solid transparent',
  },
  sm: { minHeight: '22px', paddingInline: cg.space[2], fontSize: tokens.fontSizeBase100 },
  md: { minHeight: '26px', paddingInline: cg.space[3], fontSize: tokens.fontSizeBase200 },
  icon: { display: 'inline-flex', flexShrink: 0, fontSize: '1.15em' },
  text: { overflow: 'hidden', textOverflow: 'ellipsis' },
});

export interface BadgeProps {
  /** Which colour set: `productive`, `uncertain` and `unsupported` are the status colours (green, amber, red); the rest are the accent and neutrals. */
  tone?: ToneName;
  /** A lucide icon. Colour is never the only signal: a badge always has an icon or a word. */
  icon?: ReactNode;
  children?: ReactNode;
  size?: 'sm' | 'md';
  /** Transparent background (for badges that sit on a tinted surface). */
  outlined?: boolean;
  /** Dashed outline: something that is absent or not yet established. */
  dashed?: boolean;
  /** Dotted underline under the label: an estimate. */
  dotted?: boolean;
  /** Hides the label visually; it stays available as the accessible name. */
  iconOnly?: boolean;
  /** Plain-language help on hover; the technical term belongs here, not in the label. */
  title?: string;
  className?: string;
}

/**
 * A small pill: a tinted background, the tone's text colour, a hairline outline, an icon and a label. Used for status
 * (colour plus icon plus word, never colour alone), provenance ("Estimate", "Demo data") and counts.
 */
export function Badge({
  tone = 'neutral',
  icon,
  children,
  size = 'md',
  outlined = false,
  dashed = false,
  dotted = false,
  iconOnly = false,
  title,
  className,
}: BadgeProps) {
  const styles = useStyles();
  const t = cg.tone[tone];
  const style: CSSProperties = {
    color: t.fg,
    borderColor: `color-mix(in srgb, ${t.border} 42%, transparent)`,
    borderStyle: dashed ? 'dashed' : 'solid',
    backgroundColor: outlined ? 'transparent' : t.tint,
  };
  const labelStyle: CSSProperties | undefined = dotted
    ? {
        textDecoration: 'underline dotted',
        textUnderlineOffset: '3px',
        textDecorationThickness: '1px',
      }
    : undefined;
  return (
    <span
      className={mergeClasses(styles.root, size === 'sm' ? styles.sm : styles.md, className)}
      style={style}
      title={title}
      {...(iconOnly
        ? { role: 'img', 'aria-label': typeof children === 'string' ? children : undefined }
        : {})}
    >
      {icon ? (
        <span aria-hidden="true" className={styles.icon}>
          {icon}
        </span>
      ) : null}
      {iconOnly ? null : (
        <span className={styles.text} style={labelStyle}>
          {children}
        </span>
      )}
    </span>
  );
}
