'use client';

import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { Loader2Icon } from 'lucide-react';
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { UiLink, type UiLinkProps } from '../link-context';
import { cg } from '../tokens/cg';
import { borderColors } from './styles';
import { Tooltip } from './Tooltip';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

/** White text on the accent fill, mixed down to a hairline: the light edge along the top of the primary button. */
const topEdge = `color-mix(in srgb, ${cg.tone.brand.onSolid} 22%, transparent)`;
const enabled = ':not(:disabled):not([aria-disabled="true"])';

const useStyles = makeStyles({
  root: {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: cg.space[2],
    boxSizing: 'border-box',
    flexShrink: 0,
    border: '1px solid transparent',
    fontFamily: 'inherit',
    fontWeight: tokens.fontWeightSemibold,
    lineHeight: '1',
    letterSpacing: '-0.005em',
    whiteSpace: 'nowrap',
    textDecoration: 'none',
    cursor: 'pointer',
    userSelect: 'none',
    overflow: 'hidden',
    transitionProperty: 'background-color, border-color, color, box-shadow, transform',
    transitionDuration: cg.motion.fast,
    transitionTimingFunction: cg.motion.easing,
    ':focus-visible': { outline: `2px solid ${cg.focus}`, outlineOffset: '2px' },
    [`:active${enabled}`]: { transform: 'translateY(0.5px)' },
    ':disabled': { cursor: 'not-allowed', opacity: 0.5 },
    '&[aria-disabled="true"]': { cursor: 'not-allowed', opacity: 0.6 },
  },
  sm: {
    minHeight: '32px',
    paddingInline: cg.space[3],
    fontSize: tokens.fontSizeBase200,
    borderRadius: cg.radius.sm,
    '@media (pointer: coarse)': { minHeight: '44px' },
  },
  md: {
    minHeight: '40px',
    paddingInline: cg.space[4],
    fontSize: tokens.fontSizeBase300,
    borderRadius: cg.radius.md,
    '@media (pointer: coarse)': { minHeight: '44px' },
  },
  lg: {
    minHeight: '48px',
    paddingInline: cg.space[6],
    fontSize: tokens.fontSizeBase300,
    borderRadius: cg.radius.md,
  },
  squareSm: { width: '32px', paddingInline: 0, '@media (pointer: coarse)': { width: '44px' } },
  squareMd: { width: '40px', paddingInline: 0, '@media (pointer: coarse)': { width: '44px' } },
  squareLg: { width: '48px', paddingInline: 0 },
  full: { width: '100%' },
  primary: {
    backgroundImage: cg.gradientAccent,
    color: cg.tone.brand.onSolid,
    boxShadow: `inset 0 1px 0 ${topEdge}, 0 8px 24px -10px ${cg.glow}`,
    [`:hover${enabled}`]: {
      transform: 'translateY(-1px)',
      boxShadow: `inset 0 1px 0 ${topEdge}, 0 12px 30px -8px ${cg.glow}`,
    },
    // The glint: one 300 ms pass of light across the button on hover or keyboard focus. It never loops.
    '::after': {
      content: '""',
      position: 'absolute',
      top: 0,
      bottom: 0,
      left: 0,
      width: '40%',
      pointerEvents: 'none',
      backgroundImage: `linear-gradient(90deg, transparent, color-mix(in srgb, ${cg.tone.brand.onSolid} 34%, transparent), transparent)`,
      transform: 'translateX(-120%) skewX(-18deg)',
    },
    [`:hover${enabled}::after`]: {
      animationName: 'cg-glint',
      animationDuration: cg.motion.max,
      animationTimingFunction: cg.motion.easing,
      animationFillMode: 'forwards',
    },
    [`:focus-visible${enabled}::after`]: {
      animationName: 'cg-glint',
      animationDuration: cg.motion.max,
      animationTimingFunction: cg.motion.easing,
      animationFillMode: 'forwards',
    },
  },
  secondary: {
    backgroundColor: cg.surfaceRaised,
    color: cg.text,
    ...borderColors(cg.glassBorder),
    boxShadow: `inset 0 1px 0 ${cg.highlight}`,
    [`:hover${enabled}`]: borderColors(cg.borderControl),
    [`:active${enabled}`]: { backgroundColor: cg.surfaceSunken },
  },
  ghost: {
    backgroundColor: 'transparent',
    color: cg.textSecondary,
    [`:hover${enabled}`]: {
      backgroundColor: `color-mix(in srgb, ${cg.text} 8%, transparent)`,
      color: cg.text,
    },
    [`:active${enabled}`]: { backgroundColor: `color-mix(in srgb, ${cg.text} 12%, transparent)` },
  },
  danger: {
    backgroundColor: cg.tone.unsupported.solid,
    color: cg.tone.unsupported.onSolid,
    [`:hover${enabled}`]: { filter: 'brightness(0.94)' },
  },
  icon: { display: 'inline-flex', fontSize: '1.2em' },
  spinner: {
    animationName: 'cg-spin',
    animationDuration: '0.8s',
    animationTimingFunction: 'linear',
    animationIterationCount: 'infinite',
  },
});

