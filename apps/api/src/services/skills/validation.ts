import {
  currentVersionOf,
  evaluateReplayCase,
  runSkillRegressionSuite,
  runSkillSimulationTest,
  toSkillValidation,
  type ReplayCaseInput,
  type ReplayExpectation,
  type ReplayVerdict,
  type SkillReplayCase,
} from '@caseguard/domain';
import type {
  SimulateSkillBody,
  SkillContent,
  SkillDna,
  SkillValidation,
  SkillVersion,
} from '@caseguard/schemas';
import { AppError, ConflictError, NotFoundError } from '../../errors';
import type { RequestContext } from '../../http/request-context';
import type { CaseReplay, ReplayLoader } from '../counterfactuals/replay';
import { opOf } from './actor';
import { loadAggregate } from './aggregate';

/** The most other analysed, resolved cases a regression run replays besides the skill's source cases. */
export const MAX_REGRESSION_CASES = 25;

type SourceRole = SkillContent['sourceCases'][number]['role'];

/**
 * What a regression run requires of a case. A case the skill was derived from or validated on must
 * stay non-breaking. For any other case there is no recorded ground truth about whether the skill
 * should apply, so the expectation follows what the skill does at the case's decision point: when it
 * matches, the replay must still be safe and never report a false diagnosis (`non_breaking`); when it
 * does not match, the run only confirms it stays out of the way (`not_applicable`).
 */
export function regressionExpectation(
  role: SourceRole | undefined,
  probe: ReplayVerdict,
): ReplayExpectation {
  if (role !== undefined) return 'non_breaking';
  return probe === 'not_applicable' ? 'not_applicable' : 'non_breaking';
}

export function toReplayCase(replay: CaseReplay): SkillReplayCase {
  const { inputs, analysis, engineCtx } = replay;
  return {
    caseId: inputs.caseRecord.id,
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
}

/**
 * Simulation tests and regression suites. Both replay the skill on recorded cases at their original
 * decision points using only what was known then; every outcome is a labelled simulation, never a
 * measurement. The recorded validation is what the lifecycle gates check.
 */
export class SkillValidator {
  constructor(private readonly replays: ReplayLoader) {}

  async run(
    ctx: RequestContext,
    skillId: string,
    input: Partial<SimulateSkillBody> = {},
  ): Promise<SkillValidation> {
    const kind = input.kind ?? 'simulation_test';
    const aggregate = await loadAggregate(ctx.repos, skillId);
    const version =
      input.versionId === undefined
        ? currentVersionOf(aggregate)
        : aggregate.versions.find((candidate) => candidate.id === input.versionId);
    if (version === undefined) {
      throw new NotFoundError('Skill version', input.versionId ?? aggregate.skill.currentVersionId);
    }

    const cases = await this.replayCases(ctx, aggregate.skill, version, kind, input.caseId);
    if (cases.length === 0) {
      throw new ConflictError(
        'There is no analysed, resolved case to replay the skill on. Analyse the skill’s source cases first.',
      );
    }
    const report =
      kind === 'simulation_test'
        ? runSkillSimulationTest({ skill: aggregate.skill, version, cases })
        : runSkillRegressionSuite({
            skill: aggregate.skill,
            version,
            cases: cases.map((replayCase) =>
              this.withExpectation(aggregate.skill, version, replayCase),
            ),
          });

    const validation = toSkillValidation({ report, op: opOf(ctx), executedBy: ctx.auth.userId });
    await ctx.repos.transaction(async (tx) => {
      await tx.skills.addValidation(validation);
      await ctx.audit(
        {
          action: 'skill.validation_recorded',
          targetType: 'skill_version',
          targetId: version.id,
          caseId: validation.caseId,
          outcome: 'success',
          details: {
            skillId,
            versionId: version.id,
            skillVersion: version.version,
            kind,
            outcome: validation.outcome,
            cases: report.cases.length,
            casesPassed: report.cases.filter((c) => c.passed).length,
            validationId: validation.id,
          },
        },
        tx,
      );
    });
    return validation;
  }

  /** Source cases first; a regression run adds the tenant's other analysed, resolved cases of the workload. */
  private async replayCases(
    ctx: RequestContext,
    skill: SkillDna,
    version: SkillVersion,
    kind: SimulateSkillBody['kind'],
    caseId: string | undefined,
  ): Promise<SkillReplayCase[]> {
    if (caseId !== undefined) return [toReplayCase(await this.replays.load(ctx, caseId))];

    const sourceIds = [...new Set(version.content.sourceCases.map((source) => source.caseId))];
    const replays: SkillReplayCase[] = [];
    for (const id of sourceIds) {
      const loaded = await this.tryLoad(ctx, id);
      if (loaded !== null) replays.push(toReplayCase(loaded));
    }
    if (kind === 'regression') {
      const page = await ctx.repos.cases.list({
        limit: 200,
        analysisState: 'analyzed',
        workload: skill.workload,
      });
      const seen = new Set(sourceIds);
      let others = 0;
      for (const item of page.items) {
        if (seen.has(item.id) || others >= MAX_REGRESSION_CASES) continue;
        const loaded = await this.tryLoad(ctx, item.id);
        if (loaded === null || loaded.inputs.resolution === null) continue;
        replays.push(toReplayCase(loaded));
        others += 1;
      }
    }
    return replays;
  }

  /** A case that is gone or not analysed is left out of an implicit set; any other failure propagates. */
  private async tryLoad(ctx: RequestContext, caseId: string): Promise<CaseReplay | null> {
    try {
      return await this.replays.load(ctx, caseId);
    } catch (error) {
      if (error instanceof AppError && (error.status === 404 || error.status === 409)) return null;
      throw error;
    }
  }

  private withExpectation(
    skill: SkillDna,
    version: SkillVersion,
    replayCase: SkillReplayCase,
  ): ReplayCaseInput {
    const role = version.content.sourceCases.find((s) => s.caseId === replayCase.caseId)?.role;
    const probe =
      role === undefined
        ? evaluateReplayCase(skill, version, { replayCase, expectation: 'non_breaking' }).verdict
        : 'equivalent';
    return { replayCase, expectation: regressionExpectation(role, probe) };
  }
}
