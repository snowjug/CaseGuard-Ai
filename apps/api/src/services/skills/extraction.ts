import {
  extractSkillCandidates,
  type EngineContext,
  type ExtractionRefusal,
  type SkillDraft,
} from '@caseguard/domain';
import type { CounterfactualScenario, Job, SkillDna } from '@caseguard/schemas';
import { sha256Hex } from '@caseguard/security';
import { NotFoundError, ValidationFailedError } from '../../errors';
import type { RequestContext } from '../../http/request-context';
import type { CaseReplay, ReplayLoader } from '../counterfactuals/replay';
import type { JobHandle, JobSpec, SkillExtractionOptions } from '../ports';
import { extractionRefusedError } from './errors';
import { extractionPreflight, isAccepted } from './preflight';

type StageReporter = (stageId: string, detail?: string) => Promise<void>;

const noStages: StageReporter = () => Promise.resolve();

const EXTRACT_STAGES: JobSpec['stages'] = [
  { id: 'load', label: 'Load the analysis and the accepted scenarios' },
  { id: 'extract', label: 'Distil the validated reasoning into a draft skill' },
  { id: 'save', label: 'Save the draft skill' },
];

const LIVE_JOB = new Set(['queued', 'running', 'succeeded']);

/**
 * SkillDNA extraction. Only reviewer-ACCEPTED, valid, leak-free scenarios may seed a skill (the domain
 * is called with `requireAcceptedReview` on, never off), and a skill starts as `discovered`: no gate
 * is passed on anyone's behalf. Creation and its audit event commit together.
 */
export class SkillExtractor {
  constructor(private readonly replays: ReplayLoader) {}

  /**
   * `skills.extract`: refuses what the stored records already rule out (a not accepted or invalid
   * scenario) with the engine's reasons, then queues the extraction. The same scenario answered by the
   * same job again, and extraction is idempotent: the skill id derives from the case and scenario.
   */
  async start(ctx: RequestContext, caseId: string, scenarioId: string): Promise<Job> {
    if ((await ctx.repos.cases.get(caseId)) === null) throw new NotFoundError('Case', caseId);
    const scenario = await ctx.repos.counterfactuals.get(caseId, scenarioId);
    if (scenario === null) throw new NotFoundError('Counterfactual scenario', scenarioId);
    const fork = await ctx.repos.analysis.getFork(caseId, scenario.forkId);
    const reasons = extractionPreflight({ caseId, scenario, fork });
    if (reasons.length > 0) throw extractionRefusedError([{ scenarioId, reasons }]);

    const baseKey = `skill_extraction:${sha256Hex(`${caseId}:${scenarioId}`).slice(0, 48)}`;
    const existing = await ctx.repos.jobs.findByIdempotencyKey('skill_extraction', baseKey);
    if (existing !== null && LIVE_JOB.has(existing.status)) return existing;
    const idempotencyKey = existing === null ? baseKey : `${baseKey}:${ctx.newId('try')}`;

    await ctx.audit({
      action: 'skill.extraction_requested',
      targetType: 'counterfactual',
      targetId: scenarioId,
      caseId,
      outcome: 'success',
      details: { scenarioId, forkId: scenario.forkId },
    });
    return ctx.services.jobs.start(
      ctx,
      {
        kind: 'skill_extraction',
        caseId,
        targetId: scenarioId,
        idempotencyKey,
        stages: EXTRACT_STAGES,
      },
      async (handle, jobCtx) => {
        const skills = await this.extract(jobCtx, caseId, { scenarioId }, reporterOf(handle));
        const first = skills[0];
        return { resultRef: first === undefined ? null : { type: 'skill', id: first.id } };
      },
    );
  }

