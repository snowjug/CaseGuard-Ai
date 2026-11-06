'use client';

import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { motion as m } from 'motion/react';
import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { useMotionEnabled } from '../motion/useMotionEnabled';
import { cg } from '../tokens/cg';
import { motion } from '../tokens/static';

const useStyles = makeStyles({
  root: {
    display: 'inline-flex',
    gap: cg.space[1],
    padding: cg.space[1],
    maxWidth: '100%',
    boxSizing: 'border-box',
    overflowX: 'auto',
    borderRadius: cg.radius.md,
    border: `1px solid ${cg.glassBorder}`,
    backgroundColor: cg.surfaceSunken,
  },
  full: { display: 'flex', width: '100%' },
  option: {
    position: 'relative',
    display: 'inline-flex',
    flex: '1 1 auto',
    alignItems: 'center',
    justifyContent: 'center',
    gap: cg.space[2],
    border: 0,
    backgroundColor: 'transparent',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontWeight: tokens.fontWeightMedium,
    whiteSpace: 'nowrap',
    color: cg.textSecondary,
    borderRadius: cg.radius.sm,
    transitionProperty: 'color',
    transitionDuration: cg.motion.fast,
    ':hover': { color: cg.text },
    ':focus-visible': { outline: `2px solid ${cg.focus}`, outlineOffset: '1px' },
    ':disabled': { cursor: 'not-allowed', opacity: 0.5 },
  },
  sm: {
    minHeight: '32px',
    paddingInline: cg.space[3],
    fontSize: tokens.fontSizeBase200,
    '@media (pointer: coarse)': { minHeight: '44px' },
  },
  md: {
    minHeight: '36px',
    paddingInline: cg.space[4],
    fontSize: tokens.fontSizeBase300,
    '@media (pointer: coarse)': { minHeight: '44px' },
  },
  selected: { color: cg.text, fontWeight: tokens.fontWeightSemibold },
  thumb: {
    position: 'absolute',
    inset: 0,
    borderRadius: cg.radius.sm,
    backgroundColor: cg.surfaceRaised,
    border: `1px solid ${cg.glassBorder}`,
    boxShadow: `inset 0 1px 0 ${cg.highlight}, ${cg.shadowLow}`,
  },
  content: { position: 'relative', display: 'inline-flex', alignItems: 'center', gap: cg.space[2] },
  icon: { display: 'inline-flex', fontSize: '1.15em' },
});

export interface SegmentOption<V extends string> {
  value: V;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface SegmentedControlProps<V extends string> {
  value: V;
  onValueChange: (value: V) => void;
  options: readonly SegmentOption<V>[];
  /** Names the group for assistive technology. */
  'aria-label': string;
  size?: 'sm' | 'md';
  fullWidth?: boolean;
  className?: string;
}

/**
 * A short row of mutually exclusive choices (a radio group that looks like a switch): one is always selected, arrow keys
 * move and select, and a thumb slides under the choice.
 */
export function SegmentedControl<V extends string>({
  value,
  onValueChange,
  options,
  'aria-label': ariaLabel,
  size = 'md',
  fullWidth = false,
  className,
}: SegmentedControlProps<V>) {
  const styles = useStyles();
  const enabled = useMotionEnabled();
  const thumbId = useId();
  const nodes = useRef(new Map<V, HTMLButtonElement>());
  const selectable = options.filter((option) => !option.disabled);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key))
      return;
    if (selectable.length === 0) return;
    const index = Math.max(
      0,
      selectable.findIndex((option) => option.value === value),
    );
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? selectable.length - 1
          : (index + (forward ? 1 : -1) + selectable.length) % selectable.length;
    const target = selectable[next];
    if (!target) return;
    event.preventDefault();
    onValueChange(target.value);
    nodes.current.get(target.value)?.focus();
  };

  return (
    // The key handling belongs to the group as a whole (roving focus), as the ARIA radio group pattern specifies.
    // eslint-disable-next-line jsx-a11y/interactive-supports-focus
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={mergeClasses(styles.root, fullWidth && styles.full, className)}
      onKeyDown={onKeyDown}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            ref={(node) => {
              if (node) nodes.current.set(option.value, node);
              else nodes.current.delete(option.value);
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={option.disabled}
            className={mergeClasses(styles.option, styles[size], selected && styles.selected)}
            onClick={() => onValueChange(option.value)}
          >
            {selected ? (
              enabled ? (
                <m.span
                  layoutId={`${thumbId}-thumb`}
                  aria-hidden="true"
                  className={styles.thumb}
                  transition={{ duration: motion.base / 1000, ease: motion.curve }}
                />
              ) : (
                <span aria-hidden="true" className={styles.thumb} />
              )
            ) : null}
            <span className={styles.content}>
              {option.icon ? (
                <span aria-hidden="true" className={styles.icon}>
                  {option.icon}
                </span>
              ) : null}
              {option.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
