import {
  MATCHABLE_LIFECYCLES,
  aggregateSkillEffectiveness,
  type MatchableSkill,
} from '@caseguard/domain';
import type { SkillDna, SkillEffectiveness, SkillMatch } from '@caseguard/schemas';
import { ConflictError, NotAnalysedError, NotFoundError, VersionConflictError } from '../../errors';
import type { RequestContext } from '../../http/request-context';
import type { ReplayLoader } from '../counterfactuals/replay';
import type { ColdPassOptions } from '../ports';
import { SkillMeasurer, type Measured, type MeasureScope } from './measure';
import { loadMatchContext, type CaseMatcher } from './matching';
import { configKeyOf } from './precedent';

/**
 * How often one application is recomputed when the skill changes under it. A recomputation is cheap
 * after the first (every measurement is cached), so a few more tries are better than a 409 for a
 * request that only lost a race.
 */
export const APPLY_ATTEMPTS = 5;

/**
 * Applying a skill records that an engineer adopted its guided plan for a case. It is idempotent
 * (applying twice changes nothing and is audited once), refuses skills that are not yet in a pilot,
 * validated or published state and skills that do not apply to the case, and stores the match and
 * updates the skill's effectiveness aggregate in the same transaction as its audit event.
 *
 * The effectiveness aggregate is recomputed from the applications stored so far, which takes a while
 * when it is cold, so the write is guarded: the skill is read, with its version, before anything is
 * measured, and the transaction updates it only at that version. Another application (or any change)
 * committed meanwhile makes the write a version conflict and the application is recomputed from what is
 * stored then, so no application is ever missing from the aggregate it should be in. The transaction
 * also looks at the stored match again: an application someone else recorded meanwhile stays as it
 * was (no second write, no second audit event).
 *
 * Every measurement that no cache can serve (the case itself, the recorded path of the case the skill
 * came from, and each earlier application that has to be measured again; see `measure.ts`) is announced
 * to `options.beforeColdPass` first, where the HTTP layer spends the caller's engine budget.
 *
 * Effectiveness is measured two ways, and both are estimates: against a simulated "without the skill"
 * baseline, and against the recorded path of the case the skill came from (`precedent.ts`). The
 * second is skipped, and says so, for an application on that case itself and when that case is gone.
 */
export class SkillApplier {
  private readonly measurer: SkillMeasurer;

  constructor(
    replays: ReplayLoader,
    private readonly matcher: CaseMatcher,
  ) {
    this.measurer = new SkillMeasurer(replays);
  }

  /**
   * `skillMatches.apply`: a match is addressed by its deterministic id, which the list route returned:
   * the match is computed now (nothing was stored by listing it) or was stored by an analysis or an
   * earlier application. 404 when the case has no such match (also across tenants).
   */
  async applyMatch(
    ctx: RequestContext,
    caseId: string,
    matchId: string,
    options: ColdPassOptions = {},
  ): Promise<SkillMatch> {
    const listed = (await this.matcher.compute(ctx, caseId, options)).find(
      (match) => match.id === matchId,
    );
    const found = listed ?? (await ctx.repos.skills.getMatch(caseId, matchId));
    if (found === null) throw new NotFoundError('Skill match', matchId);
    return this.apply(ctx, caseId, found.skillId, options);
  }

