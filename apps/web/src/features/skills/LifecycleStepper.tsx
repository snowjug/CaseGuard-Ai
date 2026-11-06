'use client';

import type { SkillLifecycle } from '@caseguard/schemas';
import { VisuallyHidden, cg } from '@caseguard/ui';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { CheckIcon } from 'lucide-react';
import {
  LIFECYCLE_LABELS,
  LIFECYCLE_MEANING,
  LIFECYCLE_PATH,
  WITHDRAWN_STATES,
  isWithdrawn,
} from './labels';

const NODE = 28;
const center = `${NODE / 2 - 1}px`;

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
  // A phone reads it top to bottom, a wider screen left to right, in the same list.
  steps: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr)',
    gap: 0,
    margin: 0,
    padding: 0,
    listStyle: 'none',
    '@media (min-width: 640px)': { gridTemplateColumns: 'repeat(7, minmax(0, 1fr))' },
  },
  step: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    gap: cg.space[3],
    minHeight: '32px',
    '@media (min-width: 640px)': {
      flexDirection: 'column',
      alignItems: 'center',
      gap: cg.space[2],
      minHeight: 0,
      textAlign: 'center',
    },
  },
  line: {
    position: 'absolute',
    left: center,
    top: '-50%',
    width: '2px',
    height: '100%',
    backgroundColor: `color-mix(in srgb, ${cg.text} 14%, transparent)`,
    '@media (min-width: 640px)': { left: '-50%', top: center, width: '100%', height: '2px' },
  },
  lineOn: { backgroundColor: `color-mix(in srgb, ${cg.tone.brand.border} 70%, transparent)` },
  node: {
    position: 'relative',
    zIndex: 1,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxSizing: 'border-box',
    width: `${NODE}px`,
    height: `${NODE}px`,
    flexShrink: 0,
    borderRadius: cg.radius.pill,
    border: `1px solid ${cg.borderControl}`,
    backgroundColor: cg.surface,
    color: cg.textMuted,
    fontSize: tokens.fontSizeBase100,
    fontWeight: tokens.fontWeightSemibold,
    fontVariantNumeric: 'tabular-nums',
  },
  nodeDone: {
    backgroundColor: cg.tone.brand.tint,
    color: cg.tone.brand.fg,
    border: `1px solid color-mix(in srgb, ${cg.tone.brand.border} 55%, transparent)`,
  },
  nodeCurrent: {
    backgroundColor: cg.tone.brand.solid,
    color: cg.tone.brand.onSolid,
    border: `1px solid ${cg.tone.brand.solid}`,
    boxShadow: `0 0 0 4px ${cg.tone.brand.tint}, 0 0 28px ${cg.glow}`,
  },
  dot: {
    width: '8px',
    height: '8px',
    borderRadius: cg.radius.pill,
    backgroundColor: cg.tone.brand.onSolid,
  },
  label: {
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textMuted,
    overflowWrap: 'anywhere',
  },
  labelDone: { color: cg.textSecondary },
  labelCurrent: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.text,
  },
  withdrawn: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: cg.space[2],
    marginTop: cg.space[2],
    gridColumn: '1 / -1',
    '@media (min-width: 640px)': { marginTop: cg.space[4] },
  },
  withdrawnLabel: { fontSize: tokens.fontSizeBase200, color: cg.textMuted },
  withdrawnList: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: cg.space[2],
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    minHeight: '28px',
    paddingInline: cg.space[3],
    borderRadius: cg.radius.pill,
    border: `1px dashed ${cg.borderControl}`,
    color: cg.textMuted,
    fontSize: tokens.fontSizeBase200,
  },
  chipCurrent: {
    border: `1px solid ${cg.tone.brand.solid}`,
    backgroundColor: cg.tone.brand.tint,
    color: cg.text,
    fontWeight: tokens.fontWeightSemibold,
  },
  chipReached: { color: cg.textSecondary },
  text: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
  },
  strong: { color: cg.text, fontWeight: tokens.fontWeightSemibold },
});

type StepState = 'done' | 'current' | 'upcoming';

const STATE_TEXT: Record<StepState, string> = {
  done: 'reached',
  current: 'current step',
  upcoming: 'not reached yet',
};