export interface ButtonLook {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  /** Square, for a button that holds only an icon. */
  iconOnly?: boolean;
}

/** The class names of a button, shared by `Button`, `ButtonLink` and anything that must look like one. */
export function useButtonClassName(
  { variant = 'secondary', size = 'md', fullWidth = false, iconOnly = false }: ButtonLook,
  className?: string,
): string {
  const styles = useStyles();
  const square =
    size === 'sm' ? styles.squareSm : size === 'lg' ? styles.squareLg : styles.squareMd;
  return mergeClasses(
    styles.root,
    styles[size],
    styles[variant],
    iconOnly && square,
    fullWidth && styles.full,
    className,
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, ButtonLook {
  /** Leading icon (a lucide icon). */
  icon?: ReactNode;
  iconPosition?: 'start' | 'end';
  /** Shows a spinner and ignores clicks, keeping the label and the focus. */
  loading?: boolean;
  /** Looks disabled and ignores clicks, but stays focusable so a keyboard user can still find out why (use with a tooltip). */
  disabledFocusable?: boolean;
}

/**
 * The button. `primary` is the one dominant action of a screen (glint on hover, accent glow); `secondary` is the default;
 * `ghost` for quiet actions inside a card or toolbar; `danger` only for destructive confirmations. 40 px tall by default
 * and at least 44 px on touch screens.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant,
    size,
    fullWidth,
    iconOnly,
    icon,
    iconPosition = 'start',
    loading = false,
    disabledFocusable = false,
    className,
    children,
    type = 'button',
    onClick,
    ...rest
  },
  ref,
) {
  const styles = useStyles();
  const blocked = loading || disabledFocusable;
  const classes = useButtonClassName(
    {
      ...(variant ? { variant } : {}),
      ...(size ? { size } : {}),
      ...(fullWidth ? { fullWidth } : {}),
      iconOnly: iconOnly ?? (children === undefined || children === null),
    },
    className,
  );
  const handleClick = (event: MouseEvent<HTMLButtonElement>): void => {
    if (blocked) event.preventDefault();
    else onClick?.(event);
  };
  return (
    <button
      ref={ref}
      type={type}
      className={classes}
      aria-disabled={blocked || undefined}
      aria-busy={loading || undefined}
      onClick={handleClick}
      {...rest}
    >
      {loading ? (
        <Loader2Icon aria-hidden="true" className={mergeClasses(styles.icon, styles.spinner)} />
      ) : iconPosition === 'start' && icon ? (
        <span aria-hidden="true" className={styles.icon}>
          {icon}
        </span>
      ) : null}
      {children}
      {!loading && iconPosition === 'end' && icon ? (
        <span aria-hidden="true" className={styles.icon}>
          {icon}
        </span>
      ) : null}
    </button>
  );
});

export interface ButtonLinkProps extends UiLinkProps, ButtonLook {
  icon?: ReactNode;
  iconPosition?: 'start' | 'end';
}

/** A link that looks like a button: for navigation that is the main action of a screen or a card. */
export function ButtonLink({
  variant,
  size,
  fullWidth,
  iconOnly,
  icon,
  iconPosition = 'start',
  className,
  children,
  ...rest
}: ButtonLinkProps) {
  const styles = useStyles();
  const classes = useButtonClassName(
    {
      ...(variant ? { variant } : {}),
      ...(size ? { size } : {}),
      ...(fullWidth ? { fullWidth } : {}),
      iconOnly: iconOnly ?? (children === undefined || children === null),
    },
    className,
  );
  return (
    <UiLink className={classes} {...rest}>
      {iconPosition === 'start' && icon ? (
        <span aria-hidden="true" className={styles.icon}>
          {icon}
        </span>
      ) : null}
      {children}
      {iconPosition === 'end' && icon ? (
        <span aria-hidden="true" className={styles.icon}>
          {icon}
        </span>
      ) : null}
    </UiLink>
  );
}

export interface IconButtonProps extends Omit<
  ButtonProps,
  'children' | 'icon' | 'iconPosition' | 'fullWidth' | 'iconOnly'
> {
  icon: ReactNode;
  /** The accessible name and the tooltip. Required: an icon alone says nothing to a screen reader. */
  label: string;
  /** Show the label as a tooltip (default). Turn it off when the control already sits next to visible text. */
  tooltip?: boolean;
}

/** A square, icon-only button that always has a name. Ghost by default. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, tooltip = true, variant = 'ghost', size = 'md', ...rest },
  ref,
) {
  const button: ReactElement = (
    <Button
      ref={ref}
      variant={variant}
      size={size}
      icon={icon}
      aria-label={label}
      iconOnly
      {...rest}
    />
  );
  return tooltip ? (
    <Tooltip content={label} relationship="label">
      {button}
    </Tooltip>
  ) : (
    button
  );
});