  async apply(
    ctx: RequestContext,
    caseId: string,
    skillId: string,
    options: ColdPassOptions = {},
  ): Promise<SkillMatch> {
    await this.requireApplicable(ctx, skillId);
    if ((await loadMatchContext(ctx, caseId)) === null) {
      throw new NotAnalysedError('The case has not been analysed yet. Run the analysis first.');
    }

    const matches = await this.matcher.compute(ctx, caseId, options);
    const match = matches.find((candidate) => candidate.skillId === skillId);
    if (match === undefined) {
      throw new ConflictError('This skill covers a different workload than the case.');
    }
    if (match.applicability === 'not_applicable') {
      throw new ConflictError(
        'The skill does not apply to this case (a required trigger is unmet or an exclusion holds), so it cannot be applied.',
      );
    }
    if (match.applied) return match;

    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.record(ctx, caseId, skillId, match, options);
      } catch (error) {
        // The skill changed while its effectiveness was being recomputed: recompute from what is stored now.
        if (!(error instanceof VersionConflictError) || attempt >= APPLY_ATTEMPTS) throw error;
      }
    }
  }

  /** The skill as it is now: 404 when it is gone, 409 unless it may be matched (pilot, validated or published). */
  private async requireApplicable(ctx: RequestContext, skillId: string): Promise<SkillDna> {
    const skill = await ctx.repos.skills.get(skillId);
    if (skill === null) throw new NotFoundError('Skill', skillId);
    if (!MATCHABLE_LIFECYCLES.includes(skill.lifecycle)) {
      throw new ConflictError(
        `Only pilot, validated or published skills can be applied to a case; this skill is ${skill.lifecycle}.`,
      );
    }
    return skill;
  }

  /**
   * One attempt. Everything is computed from what is read here and committed only if the skill is
   * still at the version read first (`commit`), so an attempt that lost a race throws a
   * VersionConflictError and its caller starts again.
   */
  private async record(
    ctx: RequestContext,
    caseId: string,
    skillId: string,
    match: SkillMatch,
    options: ColdPassOptions,
  ): Promise<SkillMatch> {
    const skill = await this.requireApplicable(ctx, skillId);
    // Someone applied it since the caller looked: it stays as it was, nothing is measured.
    const stored = await ctx.repos.skills.getMatch(caseId, match.id);
    if (stored?.applied === true) return stored;
    // The match was computed for a version that is no longer the skill's current one: its plan and
    // conformance are not what this attempt would measure.
    if (match.versionId !== skill.currentVersionId) {
      throw new ConflictError(
        'The skill moved to a new version while it was being applied. List the matches again and apply again.',
      );
    }

    const version = await ctx.repos.skills.getVersion(skill.id, skill.currentVersionId);
    if (version === null) {
      throw new ConflictError('The skill is no longer available for matching.');
    }
    const entry: MatchableSkill = { skill, version };
    const configKey = await configKeyOf(ctx);
    // Resolved once for the whole recomputation: the recorded path of the case the skill came from.
    const origin = await this.measurer.originOf(ctx, entry, configKey, options);
    const scope: MeasureScope = { entry, origin, configKey, options };
    const measured = await this.measurer.measureCase(ctx, scope, caseId);
    const records = await this.measurer.recordsFor(ctx, scope, measured.record);
    const { effectiveness } = aggregateSkillEffectiveness(records, { skillId: skill.id });
    return this.commit(ctx, caseId, skill, match, measured, effectiveness);
  }

  private async commit(
    ctx: RequestContext,
    caseId: string,
    skill: SkillDna,
    match: SkillMatch,
    measured: Measured,
    effectiveness: SkillEffectiveness,
  ): Promise<SkillMatch> {
    const now = ctx.now().toISOString();
    await ctx.repos.transaction(async (tx) => {
      // The match may have been computed by the read that listed it and not stored yet: an application
      // is what stores it (an analysis snapshot is the other way a whole-case match gets stored).
      const existing = await tx.skills.getMatch(caseId, match.id);
      // Applied by someone else while this was being measured: it stays as it was, with one audit event.
      if (existing?.applied === true) return;
      // At the version read before measuring: a skill that changed since (another application, a
      // transition) is a conflict, never a silent overwrite of an aggregate built from older data.
      await tx.skills.update(skill.id, { effectiveness }, skill.version);
      await tx.skills.upsertMatch({
        ...match,
        applied: true,
        appliedAt: now,
        appliedBy: ctx.auth.userId,
        conformance: measured.conformance,
        createdAt: existing?.createdAt ?? match.createdAt,
        createdBy: existing?.createdBy ?? match.createdBy,
        updatedAt: now,
        version: existing === null ? 1 : existing.version + 1,
      });
      await ctx.audit(
        {
          action: 'skill.applied',
          targetType: 'skill',
          targetId: skill.id,
          caseId,
          outcome: 'success',
          details: {
            matchId: match.id,
            versionId: match.versionId,
            skillVersion: match.skillVersion,
            applicability: match.applicability,
            score: match.score,
            stepsFollowed: measured.conformance.stepsFollowed,
            stepsTotal: measured.conformance.stepsTotal,
            conformanceScore: measured.conformance.score,
          },
        },
        tx,
      );
    });

    const stored = await ctx.repos.skills.getMatch(caseId, match.id);
    if (stored === null) throw new NotFoundError('Skill match', match.id);
    return stored;
  }
}
