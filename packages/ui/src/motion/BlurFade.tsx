'use client';

import { mergeClasses } from '@fluentui/react-components';
import type { CSSProperties, ElementType, HTMLAttributes, ReactNode } from 'react';

export interface BlurFadeProps extends HTMLAttributes<HTMLElement> {
  /** The element to render (default `div`). */
  as?: ElementType;
  /** Position in the page's sequence: each step starts 40 ms after the previous one (capped at five steps). */
  index?: number;
  children?: ReactNode;
}

/**
 * Blur-fade on load: the block fades in, rises 8 px and loses a soft blur in 250 ms, staggered by `index`. It is a CSS
 * animation (`.cg-blur-fade` in globals.css), so the content is visible without JavaScript and reduced motion removes
 * it. Use it on the sections of a page, not on every row.
 */
export function BlurFade({
  as: Component = 'div',
  index = 0,
  className,
  style,
  children,
  ...rest
}: BlurFadeProps) {
  const staggered = { ...style, '--cg-stagger': Math.min(Math.max(index, 0), 5) } as CSSProperties;
  return (
    <Component className={mergeClasses('cg-blur-fade', className)} style={staggered} {...rest}>
      {children}
    </Component>
  );
}