  /**
   * Extracts draft skills from the accepted scenarios of a case (or from the one named) and stores
   * them. A refusal is thrown as a 422 problem that lists every reason the engine gave.
   */
  async extract(
    ctx: RequestContext,
    caseId: string,
    options: SkillExtractionOptions = {},
    report: StageReporter = noStages,
  ): Promise<SkillDna[]> {
    await report('load', 'Loading the stored analysis and the scenarios');
    const replay = await this.replays.load(ctx, caseId);
    const stored = await ctx.repos.counterfactuals.list(caseId);
    const chosen =
      options.scenarioId === undefined
        ? stored.filter(isAccepted)
        : stored.filter((scenario) => scenario.id === options.scenarioId);
    if (options.scenarioId !== undefined && chosen.length === 0) {
      throw new NotFoundError('Counterfactual scenario', options.scenarioId);
    }
    if (chosen.length === 0) {
      throw new ValidationFailedError('No scenario of this case has been accepted yet', [
        {
          path: 'scenarioId',
          message: 'Only a scenario a reviewer accepted can seed a skill: accept one first',
        },
      ]);
    }

    await report(
      'extract',
      `Distilling ${chosen.length} scenario${chosen.length === 1 ? '' : 's'}`,
    );
    const { drafts, refusals } = await this.draft(ctx, replay, caseId, chosen);
    if (drafts.length === 0) throw extractionRefusedError(refusals);

    await report('save', `Saving ${drafts.length} draft skill${drafts.length === 1 ? '' : 's'}`);
    return this.persist(ctx, caseId, drafts);
  }

  private async draft(
    ctx: RequestContext,
    replay: CaseReplay,
    caseId: string,
    scenarios: readonly CounterfactualScenario[],
  ): Promise<{ drafts: SkillDraft[]; refusals: ExtractionRefusal[] }> {
    const { inputs, analysis, engineCtx } = replay;
    // The skill is created by the person who asked for it, at the time of the request.
    const extractionCtx: EngineContext = {
      ...engineCtx,
      createdBy: ctx.auth.userId,
      now: ctx.now().toISOString(),
    };
    const byFork = new Map<string, CounterfactualScenario[]>();
    for (const scenario of scenarios) {
      byFork.set(scenario.forkId, [...(byFork.get(scenario.forkId) ?? []), scenario]);
    }

    const drafts: SkillDraft[] = [];
    const refusals: ExtractionRefusal[] = [];
    for (const [forkId, group] of byFork) {
      const fork = await ctx.repos.analysis.getFork(caseId, forkId);
      const current =
        fork !== null && analysis.forks.some((c) => c.id === fork.id && c.eventId === fork.eventId);
      if (fork === null || !current) {
        refusals.push(
          ...group.map((scenario) => ({
            scenarioId: scenario.id,
            reasons: [
              'The decision fork of this scenario is not part of the current analysis. Run the analysis again.',
            ],
          })),
        );
        continue;
      }
      const result = extractSkillCandidates({
        analysis,
        fork,
        scenarios: group,
        events: inputs.events,
        resolution: inputs.resolution,
        pack: inputs.pack,
        config: inputs.actionConfig,
        ctx: extractionCtx,
        caseInfo: { workload: inputs.caseRecord.workload, product: inputs.caseRecord.product },
        caseReference: inputs.caseRecord.reference,
        synthetic: inputs.caseRecord.synthetic,
      });
      drafts.push(...result.candidates);
      refusals.push(...result.refusals);
    }
    return { drafts, refusals };
  }

  private async persist(
    ctx: RequestContext,
    caseId: string,
    drafts: readonly SkillDraft[],
  ): Promise<SkillDna[]> {
    await ctx.repos.transaction(async (tx) => {
      for (const draft of drafts) {
        // Extraction is idempotent: the skill id derives from the case and the scenario.
        if ((await tx.skills.get(draft.skill.id)) !== null) continue;
        await tx.skills.create({ skill: draft.skill, version: draft.version });
        await ctx.audit(
          {
            action: 'skill.extracted',
            targetType: 'skill',
            targetId: draft.skill.id,
            caseId,
            outcome: 'success',
            details: {
              skillId: draft.skill.id,
              versionId: draft.version.id,
              version: draft.version.version,
              lifecycle: draft.skill.lifecycle,
              forkId: draft.provenance.forkId,
              scenarioIds: draft.sourceScenarioIds,
            },
          },
          tx,
        );
      }
    });
    const skills: SkillDna[] = [];
    for (const draft of drafts) {
      const skill = await ctx.repos.skills.get(draft.skill.id);
      if (skill !== null) skills.push(skill);
    }
    return skills;
  }
}

function reporterOf(handle: JobHandle): StageReporter {
  return (stageId, detail) => handle.stage(stageId, detail);
}