export interface LifecycleStepperProps {
  lifecycle: SkillLifecycle;
  /** The furthest state on the path the skill has reached (from its approvals), so a withdrawn skill shows how far it got. */
  reached: SkillLifecycle;
}

/**
 * The skill's place on its status path: Discovered, Draft, Tested, Reviewed, Pilot, Validated, Published. The current step
 * is large and filled, the steps behind it are small and checked, the ones ahead are quiet numbers. Each step also says
 * "reached", "current step" or "not reached yet" in words, so colour is never the only signal. A skill that was withdrawn
 * (Deprecated, Retired) shows how far it got and where it ended.
 */
export function LifecycleStepper({ lifecycle, reached }: LifecycleStepperProps) {
  const styles = useStyles();
  const withdrawn = isWithdrawn(lifecycle);
  const reachedIndex = LIFECYCLE_PATH.indexOf(reached);
  const currentIndex = LIFECYCLE_PATH.indexOf(lifecycle);
  const limit = withdrawn ? reachedIndex : currentIndex;
  const stateOf = (index: number): StepState => {
    if (!withdrawn && index === currentIndex) return 'current';
    if (index <= limit) return 'done';
    return 'upcoming';
  };
  return (
    <div className={styles.root}>
      <ol className={styles.steps} aria-label="Skill status">
        {LIFECYCLE_PATH.map((state, index) => {
          const stepState = stateOf(index);
          return (
            <li
              key={state}
              className={styles.step}
              aria-current={stepState === 'current' ? 'step' : undefined}
            >
              {index > 0 ? (
                <span
                  aria-hidden="true"
                  className={mergeClasses(styles.line, index <= limit && styles.lineOn)}
                />
              ) : null}
              <span
                aria-hidden="true"
                className={mergeClasses(
                  styles.node,
                  stepState === 'done' && styles.nodeDone,
                  stepState === 'current' && styles.nodeCurrent,
                )}
              >
                {stepState === 'done' ? (
                  <CheckIcon />
                ) : stepState === 'current' ? (
                  <span className={styles.dot} />
                ) : (
                  index + 1
                )}
              </span>
              <span
                className={mergeClasses(
                  styles.label,
                  stepState === 'done' && styles.labelDone,
                  stepState === 'current' && styles.labelCurrent,
                )}
              >
                {LIFECYCLE_LABELS[state]}
                <VisuallyHidden>: {STATE_TEXT[stepState]}</VisuallyHidden>
              </span>
            </li>
          );
        })}
        <li className={styles.withdrawn}>
          <span className={styles.withdrawnLabel}>If withdrawn:</span>
          <ul className={styles.withdrawnList} aria-label="Withdrawn">
            {WITHDRAWN_STATES.map((state) => {
              const here = lifecycle === state;
              return (
                <li
                  key={state}
                  className={mergeClasses(styles.chip, here && styles.chipCurrent)}
                  aria-current={here ? 'step' : undefined}
                >
                  {LIFECYCLE_LABELS[state]}
                  <VisuallyHidden>
                    : {here ? 'current step' : 'withdrawn path, not used'}
                  </VisuallyHidden>
                </li>
              );
            })}
          </ul>
        </li>
      </ol>
      <p className={styles.text}>
        <span className={styles.strong}>{LIFECYCLE_LABELS[lifecycle]}.</span>{' '}
        {LIFECYCLE_MEANING[lifecycle]}
      </p>
    </div>
  );
}

/** The furthest lifecycle state on the path that the skill's approvals show it reached (its current state counts). */
export function furthestReached(
  lifecycle: SkillLifecycle,
  approvals: readonly { decision: string; toState: SkillLifecycle }[],
): SkillLifecycle {
  const candidates = approvals
    .filter((approval) => approval.decision === 'approved')
    .map((approval) => approval.toState);
  const all = [lifecycle, ...candidates].filter((state) => LIFECYCLE_PATH.includes(state));
  const best = all.reduce<SkillLifecycle>(
    (top, state) => (LIFECYCLE_PATH.indexOf(state) > LIFECYCLE_PATH.indexOf(top) ? state : top),
    'discovered',
  );
  return best;
}
