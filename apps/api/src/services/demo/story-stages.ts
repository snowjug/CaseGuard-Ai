import type { SkillDna, SkillLifecycle, SkillMatch } from '@caseguard/schemas';
import type { JobHandle, JobSpec } from '../ports';
import type { StoryActors } from './actors';

/** The stages of the `demo_seed` job: one per action of the story, in the order they happen. */
export const STORY_STAGES: JobSpec['stages'] = [
  { id: 'check', label: 'Check the synthetic workspace and its personas' },
  { id: 'import-one', label: 'Ava imports Case One' },
  { id: 'analyse-one', label: 'Ava analyses Case One' },
  { id: 'accept-path', label: 'Riley accepts the better path at the earliest fork' },
  { id: 'extract-skill', label: 'Ava extracts a draft skill' },
  { id: 'draft-skill', label: 'Casey drafts the skill' },
  { id: 'simulation', label: 'Riley runs the simulation test and signs off' },
  { id: 'pilot', label: 'Riley reviews the skill and Casey approves the pilot' },
  { id: 'regression', label: 'Riley runs the regression suite and validates the skill' },
  { id: 'publish', label: 'Alex publishes the skill' },
  { id: 'import-two', label: 'Ava imports Case Two' },
  { id: 'analyse-two', label: 'Ava analyses Case Two and the skill is matched' },
  { id: 'apply-skill', label: 'Ava applies the guided plan to Case Two' },
  { id: 'mutation', label: 'Casey proposes a refinement learned from Case Two' },
  { id: 'finish', label: 'Check the story and record the seed' },
];

/** Plain-language reasons recorded with each governed step; the services keep them out of audit details. */
export const REASONS = {
  accept: 'The path is realistic: every step uses only what was known before the decision.',
  draft: 'Adopted for review from the accepted counterfactual path.',
  simulationTested: 'The simulation test replayed the source case and passed.',
  expertReviewed: 'Reviewed against the source case: each step uses only what was known then.',
  pilot: 'Approved for a pilot on the related follow-up case.',
  validated: 'The simulation test and the regression suite both passed.',
  published: 'Approved after the pilot and the regression run, by a different person.',
} as const;

/** Lifecycle states in the order a skill passes through them (withdrawn states come last). */
const LIFECYCLE_ORDER: readonly SkillLifecycle[] = [
  'discovered',
  'draft',
  'simulation_tested',
  'expert_reviewed',
  'pilot',
  'validated',
  'published',
  'deprecated',
  'retired',
];

/** Whether the skill is at `state` or beyond it. */
export const reached = (skill: SkillDna, state: SkillLifecycle): boolean =>
  LIFECYCLE_ORDER.indexOf(skill.lifecycle) >= LIFECYCLE_ORDER.indexOf(state);

/** A match made against a skill that was already validated or published. */
export const isValidatedMatch = (match: SkillMatch): boolean =>
  match.lifecycle === 'validated' || match.lifecycle === 'published';

/** One run of the story: who acts, where progress is reported, and how much was actually done. */
export interface StoryRun {
  readonly actors: StoryActors;
  readonly handle: JobHandle;
  readonly tally: { performed: number; skipped: number };
}

export interface StoryOutcome {
  readonly caseOneId: string;
  readonly caseTwoId: string;
  readonly skillId: string;
}

/** Reports a stage as running (with what it is about to do) and counts it as performed. */
export async function begin(run: StoryRun, stage: string, detail: string): Promise<void> {
  await run.handle.stage(stage, detail);
  run.tally.performed += 1;
}

/** Reports a stage as skipped because its result is already stored, and counts it. */
export async function skip(run: StoryRun, stage: string, reason: string): Promise<void> {
  await run.handle.skip(stage, reason);
  run.tally.skipped += 1;
}
