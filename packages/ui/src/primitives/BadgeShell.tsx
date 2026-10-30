'use client';

import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import type { CSSProperties, ReactNode } from 'react';
import { cg } from '../tokens/cg';
import type { ToneName } from '../tokens/palette';
import { patternBackground, type PatternKind } from './patterns';

const useStyles = makeStyles({
  root: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    maxWidth: '100%',
    boxSizing: 'border-box',
    whiteSpace: 'nowrap',
    fontWeight: tokens.fontWeightSemibold,
    lineHeight: '1',
    verticalAlign: 'middle',
  },
  small: {
    minHeight: '22px',
    padding: '0 8px 0 3px',
    fontSize: tokens.fontSizeBase200,
  },
  medium: {
    minHeight: '26px',
    padding: '0 10px 0 4px',
    fontSize: tokens.fontSizeBase200,
  },
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    borderRadius: '999px',
    overflow: 'hidden',
  },
  chipSmall: { width: '16px', height: '16px', fontSize: '13px' },
  chipMedium: { width: '20px', height: '20px', fontSize: '15px' },
  text: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
});

export interface BadgeShellProps {
  tone: ToneName;
  pattern: PatternKind;
  icon: ReactNode;
  label: string;
  size?: 'small' | 'medium';
  /** Border line style: solid for status, dotted/dashed to encode provenance. */
  borderStyle?: CSSProperties['borderStyle'];
  /** Transparent background (outlined badge). */
  outlined?: boolean;
  /** Dotted underline under the label (estimated values). */
  dottedLabel?: boolean;
  /** Hides the label visually; it is then exposed as the accessible name. */
  iconOnly?: boolean;
  className?: string;
  title?: string;
}

/**
 * Shared chrome of StatusBadge and ProvenanceBadge: a pill with a pattern chip + icon, a text label,
 * a tone-coloured border and a border style that carries meaning (never colour alone).
 */
export function BadgeShell({
  tone,
  pattern,
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
  const styles = useStyles();
  const t = cg.tone[tone];
  const rootStyle: CSSProperties = {
    color: t.fg,
    border: `1px ${borderStyle} ${t.border}`,
    backgroundColor: outlined ? 'transparent' : t.tint,
    borderRadius: iconOnly ? '999px' : '999px',
  };
  const chipStyle: CSSProperties = {
    ...patternBackground(pattern, tone),
    color: t.fg,
    ...(pattern === 'outline' ? { boxShadow: `inset 0 0 0 1px ${t.border}` } : {}),
  };
  return (
    <span
      className={mergeClasses(
        styles.root,
        size === 'small' ? styles.small : styles.medium,
        className,
      )}
      style={rootStyle}
      title={title}
      role={iconOnly ? 'img' : undefined}
      aria-label={iconOnly ? label : undefined}
    >
      <span
        aria-hidden="true"
        className={mergeClasses(
          styles.chip,
          size === 'small' ? styles.chipSmall : styles.chipMedium,
        )}
        style={chipStyle}
      >
        {icon}
      </span>
      {iconOnly ? null : (
        <span
          className={styles.text}
          style={
            dottedLabel
              ? {
                  textDecoration: 'underline dotted',
                  textUnderlineOffset: '3px',
                  textDecorationThickness: '1px',
                }
              : undefined
          }
        >
          {label}
        </span>
      )}
    </span>
  );
}
