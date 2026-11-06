'use client';

import { makeStyles, mergeClasses } from '@fluentui/react-components';
import { forwardRef, type ElementType, type HTMLAttributes, type ReactNode } from 'react';
import { cg } from '../tokens/cg';
import { borderColors } from './styles';

const useStyles = makeStyles({
  root: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    isolation: 'isolate',
    color: cg.text,
    borderRadius: cg.radius.lg,
    border: `1px solid ${cg.glassBorder}`,
    backgroundColor: cg.glass,
    backdropFilter: 'blur(12px) saturate(1.1)',
    boxShadow: `inset 0 1px 0 ${cg.highlight}, ${cg.shadowLow}`,
    '@supports not (backdrop-filter: blur(1px))': { backgroundColor: cg.surface },
  },
  flat: { backdropFilter: 'none', backgroundColor: cg.surface },
  none: { padding: 0 },
  sm: { padding: cg.space[4] },
  md: { padding: cg.space[6] },
  lg: { padding: cg.space[8] },
  hero: { borderRadius: cg.radius.xl },
  glow: {
    boxShadow: `inset 0 1px 0 ${cg.highlight}, 0 24px 80px -28px ${cg.glow}`,
  },
  glowLayer: {
    position: 'absolute',
    inset: 0,
    zIndex: -1,
    borderRadius: 'inherit',
    pointerEvents: 'none',
    backgroundImage: `radial-gradient(70% 90% at 50% 0%, ${cg.glow}, transparent 72%)`,
    opacity: 0.6,
  },
  interactive: {
    cursor: 'pointer',
    textDecoration: 'none',
    transitionProperty: 'transform, border-color, box-shadow',
    transitionDuration: cg.motion.fast,
    transitionTimingFunction: cg.motion.easing,
    ':hover': {
      transform: 'translateY(-2px)',
      ...borderColors(`color-mix(in srgb, ${cg.tone.brand.border} 50%, transparent)`),
      boxShadow: `inset 0 1px 0 ${cg.highlight}, 0 14px 36px -14px ${cg.glow}`,
    },
    ':focus-visible': { outline: `2px solid ${cg.focus}`, outlineOffset: '2px' },
  },
});

export interface CardProps extends HTMLAttributes<HTMLElement> {
  /** The element to render: `div` (default), `section`, `article`, or a link component for a clickable card. */
  as?: ElementType;
  /** Inner space: 16, 24 or 32 px, or none for a card whose content runs edge to edge. */
  padding?: 'none' | 'sm' | 'md' | 'lg';
  /** Lifts 2 px and brightens its edge on hover. Only for a card that is itself a link or a button. */
  interactive?: boolean;
  /** A soft accent glow behind the card: for the one hero or key result of a screen. */
  glow?: boolean;
  /** Larger corner radius (24 px) for hero panels. */
  hero?: boolean;
  /** Solid surface without the blur, for long lists of cards where blur would cost frames. */
  flat?: boolean;
  children?: ReactNode;
  href?: string;
}

/** A glass card: translucent surface, a hairline edge, a light line along the top, no heavy shadow. */
export const Card = forwardRef<HTMLElement, CardProps>(function Card(
  {
    as: Component = 'div',
    padding = 'md',
    interactive = false,
    glow = false,
    hero = false,
    flat = false,
    className,
    children,
    ...rest
  },
  ref,
) {
  const styles = useStyles();
  return (
    <Component
      ref={ref}
      className={mergeClasses(
        styles.root,
        styles[padding],
        flat && styles.flat,
        hero && styles.hero,
        glow && styles.glow,
        interactive && styles.interactive,
        className,
      )}
      {...rest}
    >
      {glow ? <span aria-hidden="true" className={styles.glowLayer} /> : null}
      {children}
    </Component>
  );
});
