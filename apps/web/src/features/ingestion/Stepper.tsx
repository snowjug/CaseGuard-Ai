'use client';

import { VisuallyHidden, borderColors, cg } from '@caseguard/ui';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { CheckIcon } from 'lucide-react';
import type { ReactNode, Ref } from 'react';

const useStyles = makeStyles({
  list: {
    display: 'flex',
    alignItems: 'center',
    gap: cg.space[3],
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  step: {
    display: 'flex',
    alignItems: 'center',
    gap: cg.space[3],
    minWidth: 0,
    color: cg.textMuted,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightMedium,
  },
  // Every step but the last stretches, so the connector between two steps fills the row.
  grow: { flex: '1 1 0' },
  badge: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: '28px',
    height: '28px',
    borderRadius: cg.radius.pill,
    border: `1px solid ${cg.borderControl}`,
    backgroundColor: cg.surfaceSunken,
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    fontVariantNumeric: 'tabular-nums',
  },
  badgeCurrent: {
    ...borderColors(cg.tone.brand.solid),
    backgroundColor: cg.tone.brand.solid,
    color: cg.tone.brand.onSolid,
    boxShadow: `0 0 0 4px color-mix(in srgb, ${cg.tone.brand.solid} 24%, transparent)`,
  },
  badgeDone: {
    ...borderColors(cg.tone.brand.border),
    backgroundColor: cg.tone.brand.tint,
    color: cg.tone.brand.fg,
  },
  labelCurrent: { color: cg.text, fontWeight: tokens.fontWeightSemibold },
  labelDone: { color: cg.textSecondary },
  line: {
    flex: '1 1 auto',
    minWidth: cg.space[4],
    height: '2px',
    borderRadius: cg.radius.pill,
    backgroundColor: cg.borderSubtle,
  },
  lineDone: { backgroundColor: `color-mix(in srgb, ${cg.tone.brand.solid} 60%, transparent)` },
  heading: {
    margin: 0,
    color: cg.text,
    fontSize: tokens.fontSizeBase500,
    lineHeight: tokens.lineHeightBase500,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.015em',
    outlineStyle: 'none',
  },
});

export interface StepperStep {
  id: string;
  label: string;
}

export interface StepperProps {
  steps: readonly StepperStep[];
  /** Zero-based index of the step in progress. */
  current: number;
  label?: string;
}

/** Wizard progress as an ordered list: completed, current (`aria-current="step"`) and upcoming steps, never colour alone. */
export function Stepper({ steps, current, label = 'Steps' }: StepperProps) {
  const styles = useStyles();
  return (
    <ol className={styles.list} aria-label={label}>
      {steps.map((step, index) => {
        const done = index < current;
        const active = index === current;
        const last = index === steps.length - 1;
        return (
          <li
            key={step.id}
            className={mergeClasses(styles.step, !last && styles.grow)}
            {...(active ? { 'aria-current': 'step' as const } : {})}
          >
            <span
              aria-hidden="true"
              className={mergeClasses(
                styles.badge,
                active && styles.badgeCurrent,
                done && styles.badgeDone,
              )}
            >
              {done ? <CheckIcon /> : index + 1}
            </span>
            <span className={mergeClasses(active && styles.labelCurrent, done && styles.labelDone)}>
              <VisuallyHidden>{`Step ${index + 1} of ${steps.length}, ${done ? 'completed' : active ? 'current' : 'upcoming'}: `}</VisuallyHidden>
              {step.label}
            </span>
            {last ? null : (
              <span
                aria-hidden="true"
                className={mergeClasses(styles.line, done && styles.lineDone)}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

export interface StepHeadingProps {
  /** The page moves focus here when the step changes, so keyboard and screen-reader users start at the right place. */
  ref?: Ref<HTMLHeadingElement>;
  className?: string;
  children: ReactNode;
}

/** The `h2` of the current step: a short plain title, focusable by script only. */
export function StepHeading({ ref, className, children }: StepHeadingProps) {
  const styles = useStyles();
  return (
    <h2 ref={ref} tabIndex={-1} className={mergeClasses(styles.heading, className)}>
      {children}
    </h2>
  );
}
