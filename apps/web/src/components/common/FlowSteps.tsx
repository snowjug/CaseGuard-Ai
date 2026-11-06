'use client';

import { borderColors, cg } from '@caseguard/ui';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { CheckIcon } from 'lucide-react';

const useStyles = makeStyles({
  list: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: cg.space[3],
    margin: 0,
    padding: 0,
    listStyleType: 'none',
    '@media (max-width: 639px)': { gridTemplateColumns: 'minmax(0, 1fr)' },
  },
  step: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: cg.space[3],
    minWidth: 0,
    padding: `${cg.space[3]} ${cg.space[4]}`,
    borderRadius: cg.radius.lg,
    border: `1px solid ${cg.borderSubtle}`,
    color: cg.textSecondary,
  },
  current: {
    backgroundColor: cg.tone.brand.tint,
    ...borderColors(cg.tone.brand.border),
    color: cg.text,
  },
  number: {
    display: 'inline-flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    width: '28px',
    height: '28px',
    borderRadius: cg.radius.pill,
    border: `1px solid ${cg.borderControl}`,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    fontVariantNumeric: 'tabular-nums',
  },
  numberCurrent: {
    backgroundColor: cg.tone.brand.solid,
    color: cg.tone.brand.onSolid,
    ...borderColors(cg.tone.brand.solid),
  },
  numberDone: {
    backgroundColor: cg.tone.productive.tint,
    color: cg.tone.productive.fg,
    ...borderColors(cg.tone.productive.border),
  },
  text: { display: 'flex', flexDirection: 'column', gap: cg.space[1], minWidth: 0 },
  label: { fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase300 },
  hint: { fontSize: tokens.fontSizeBase200, color: cg.textSecondary },
  // On a phone the steps shrink to a row of three, so the result stays near the top of Home.
  listCompact: {
    '@media (max-width: 639px)': {
      gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
      gap: cg.space[2],
    },
  },
  stepCompact: {
    '@media (max-width: 639px)': {
      flexDirection: 'column',
      alignItems: 'center',
      gap: cg.space[1],
      padding: `${cg.space[2]} ${cg.space[1]}`,
      textAlign: 'center',
    },
  },
  hintCompact: { '@media (max-width: 639px)': { display: 'none' } },
});

export const FLOW_STEPS = [
  { label: 'Add a case', hint: 'Paste it, upload it or try a sample.' },
  { label: 'See the review', hint: 'A score, the reason and what went wrong.' },
  { label: 'Fix what matters', hint: 'The top fixes, one click to copy.' },
] as const;

/** Where the person is in the flow: 1 add a case, 2 see the review, 3 fix what matters, 4 all done. */
export type FlowStage = 1 | 2 | 3 | 4;

/**
 * The whole product in three steps, always on Home: the current one is lit, finished ones carry a check. It is a plain
 * ordered list; the current step is named in text for screen readers. `compact` keeps the three steps in one row
 * without their hints on a phone (Home, where the result comes first); the first visit and the empty states keep them.
 */
export function FlowSteps({ stage, compact = false }: { stage: FlowStage; compact?: boolean }) {
  const styles = useStyles();
  return (
    <ol
      className={mergeClasses(styles.list, compact && styles.listCompact)}
      aria-label="How CaseGuard works"
    >
      {FLOW_STEPS.map((step, index) => {
        const number = index + 1;
        const done = number < stage;
        const current = number === stage;
        return (
          <li
            key={step.label}
            className={mergeClasses(
              styles.step,
              current && styles.current,
              compact && styles.stepCompact,
            )}
            aria-current={current ? 'step' : undefined}
          >
            <span
              aria-hidden="true"
              className={mergeClasses(
                styles.number,
                current && styles.numberCurrent,
                done && styles.numberDone,
              )}
            >
              {done ? <CheckIcon /> : number}
            </span>
            <span className={styles.text}>
              <span className={styles.label}>
                {step.label}
                {done ? <span className="cg-sr-only"> (done)</span> : null}
                {current ? <span className="cg-sr-only"> (you are here)</span> : null}
              </span>
              <span className={mergeClasses(styles.hint, compact && styles.hintCompact)}>
                {step.hint}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
