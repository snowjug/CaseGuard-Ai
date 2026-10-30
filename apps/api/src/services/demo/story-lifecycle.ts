import type { SkillDna, SkillLifecycle } from '@caseguard/schemas';
import { ConflictError, NotFoundError } from '../../errors';
import type { RequestContext } from '../../http/request-context';
import { REASONS, begin, reached, skip, type StoryRun } from './story-stages';

async function currentSkill(ctx: RequestContext, skillId: string): Promise<SkillDna> {
  const skill = await ctx.repos.skills.get(skillId);
  if (skill === null) throw new NotFoundError('Skill', skillId);
  return skill;
}

/** One governed move; the optimistic lock is the version just read, as a client would send it. */
async function move(
  actor: RequestContext,
  skillId: string,
  toState: SkillLifecycle,
  reason: string,
): Promise<void> {
  const skill = await currentSkill(actor, skillId);
  await actor.services.skills.transition(actor, skillId, {
    toState,
    reason,
    expectedVersion: skill.version,
  });
}

/** Runs the validation unless the current version already has a passed one; a failure stops the story. */
async function ensureValidation(
  actor: RequestContext,
  skillId: string,
  kind: 'simulation_test' | 'regression',
): Promise<void> {
  const skill = await currentSkill(actor, skillId);
  const recorded = await actor.repos.skills.listValidations(skillId);
  const passed = recorded.some(
    (v) => v.kind === kind && v.versionId === skill.currentVersionId && v.outcome === 'passed',
  );
  if (passed) return;
  const result = await actor.services.skills.runValidation(actor, skillId, { kind });
  if (result.outcome !== 'passed') {
    const label = kind === 'simulation_test' ? 'simulation test' : 'regression suite';
    throw new ConflictError(`The ${label} of the skill did not pass (${result.outcome}).`);
  }
}

/**
 * Walks the skill through the governed lifecycle with the people the four-eyes rules require: the
 * curator drafts, the reviewer tests and reviews, the curator approves the pilot, the reviewer
 * validates, and the administrator publishes. Each move is skipped when the skill is already past it.
 */
export async function walkLifecycle(run: StoryRun, skillId: string): Promise<void> {
  const { curator, reviewer, administrator } = run.actors;
  const state = async (): Promise<SkillDna> => currentSkill(curator, skillId);

  if (reached(await state(), 'draft'))
    await skip(run, 'draft-skill', 'The skill is already a draft');
  else {
    await begin(run, 'draft-skill', 'Moving the discovered skill to draft');
    await move(curator, skillId, 'draft', REASONS.draft);
  }

  if (reached(await state(), 'simulation_tested')) {
    await skip(run, 'simulation', 'The skill already passed its simulation test');
  } else {
    await begin(run, 'simulation', 'Replaying the source case with the draft skill');
    await ensureValidation(reviewer, skillId, 'simulation_test');
    await move(reviewer, skillId, 'simulation_tested', REASONS.simulationTested);
  }

  const beforePilot = await state();
  if (reached(beforePilot, 'pilot'))
    await skip(run, 'pilot', 'The skill is already in or past its pilot');
  else {
    await begin(run, 'pilot', 'Expert review, then pilot approval by a second person');
    if (!reached(beforePilot, 'expert_reviewed')) {
      await move(reviewer, skillId, 'expert_reviewed', REASONS.expertReviewed);
    }
    await move(curator, skillId, 'pilot', REASONS.pilot);
  }

  if (reached(await state(), 'validated')) {
    await skip(run, 'regression', 'The skill is already validated');
  } else {
    await begin(run, 'regression', 'Replaying the skill on every analysed, resolved case');
    await ensureValidation(reviewer, skillId, 'regression');
    await move(reviewer, skillId, 'validated', REASONS.validated);
  }

  if (reached(await state(), 'published')) {
    await skip(run, 'publish', 'The skill is already published');
  } else {
    await begin(
      run,
      'publish',
      'Publishing needs a third person: not the creator, not the pilot approver',
    );
    await move(administrator, skillId, 'published', REASONS.published);
  }

  const final = await state();
  if (final.lifecycle !== 'published') {
    throw new ConflictError(
      `The story skill is ${final.lifecycle}, so it can no longer be matched to Case Two. Reset the demo data to start again.`,
    );
  }
}
