import { toMatchConformance, type MatchableSkill, type SkillUsageRecord } from '@caseguard/domain';
import type { SkillMatch } from '@caseguard/schemas';
import { NotAnalysedError } from '../../errors';
import type { RequestContext } from '../../http/request-context';
import { LruCache } from '../counterfactuals/cache';
import type { ReplayLoader } from '../counterfactuals/replay';
import type { ColdPassOptions } from '../ports';
import { PrecedentLoader, precedentFor, type OriginPrecedent } from './precedent';
import { buildSkillUsage, matchedOnlyRecord } from './usage';

/** Effectiveness is estimated from this many of the most recent applications; older ones are only counted. */
export const MAX_USAGE_CASES = 10;
/** Matches of one skill examined when its effectiveness is recomputed. */
const MAX_EXAMINED_MATCHES = 100;
/**
 * A measurement is small (one record and a conformance summary) and the cache is what keeps the next
 * application of a skill from measuring its earlier applications again, so it holds the window of
 * several dozen skills.
 */
const USAGE_CACHE_ENTRIES = 256;

/** What measuring one application of a skill to a case yields. */
export interface Measured {
  readonly record: SkillUsageRecord;
  readonly conformance: NonNullable<SkillMatch['conformance']>;
}

/** What every measurement of one recomputation shares. */
export interface MeasureScope {
  /** The skill and the version being measured (the version read when the attempt began). */
  readonly entry: MatchableSkill;
  /** The recorded path of the case the skill came from. */
  readonly origin: OriginPrecedent;
  /** The governed action-value configuration, which the figures depend on. */
  readonly configKey: string;
  readonly options: ColdPassOptions;
}

/**
 * Measures applications of a skill: how closely the recorded steps followed it, and the recorded path
 * against the simulated baseline and against the case the skill came from. A measurement replays the
 * case, which is synchronous engine work, so it is looked up in a cache first and a cache miss is
 * announced to `options.beforeColdPass` (the caller's engine budget) before anything runs: the budget
 * counts every measurement that is not served from a cache, and an empty one refuses the request with
 * nothing run and nothing stored.
 *
 * The cache key names everything a measurement depends on (tenant, skill version, case, the case's
 * latest run, the measurement of the origin case and the governed configuration), so a hit is what a
 * new measurement would give and needs no expiry. The key is built from cheap lookups, so a hit never
 * pays for a replay.
 */
export class SkillMeasurer {
  private readonly usage = new LruCache<Measured>(USAGE_CACHE_ENTRIES);
  private readonly precedents: PrecedentLoader;

  constructor(private readonly replays: ReplayLoader) {
    this.precedents = new PrecedentLoader(replays);
  }

  /** The recorded path of the skill's origin case (measured once per run of that case). */
  originOf(
    ctx: RequestContext,
    entry: MatchableSkill,
    configKey: string,
    options: ColdPassOptions,
  ): Promise<OriginPrecedent> {
    return this.precedents.resolve(ctx, entry, options, configKey);
  }

  /** The application on the case being applied to. 409 when the case has not been analysed yet. */
  async measureCase(ctx: RequestContext, scope: MeasureScope, caseId: string): Promise<Measured> {
    const run = await ctx.repos.analysis.getLatestRun(caseId);
    if (run === null) {
      throw new NotAnalysedError('The case has not been analysed yet. Run the analysis first.');
    }
    const cached = this.cached(ctx, scope, caseId, run.id);
    if (cached !== undefined) return cached;
    scope.options.beforeColdPass?.();
    return this.measure(ctx, scope, caseId);
  }

  /**
   * The usage of every case the skill was matched or applied to, newest first. The newest
   * applications contribute recorded and baseline measures; the rest only count.
   */
  async recordsFor(
    ctx: RequestContext,
    scope: MeasureScope,
    current: SkillUsageRecord,
  ): Promise<SkillUsageRecord[]> {
    const { skill } = scope.entry;
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
      const earlier =
        measured < MAX_USAGE_CASES ? await this.remeasure(ctx, scope, match.caseId) : null;
      if (earlier !== null) {
        measured += 1;
        records.push(earlier.record);
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

  /**
   * An earlier application, measured again against the skill as it is now. Null when it cannot be
   * measured (never analysed, or failing): it is then counted without measures. A refusal of the
   * budget is not swallowed, and an abort is not either.
   */
  private async remeasure(
    ctx: RequestContext,
    scope: MeasureScope,
    caseId: string,
  ): Promise<Measured | null> {
    const run = await ctx.repos.analysis.getLatestRun(caseId);
    if (run === null) return null;
    const cached = this.cached(ctx, scope, caseId, run.id);
    if (cached !== undefined) return cached;
    scope.options.beforeColdPass?.();
    try {
      return await this.measure(ctx, scope, caseId);
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      ctx.logger.warn(
        {
          skillId: scope.entry.skill.id,
          caseId,
          errorName: error instanceof Error ? error.name : 'unknown',
        },
        'a past application could not be re-measured; it is counted without measures',
      );
      return null;
    }
  }

  private cached(
    ctx: RequestContext,
    scope: MeasureScope,
    caseId: string,
    runId: string,
  ): Measured | undefined {
    return this.usage.get(keyOf(ctx, scope, caseId, runId), ctx.now().getTime());
  }

  private async measure(
    ctx: RequestContext,
    scope: MeasureScope,
    caseId: string,
  ): Promise<Measured> {
    const replay = await this.replays.load(ctx, caseId);
    const usage = buildSkillUsage({
      replay,
      entry: scope.entry,
      applied: true,
      precedent: precedentFor(scope.origin, caseId),
    });
    const measured: Measured = {
      record: usage.record,
      conformance: toMatchConformance(usage.conformance),
    };
    // Stored under the run that was replayed, which is the latest one unless an analysis just finished.
    this.usage.set(keyOf(ctx, scope, caseId, replay.run.id), measured, ctx.now().getTime());
    return measured;
  }
}

function keyOf(ctx: RequestContext, scope: MeasureScope, caseId: string, runId: string): string {
  const { skill, version } = scope.entry;
  return [
    ctx.scope.tenantId,
    skill.id,
    version.id,
    caseId,
    runId,
    scope.origin.key,
    scope.configKey,
  ].join('|');
}
