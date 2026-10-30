'use client';

import { VisuallyHidden, cg } from '@caseguard/ui';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { CheckmarkRegular } from '@fluentui/react-icons';

const useStyles = makeStyles({
  list: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: `${cg.space[2]} ${cg.space[4]}`,
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  step: {
    display: 'flex',
    alignItems: 'center',
    gap: cg.space[2],
    minWidth: 0,
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase300,
  },
  badge: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: '28px',
    height: '28px',
    borderRadius: cg.radius.pill,
    border: `1px solid ${cg.borderControl}`,
    backgroundColor: cg.surface,
    color: cg.textSecondary,
    fontWeight: tokens.fontWeightSemibold,
    fontVariantNumeric: 'tabular-nums',
  },
  badgeCurrent: {
    backgroundColor: cg.tone.brand.solid,
    borderTopColor: cg.tone.brand.solid,
    borderRightColor: cg.tone.brand.solid,
    borderBottomColor: cg.tone.brand.solid,
    borderLeftColor: cg.tone.brand.solid,
    color: cg.tone.brand.onSolid,
  },
  badgeDone: {
    backgroundColor: cg.tone.productive.tint,
    borderTopColor: cg.tone.productive.border,
    borderRightColor: cg.tone.productive.border,
    borderBottomColor: cg.tone.productive.border,
    borderLeftColor: cg.tone.productive.border,
    color: cg.tone.productive.fg,
  },
  labelCurrent: { color: cg.text, fontWeight: tokens.fontWeightSemibold },
  line: {
    height: '1px',
    width: '24px',
    backgroundColor: cg.borderControl,
    '@media (max-width: 639px)': { display: 'none' },
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
        return (
          <li
            key={step.id}
            className={styles.step}
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
              {done ? <CheckmarkRegular /> : index + 1}
            </span>
            <span className={active ? styles.labelCurrent : undefined}>
              <VisuallyHidden>{`Step ${index + 1} of ${steps.length}, ${done ? 'completed' : active ? 'current' : 'upcoming'}: `}</VisuallyHidden>
              {step.label}
            </span>
            {index < steps.length - 1 ? <span aria-hidden="true" className={styles.line} /> : null}
          </li>
        );
      })}
    </ol>
  );
}
