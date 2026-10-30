'use client';

import { makeStyles, mergeClasses } from '@fluentui/react-components';
import type { CSSProperties, ReactNode } from 'react';

const useStyles = makeStyles({
  root: { overflowX: 'auto', maxWidth: '100%' },
});

export interface ScrollRegionProps {
  /** Accessible name of the region, for example "Nodes table, scrollable". */
  label: string;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}

/**
 * A named, horizontally scrollable region. It is keyboard focusable so people who cannot use a pointer can scroll it
 * (WCAG 2.1.1, and axe's scrollable-region-focusable rule).
 */
export function ScrollRegion({ label, children, className, style }: ScrollRegionProps) {
  const styles = useStyles();
  return (
    <div
      role="region"
      aria-label={label}
      // A scrollable container has to be focusable for keyboard users, so the rule is deliberately waived here.
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      className={mergeClasses(styles.root, className)}
      style={style}
    >
      {children}
    </div>
  );
}
