import { proposeMutations, type MutationSourceCase, type SkillError } from '@caseguard/domain';
import type { Job, SkillDiff, SkillVersion } from '@caseguard/schemas';
import { sha256Hex } from '@caseguard/security';
import { NotFoundError } from '../../errors';
import type { RequestContext } from '../../http/request-context';
import type { ReplayLoader } from '../counterfactuals/replay';
import type { JobHandle, JobSpec, SkillMutationResult } from '../ports';
import { actorOf, opOf } from './actor';
import { loadAggregate, persistChangeSet } from './aggregate';
import { writeSkillAudits } from './audit';
import { skillErrorToAppError } from './errors';

type StageReporter = (stageId: string, detail?: string) => Promise<void>;

const noStages: StageReporter = () => Promise.resolve();

const MUTATION_STAGES: JobSpec['stages'] = [
  { id: 'load', label: 'Load the source case and its analysis' },
  { id: 'propose', label: 'Compare the case with the skill and draft a new version' },
  { id: 'save', label: 'Save the proposed version' },
];

const LIVE_JOB = new Set(['queued', 'running', 'succeeded']);

type Outcome =
  | { readonly kind: 'error'; readonly error: SkillError }
  | { readonly kind: 'no_change'; readonly reasons: readonly string[] }
  | { readonly kind: 'proposed'; readonly versionId: string; readonly diff: SkillDiff };

/**
 * Skill mutations. A mutation is only ever a PROPOSAL: a new `proposed` version that a distinct approver
 * must decide on (`skills.versionDecision`); nothing here changes the skill's current version.
 */
export class SkillMutator {
  constructor(private readonly replays: ReplayLoader) {}

  /** `skills.proposeMutation`: validates the request and queues the proposal as a `skill_mutation` job. */
  async start(ctx: RequestContext, skillId: string, sourceCaseId: string): Promise<Job> {
    const skill = await ctx.repos.skills.get(skillId);
    if (skill === null) throw new NotFoundError('Skill', skillId);
    if ((await ctx.repos.cases.get(sourceCaseId)) === null) {
      throw new NotFoundError('Case', sourceCaseId);
    }

    const digest = sha256Hex(`${skillId}:${sourceCaseId}:${skill.currentVersionId}`);
    const baseKey = `skill_mutation:${digest.slice(0, 48)}`;
    const existing = await ctx.repos.jobs.findByIdempotencyKey('skill_mutation', baseKey);
    if (existing !== null && LIVE_JOB.has(existing.status)) return existing;
    const idempotencyKey = existing === null ? baseKey : `${baseKey}:${ctx.newId('try')}`;

    await ctx.audit({
      action: 'skill.mutation_requested',
      targetType: 'skill',
      targetId: skillId,
      caseId: sourceCaseId,
      outcome: 'success',
      details: { skillId, sourceCaseId, baseVersionId: skill.currentVersionId },
    });
    return ctx.services.jobs.start(
      ctx,
      {
        kind: 'skill_mutation',
        caseId: sourceCaseId,
        targetId: skillId,
        idempotencyKey,
        stages: MUTATION_STAGES,
      },
      async (handle, jobCtx) => {
        const result = await this.propose(jobCtx, skillId, sourceCaseId, reporterOf(handle));
        if (result.status === 'proposed') {
          return { resultRef: { type: 'skill_version', id: result.version.id } };
        }
        await handle.skip('save', `No new version was proposed: ${result.reasons.join(' ')}`);
        return { resultRef: null };
      },
    );
  }

  /**
   * Proposes a version learned from `sourceCaseId`. The proposal, its audit event and the skill's
   * "has a proposed mutation" flag commit together; a refusal is audited as denied and thrown.
   */
  async propose(
    ctx: RequestContext,
    skillId: string,
    sourceCaseId: string,
    report: StageReporter = noStages,
  ): Promise<SkillMutationResult> {
    await report('load', 'Loading the source case and its analysis');
    const replay = await this.replays.load(ctx, sourceCaseId);
    const { inputs, analysis, engineCtx } = replay;
    const source: MutationSourceCase = {
      caseId: sourceCaseId,
      reference: inputs.caseRecord.reference,
      synthetic: inputs.caseRecord.synthetic,
      caseInfo: { workload: inputs.caseRecord.workload, product: inputs.caseRecord.product },
      events: inputs.events,
      resolution: inputs.resolution,
      analysis,
      pack: inputs.pack,
      config: inputs.actionConfig,
      ctx: engineCtx,
    };

    await report('propose', 'Comparing the case with the skill');
    const actor = actorOf(ctx);
    const op = opOf(ctx);
    const outcome = await ctx.repos.transaction(async (tx): Promise<Outcome> => {
      const aggregate = await loadAggregate(tx, skillId);
      const result = proposeMutations({ aggregate, source, actor, op });
      if (!result.ok) {
        await writeSkillAudits(ctx, tx, [result.error.audit]);
        return { kind: 'error', error: result.error };
      }
      if (result.value.status === 'no_change') {
        return { kind: 'no_change', reasons: result.value.reasons };
      }
      const { proposal } = result.value;
      await persistChangeSet(tx, proposal.changeSet);
      await writeSkillAudits(ctx, tx, proposal.changeSet.audit);
      return { kind: 'proposed', versionId: proposal.version.id, diff: proposal.diff };
    });

    ctx.metrics.recordSkillTransition(
      'mutation',
      outcome.kind === 'error' ? (outcome.error.audit?.outcome ?? 'failure') : 'success',
    );
    if (outcome.kind === 'error') throw skillErrorToAppError(outcome.error);
    if (outcome.kind === 'no_change') return { status: 'no_change', reasons: outcome.reasons };

    await report('save', 'Saved the proposed version');
    const version: SkillVersion | null = await ctx.repos.skills.getVersion(
      skillId,
      outcome.versionId,
    );
    if (version === null) throw new NotFoundError('Skill version', outcome.versionId);
    return { status: 'proposed', version, diff: outcome.diff };
  }
}

function reporterOf(handle: JobHandle): StageReporter {
  return (stageId, detail) => handle.stage(stageId, detail);
}
