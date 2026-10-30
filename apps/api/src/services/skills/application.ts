import {
  MATCHABLE_LIFECYCLES,
  aggregateSkillEffectiveness,
  toMatchConformance,
  type MatchableSkill,
  type SkillUsageRecord,
} from '@caseguard/domain';
import type { SkillDna, SkillMatch } from '@caseguard/schemas';
import { ConflictError, NotFoundError, VersionConflictError } from '../../errors';
import type { RequestContext } from '../../http/request-context';
import { LruCache } from '../counterfactuals/cache';
import type { ReplayLoader } from '../counterfactuals/replay';
import type { ColdPassOptions } from '../ports';
import { loadMatchContext, type CaseMatcher } from './matching';
import { buildSkillUsage, matchedOnlyRecord } from './usage';

/** Effectiveness is estimated from this many of the most recent applications; older ones are only counted. */
export const MAX_USAGE_CASES = 10;
/** Matches of one skill examined when its effectiveness is recomputed. */
const MAX_EXAMINED_MATCHES = 100;
const USAGE_CACHE_ENTRIES = 64;
const APPLY_ATTEMPTS = 3;

/**
 * Applying a skill records that an engineer adopted its guided plan for a case. It is idempotent
 * (applying twice changes nothing and is audited once), refuses skills that are not yet in a pilot,
 * validated or published state and skills that do not apply to the case, and stores the match and
 * updates the skill's effectiveness aggregate in the same transaction as its audit event. The passes
 * that are not served from a cache (matching, and measuring a first application) are announced to
 * `options.beforeColdPass`, where the HTTP layer spends the caller's engine budget.
 */
export class SkillApplier {
  private readonly usage = new LruCache<SkillUsageRecord>(USAGE_CACHE_ENTRIES);

  constructor(
    private readonly replays: ReplayLoader,
    private readonly matcher: CaseMatcher,
  ) {}

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
    const skill = await ctx.repos.skills.get(skillId);
    if (skill === null) throw new NotFoundError('Skill', skillId);
    if (!MATCHABLE_LIFECYCLES.includes(skill.lifecycle)) {
      throw new ConflictError(
        `Only pilot, validated or published skills can be applied to a case; this skill is ${skill.lifecycle}.`,
      );
    }
    if ((await loadMatchContext(ctx, caseId)) === null) {
      throw new ConflictError('The case has not been analysed yet. Run the analysis first.');
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

    // Measuring the application replays the case: announced once, however often it is retried.
    options.beforeColdPass?.();
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.record(ctx, caseId, skill, match);
      } catch (error) {
        // Someone else changed the skill while its effectiveness was being recomputed: recompute.
        if (!(error instanceof VersionConflictError) || attempt >= APPLY_ATTEMPTS) throw error;
      }
    }
  }

  private async record(
    ctx: RequestContext,
    caseId: string,
    skill: SkillDna,
    match: SkillMatch,
  ): Promise<SkillMatch> {
    const replay = await this.replays.load(ctx, caseId);
    const entry = replay.inputs.skills.find((candidate) => candidate.skill.id === skill.id);
    if (entry === undefined)
      throw new ConflictError('The skill is no longer available for matching.');
    const usage = buildSkillUsage({ replay, entry, applied: true });
    const records = await this.recordsFor(ctx, skill, usage.record);
    const effectiveness = aggregateSkillEffectiveness(records, { skillId: skill.id }).effectiveness;

    const now = ctx.now().toISOString();
    await ctx.repos.transaction(async (tx) => {
      const current = await tx.skills.get(skill.id);
      if (current === null) throw new NotFoundError('Skill', skill.id);
      // The match may have been computed by the read that listed it and not stored yet: an application
      // is what stores it (an analysis snapshot is the other way a whole-case match gets stored).
      const existing = await tx.skills.getMatch(caseId, match.id);
      const applied: SkillMatch = {
        ...match,
        applied: true,
        appliedAt: now,
        appliedBy: ctx.auth.userId,
        conformance: toMatchConformance(usage.conformance),
        createdAt: existing?.createdAt ?? match.createdAt,
        createdBy: existing?.createdBy ?? match.createdBy,
        updatedAt: now,
        version: existing === null ? 1 : existing.version + 1,
      };
      await tx.skills.upsertMatch(applied);
      await tx.skills.update(skill.id, { effectiveness }, current.version);
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
            stepsFollowed: usage.conformance.stagesFollowed,
            stepsTotal: usage.conformance.stagesTotal,
            conformanceScore: usage.conformance.score,
          },
        },
        tx,
      );
    });

    const stored = await ctx.repos.skills.getMatch(caseId, match.id);
    if (stored === null) throw new NotFoundError('Skill match', match.id);
    return stored;
  }

  /**
   * The usage of every case the skill was matched or applied to. The newest applications contribute
   * recorded and baseline measures (cached per skill version, case and run); the rest only count.
   */
  private async recordsFor(
    ctx: RequestContext,
    skill: SkillDna,
    current: SkillUsageRecord,
  ): Promise<SkillUsageRecord[]> {
    const records: SkillUsageRecord[] = [current];
    const stored = await ctx.repos.skills.listMatchesForSkill(skill.id);
    let measured = 1;
    for (const match of stored.slice(0, MAX_EXAMINED_MATCHES)) {
      if (match.caseId === current.caseId) continue;
      const caseRecord = await ctx.repos.cases.get(match.caseId);
      if (caseRecord === null) continue;
      const base = {
        skillId: skill.id,
        versionId: match.versionId,
        caseId: match.caseId,
        synthetic: caseRecord.synthetic,
      };
      if (!match.applied) {
        if (match.applicability !== 'not_applicable') records.push(matchedOnlyRecord(base));
        continue;
      }
      const measuredRecord =
        measured < MAX_USAGE_CASES ? await this.measure(ctx, skill, match) : null;
      if (measuredRecord !== null) {
        measured += 1;
        records.push(measuredRecord);
      } else {
        records.push({
          ...matchedOnlyRecord(base),
          applied: true,
          conformanceScore: match.conformance?.score ?? null,
        });
      }
    }
    return records;
  }

  private async measure(
    ctx: RequestContext,
    skill: SkillDna,
    match: SkillMatch,
  ): Promise<SkillUsageRecord | null> {
    try {
      const replay = await this.replays.load(ctx, match.caseId);
      const entry: MatchableSkill | undefined = replay.inputs.skills.find(
        (candidate) => candidate.skill.id === skill.id,
      );
      if (entry === undefined) return null;
      const key = [
        ctx.scope.tenantId,
        skill.id,
        entry.version.id,
        match.caseId,
        replay.run.id,
      ].join('|');
      const nowMs = ctx.now().getTime();
      const cached = this.usage.get(key, nowMs);
      if (cached !== undefined) return cached;
      const record = buildSkillUsage({ replay, entry, applied: true }).record;
      this.usage.set(key, record, nowMs);
      return record;
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      ctx.logger.warn(
        { err: error, skillId: skill.id },
        'a past application could not be re-measured; it is counted without measures',
      );
      return null;
    }
  }
}
