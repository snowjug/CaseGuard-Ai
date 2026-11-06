'use client';

import { makeStyles, mergeClasses } from '@fluentui/react-components';
import type { CSSProperties, ElementType, HTMLAttributes, ReactNode } from 'react';
import { cg } from '../tokens/cg';

const useStyles = makeStyles({
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(12, minmax(0, 1fr))',
    gap: cg.space[4],
    '@media (min-width: 1280px)': { gap: cg.space[6] },
  },
  item: {
    minWidth: 0,
    gridColumn: 'span var(--cg-span, 12)',
    '@media (min-width: 640px)': { gridColumn: 'span var(--cg-span-sm, var(--cg-span, 12))' },
    '@media (min-width: 1024px)': {
      gridColumn: 'span var(--cg-span-lg, var(--cg-span-sm, var(--cg-span, 12)))',
    },
  },
});

export interface BentoGridProps extends HTMLAttributes<HTMLElement> {
  as?: ElementType;
  children?: ReactNode;
}

/** A 12-column bento layout: cards of different sizes in a tight grid that collapses to one column on phones. */
export function BentoGrid({ as: Component = 'div', className, children, ...rest }: BentoGridProps) {
  const styles = useStyles();
  return (
    <Component className={mergeClasses(styles.grid, className)} {...rest}>
      {children}
    </Component>
  );
}

export interface BentoItemProps extends HTMLAttributes<HTMLElement> {
  as?: ElementType;
  /** Columns spanned out of 12 on a phone (default 12, the full width). */
  span?: number;
  /** Columns from 640 px (tablet) up; defaults to `span`. */
  spanSm?: number;
  /** Columns from 1024 px (desktop) up; defaults to `spanSm`. */
  spanLg?: number;
  children?: ReactNode;
}

/** One cell of a `BentoGrid`: says how many of the 12 columns it takes at each width. */
export function BentoItem({
  as: Component = 'div',
  span,
  spanSm,
  spanLg,
  className,
  style,
  children,
  ...rest
}: BentoItemProps) {
  const styles = useStyles();
  const spans = {
    ...style,
    ...(span === undefined ? {} : { '--cg-span': span }),
    ...(spanSm === undefined ? {} : { '--cg-span-sm': spanSm }),
    ...(spanLg === undefined ? {} : { '--cg-span-lg': spanLg }),
  } as CSSProperties;
  return (
    <Component className={mergeClasses(styles.item, className)} style={spans} {...rest}>
      {children}
    </Component>
  );
}
