'use client';

import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import type { ReactNode } from 'react';
import { cg } from '../tokens/cg';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    textAlign: 'center',
    gap: cg.space[3],
    padding: `${cg.space[12]} ${cg.space[4]}`,
    color: cg.text,
  },
  compact: { padding: `${cg.space[6]} ${cg.space[4]}`, gap: cg.space[2] },
  icon: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '56px',
    height: '56px',
    borderRadius: cg.radius.pill,
    border: `1px solid ${cg.glassBorder}`,
    backgroundColor: cg.surfaceRaised,
    backgroundImage: `radial-gradient(circle at 50% 0%, ${cg.glow}, transparent 70%)`,
    boxShadow: `0 12px 32px -12px ${cg.glow}`,
    color: cg.tone.brand.fg,
    fontSize: '24px',
  },
  title: {
    margin: 0,
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase400,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.01em',
  },
  description: {
    margin: 0,
    maxWidth: '46ch',
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: cg.space[2],
    marginTop: cg.space[2],
  },
});

export interface EmptyStateProps {
  /** What is empty, in plain words: "No cases yet". */
  title: string;
  /** Why it is empty and what to do next. */
  description?: ReactNode;
  /** Decorative icon (aria-hidden). */
  icon?: ReactNode;
  /** The clear next action: a `Button`, `ButtonLink`... */
  action?: ReactNode;
  secondaryAction?: ReactNode;
  /** Heading level used for the title (default 3). Use 1 when the empty state is the whole page (for example a 404). */
  headingLevel?: 1 | 2 | 3 | 4;
  compact?: boolean;
  className?: string;
}

/** Empty state with an explanation and a clear next action; never a bare "No data". */
export function EmptyState({
  title,
  description,
  icon,
  action,
  secondaryAction,
  headingLevel = 3,
  compact = false,
  className,
}: EmptyStateProps) {
  const styles = useStyles();
  const Heading = `h${headingLevel}` as const;
  return (
    <div className={mergeClasses(styles.root, compact && styles.compact, className)}>
      {icon ? (
        <span aria-hidden="true" className={styles.icon}>
          {icon}
        </span>
      ) : null}
      <Heading className={styles.title}>{title}</Heading>
      {description ? <p className={styles.description}>{description}</p> : null}
      {action || secondaryAction ? (
        <div className={styles.actions}>
          {action}
          {secondaryAction}
        </div>
      ) : null}
    </div>
  );
}
