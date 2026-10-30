'use client';

import { makeStyles, mergeClasses } from '@fluentui/react-components';
import type { ElementType, HTMLAttributes, ReactNode } from 'react';

const useStyles = makeStyles({
  root: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    margin: '-1px',
    padding: 0,
    overflow: 'hidden',
    clip: 'rect(0, 0, 0, 0)',
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
    border: 0,
  },
});

/** Class that hides content visually while keeping it available to assistive technology. */
export function useVisuallyHiddenClass(): string {
  return useStyles().root;
}

export interface VisuallyHiddenProps extends HTMLAttributes<HTMLElement> {
  /** Element to render; use `caption`, `div`, `p`... when semantics matter. Defaults to `span`. */
  as?: ElementType;
  children?: ReactNode;
}

/** Content for screen readers only (summaries, data tables, live-region text). */
export function VisuallyHidden({
  as: Tag = 'span',
  className,
  children,
  ...rest
}: VisuallyHiddenProps) {
  const hidden = useVisuallyHiddenClass();
  return (
    <Tag className={mergeClasses(hidden, className)} {...rest}>
      {children}
    </Tag>
  );
}
