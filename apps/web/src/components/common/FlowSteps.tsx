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
  text: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
  label: { fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase300 },
  hint: { fontSize: tokens.fontSizeBase200, color: cg.textSecondary },
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
 * ordered list; the current step is named in text for screen readers.
 */
export function FlowSteps({ stage }: { stage: FlowStage }) {
  const styles = useStyles();
  return (
    <ol className={styles.list} aria-label="How CaseGuard works">
      {FLOW_STEPS.map((step, index) => {
        const number = index + 1;
        const done = number < stage;
        const current = number === stage;
        return (
          <li
            key={step.label}
            className={mergeClasses(styles.step, current && styles.current)}
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
              <span className={styles.hint}>{step.hint}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
