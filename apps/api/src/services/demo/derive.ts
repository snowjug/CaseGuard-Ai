import type { DemoStep } from '@caseguard/schemas';
import { STEP_SPECS } from './steps';
import type { DemoFacts } from './types';

/**
 * The guide's 13 steps with progress taken from stored facts.
 *
 * Steps unlock in order: a step is enabled when it is complete or is the first one that is not, and
 * every later step is locked with the step it waits for named in `lockedReason`. Exactly one step is
 * the next action: the first incomplete step, or the last step (the comparison) once the story is
 * complete, so a presenter always has one place to go next.
 */
export function deriveSteps(facts: DemoFacts): DemoStep[] {
  const done = STEP_SPECS.map((spec) => spec.done(facts));
  const firstOpen = done.indexOf(false);
  const nextIndex = firstOpen === -1 ? STEP_SPECS.length - 1 : firstOpen;
  const blocker = firstOpen === -1 ? undefined : STEP_SPECS[firstOpen];

  return STEP_SPECS.map((spec, index) => {
    const completed = done[index] === true;
    const enabled = completed || index === nextIndex;
    return {
      id: spec.id,
      order: index + 1,
      title: spec.title,
      description: spec.description,
      presenterNotes: spec.presenterNotes,
      persona: spec.persona,
      actionLabel: spec.actionLabel,
      route: spec.route(facts),
      completed,
      enabled,
      lockedReason:
        enabled || blocker === undefined
          ? null
          : `Complete step ${firstOpen + 1} first: ${blocker.title}.`,
      isNextAction: index === nextIndex,
    };
  });
}

/** How many of the story's steps the stored facts show as done. */
export function completedCount(steps: readonly DemoStep[]): number {
  return steps.filter((step) => step.completed).length;
}
