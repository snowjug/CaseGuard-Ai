import type { DemoState } from '@caseguard/schemas';
import { ConflictError } from '../../errors';
import type { ContextInfrastructure } from '../../http/context-factory';
import type { RequestContext } from '../../http/request-context';
import type { DemoProfile } from '../ports';
import { resolveStoryActors } from './actors';
import { auditDemo, auditDemoQuietly } from './audit';
import { deriveSteps } from './derive';
import { loadFacts } from './facts';
import { assertDemoManageable, assertNoActiveJobs } from './guard';
import { eraseCaseData, type ErasureSummary } from './reset';
import { buildDemoState } from './state';
import { STORY_STAGES, playStory, type StoryOutcome, type StoryRun } from './story';

/** Two analyses, the validations and a few reviews: generous on a slow machine, still bounded. */
const SEED_TIMEOUT_MS = 20 * 60_000;

/** The personas must exist before anything is erased or created; a refusal is audited as denied. */
async function checkPersonas(
  infra: ContextInfrastructure,
  ctx: RequestContext,
  details: Record<string, unknown>,
): Promise<void> {
  try {
    await resolveStoryActors(ctx, infra);
  } catch (error) {
    if (error instanceof ConflictError) {
      await auditDemoQuietly(ctx, 'demo.seed', 'denied', {
        ...details,
        reason: 'personas_unavailable',
      });
    }
    throw error;
  }
}

/**
 * `base`: a clean workspace with the story at step one, for a presenter to perform it live. Cases and
 * everything derived are erased (users, settings and audit stay) and the seed marker is set. It records
 * no job: the erasure itself removes the job table.
 */
async function seedBase(infra: ContextInfrastructure, ctx: RequestContext): Promise<DemoState> {
  const details = { profile: 'base' };
  await assertNoActiveJobs(ctx, 'demo.seed', details);
  await checkPersonas(infra, ctx, details);
  let summary: ErasureSummary;
  try {
    summary = await eraseCaseData(ctx);
    await ctx.repos.demo.setSeedMarker({ seededAt: ctx.now().toISOString(), profile: 'base' });
  } catch (error) {
    await auditDemoQuietly(ctx, 'demo.seed', 'failure', { ...details, phase: 'reset' });
    throw error;
  }
  await auditDemo(ctx, 'demo.seed', 'success', { ...details, ...summary });
  return buildDemoState(ctx);
}

/** The story must end with every step done; the marker is written only then, and only once. */
async function recordSeed(ctx: RequestContext): Promise<void> {
  const state = await buildDemoState(ctx);
  const open = state.steps.find((step) => !step.completed);
  if (open !== undefined) {
    throw new ConflictError(
      `The demo story stopped at step ${open.order} (${open.title}): the stored data does not show it as done.`,
    );
  }
  const marker = await ctx.repos.demo.getSeedMarker();
  if (marker?.profile !== 'portfolio') {
    await ctx.repos.demo.setSeedMarker({ seededAt: ctx.now().toISOString(), profile: 'portfolio' });
  }
}

interface JobResultHolder {
  outcome: StoryOutcome | null;
  tally: StoryRun['tally'];
  failure: Error | null;
}

/**
 * `portfolio`: plays the whole story through the real services as its personas, inside one
 * `demo_seed` job whose stages are the story's actions. Idempotent: finished steps are skipped, an
 * interrupted run resumes, and a complete, already seeded tenant is answered without a job.
 */
async function seedPortfolio(
  infra: ContextInfrastructure,
  ctx: RequestContext,
): Promise<DemoState> {
  const details = { profile: 'portfolio' };
  const [facts, marker] = await Promise.all([loadFacts(ctx), ctx.repos.demo.getSeedMarker()]);
  const steps = deriveSteps(facts);
  if (steps.every((step) => step.completed) && marker?.profile === 'portfolio') {
    await auditDemo(ctx, 'demo.seed', 'success', {
      ...details,
      noop: true,
      completedSteps: steps.length,
    });
    return buildDemoState(ctx);
  }
  await assertNoActiveJobs(ctx, 'demo.seed', details);
  await checkPersonas(infra, ctx, details);

  const held: JobResultHolder = {
    outcome: null,
    tally: { performed: 0, skipped: 0 },
    failure: null,
  };
  const job = await ctx.services.jobs.runToCompletion(
    ctx,
    {
      kind: 'demo_seed',
      caseId: null,
      stages: STORY_STAGES,
      cancellable: false,
      timeoutMs: SEED_TIMEOUT_MS,
    },
    async (handle, jobCtx) => {
      try {
        await handle.stage('check', 'Checking the personas of the synthetic workspace');
        // The job context carries the job's own signal, so a client that disconnects cannot stop the seed halfway.
        const actors = await resolveStoryActors(jobCtx, infra);
        const run: StoryRun = { actors, handle, tally: held.tally };
        held.outcome = await playStory(run);
        await handle.stage('finish', 'Checking the story and recording the seed');
        await recordSeed(jobCtx);
        return { resultRef: null };
      } catch (error) {
        held.failure = error instanceof Error ? error : new Error('The demo seed stopped');
        throw error;
      }
    },
  );

  const { outcome } = held;
  if (job.status !== 'succeeded' || outcome === null) {
    await auditDemoQuietly(ctx, 'demo.seed', 'failure', {
      ...details,
      jobId: job.id,
      stage: job.progress.stage,
    });
    throw held.failure ?? new Error('The demo seed job ended without finishing');
  }
  await auditDemo(ctx, 'demo.seed', 'success', {
    ...details,
    jobId: job.id,
    performed: held.tally.performed,
    skipped: held.tally.skipped,
    caseOneId: outcome.caseOneId,
    caseTwoId: outcome.caseTwoId,
    skillId: outcome.skillId,
  });
  ctx.logger.info(
    { event: 'demo.seed.completed', profile: 'portfolio', jobId: job.id, ...held.tally },
    'demo data seeded',
  );
  return buildDemoState(ctx);
}

/** `demo.seed`: refused (409) outside a synthetic demo tenant; the result is the guide's state. */
export async function seedDemo(
  infra: ContextInfrastructure,
  ctx: RequestContext,
  profile: DemoProfile,
): Promise<DemoState> {
  await assertDemoManageable(ctx, 'demo.seed', { profile });
  return profile === 'base' ? seedBase(infra, ctx) : seedPortfolio(infra, ctx);
}
