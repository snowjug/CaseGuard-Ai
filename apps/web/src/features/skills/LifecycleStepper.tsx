'use client';

import type { SkillLifecycle } from '@caseguard/schemas';
import { SKILL_LIFECYCLE_LABELS } from '@caseguard/schemas';
import { VisuallyHidden, cg } from '@caseguard/ui';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { CheckmarkCircleRegular, CircleRegular, RecordRegular } from '@fluentui/react-icons';
import { useInsightStyles } from '../quality/styles';
import { LIFECYCLE_MEANING, LIFECYCLE_PATH, WITHDRAWN_STATES, isWithdrawn } from './labels';

const useStyles = makeStyles({
  steps: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: cg.space[2],
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  step: {
    display: 'flex',
    alignItems: 'center',
    gap: cg.space[2],
    minHeight: '32px',
    padding: `${cg.space[1]} ${cg.space[3]}`,
    borderRadius: cg.radius.pill,
    border: `1px solid ${cg.borderControl}`,
    backgroundColor: cg.surface,
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase300,
  },
  done: {
    border: `1px solid ${cg.tone.productive.border}`,
    color: cg.text,
  },
  current: {
    border: `2px solid ${cg.tone.brand.solid}`,
    backgroundColor: cg.tone.brand.tint,
    color: cg.text,
    fontWeight: tokens.fontWeightSemibold,
  },
  upcoming: { border: `1px dashed ${cg.borderControl}` },
  icon: { display: 'inline-flex', fontSize: '18px', flexShrink: 0 },
  done_icon: { color: cg.tone.productive.fg },
  current_icon: { color: cg.tone.brand.fg },
});

type StepState = 'done' | 'current' | 'upcoming';

function StepIcon({ state }: { state: StepState }) {
  const styles = useStyles();
  if (state === 'done')
    return (
      <CheckmarkCircleRegular
        className={mergeClasses(styles.icon, styles.done_icon)}
        aria-hidden="true"
      />
    );
  if (state === 'current')
    return (
      <RecordRegular
        className={mergeClasses(styles.icon, styles.current_icon)}
        aria-hidden="true"
      />
    );
  return <CircleRegular className={styles.icon} aria-hidden="true" />;
}

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
 * The skill's place on its lifecycle: Discovered, Draft, Simulation Tested, Expert Reviewed, Pilot, Validated, Published.
 * Each step says "reached", "current step" or "not reached yet" in words, with an icon and an outline style, never by
 * colour alone. A skill that was withdrawn (Deprecated, Retired) shows where it ended.
 */
export function LifecycleStepper({ lifecycle, reached }: LifecycleStepperProps) {
  const styles = useStyles();
  const text = useInsightStyles();
  const withdrawn = isWithdrawn(lifecycle);
  const reachedIndex = LIFECYCLE_PATH.indexOf(reached);
  const currentIndex = LIFECYCLE_PATH.indexOf(lifecycle);
  const stateOf = (index: number): StepState => {
    if (!withdrawn && index === currentIndex) return 'current';
    if (index <= (withdrawn ? reachedIndex : currentIndex)) return 'done';
    return 'upcoming';
  };
  return (
    <div className={text.stack}>
      <ol className={styles.steps} aria-label="Skill lifecycle">
        {LIFECYCLE_PATH.map((state, index) => {
          const stepState = stateOf(index);
          return (
            <li
              key={state}
              className={mergeClasses(
                styles.step,
                stepState === 'done' && styles.done,
                stepState === 'current' && styles.current,
                stepState === 'upcoming' && styles.upcoming,
              )}
              aria-current={stepState === 'current' ? 'step' : undefined}
            >
              <StepIcon state={stepState} />
              <span>
                {SKILL_LIFECYCLE_LABELS[state]}
                <VisuallyHidden>: {STATE_TEXT[stepState]}</VisuallyHidden>
              </span>
            </li>
          );
        })}
        {WITHDRAWN_STATES.map((state) => {
          const here = lifecycle === state;
          return (
            <li
              key={state}
              className={mergeClasses(styles.step, here ? styles.current : styles.upcoming)}
              aria-current={here ? 'step' : undefined}
            >
              <StepIcon state={here ? 'current' : 'upcoming'} />
              <span>
                {SKILL_LIFECYCLE_LABELS[state]}
                <VisuallyHidden>
                  : {here ? 'current step' : 'withdrawn path, not used'}
                </VisuallyHidden>
              </span>
            </li>
          );
        })}
      </ol>
      <p className={text.text}>
        <span className={text.strong}>{SKILL_LIFECYCLE_LABELS[lifecycle]}.</span>{' '}
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
