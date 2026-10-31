import {
  impactPrecedentOf,
  type MatchableSkill,
  type SkillImpactPrecedent,
} from '@caseguard/domain';
import type { ActionValueConfig } from '@caseguard/schemas';
import { canonicalJson, sha256Hex } from '@caseguard/security';
import { AppError } from '../../errors';
import type { RequestContext } from '../../http/request-context';
import { LruCache } from '../counterfactuals/cache';
import type { ReplayLoader } from '../counterfactuals/replay';
import type { ColdPassOptions } from '../ports';
import type { PrecedentOutcome } from './usage';

const PRECEDENT_CACHE_ENTRIES = 32;

/** Failures of `ReplayLoader.load` that mean the case cannot be replayed (not found, not analysed, unsupported). */
const REPLAY_REFUSALS: readonly number[] = [404, 409, 422];

/**
 * The recorded path of the case a skill came from, as one skill version needs it: measured once per
 * run of that case and shared by every application of the skill. `key` names everything the figures
 * depend on, so a record measured under one key is never reused under another (the origin was erased,
 * analysed again or measured with other settings).
 */
export type OriginPrecedent =
  | {
      readonly kind: 'measured';
      readonly caseId: string;
      readonly key: string;
      readonly precedent: SkillImpactPrecedent;
    }
  | { readonly kind: 'unavailable'; readonly caseId: string | null; readonly key: string };

/** The case a skill version came from: the source case with the role `origin`, else the first one named. */
export function originCaseIdOf(entry: MatchableSkill): string | null {
  const origin = entry.version.content.sourceCases.find((source) => source.role === 'origin');
  return origin?.caseId ?? entry.skill.sourceCaseIds[0] ?? null;
}

/** What one applied case is compared with. The origin case is never compared with its own path. */
export function precedentFor(origin: OriginPrecedent, appliedCaseId: string): PrecedentOutcome {
  if (origin.caseId === appliedCaseId) return { precedent: null, unavailable: 'origin_case' };
  return origin.kind === 'measured'
    ? { precedent: origin.precedent }
    : { precedent: null, unavailable: 'origin_unavailable' };
}

const configFingerprint = (config: ActionValueConfig): string =>
  sha256Hex(canonicalJson(config)).slice(0, 16);

/**
 * What the governed action-value configuration contributes to a cache key: a measurement made under
 * one configuration is never reused under another.
 */
export async function configKeyOf(ctx: Pick<RequestContext, 'repos'>): Promise<string> {
  const settings = await ctx.repos.governance.getSettings();
  return configFingerprint(settings.action_value.value);
}

/**
 * Measures the recorded path of a skill's origin case so applications can be compared with it. Both are
 * recorded paths from their own decision point, measured the same way. A case that no longer exists,
 * was never analysed or cannot be measured gives no precedent, and says so; it never fails the caller.
 *
 * The cache needs no expiry: its key carries everything a measurement depends on (tenant, skill
 * version, origin case, its run and the governed configuration), so a hit is what a new measurement
 * would give, and a new run or a changed configuration is simply another key.
 */
export class PrecedentLoader {
  private readonly measured = new LruCache<SkillImpactPrecedent | null>(PRECEDENT_CACHE_ENTRIES);

  constructor(private readonly replays: ReplayLoader) {}

  /**
   * The origin's recorded path for this skill version. A first measurement of a run replays the origin
   * case, which is cold engine work: it is announced to `options.beforeColdPass` before it starts (a
   * cached measurement is free). Cheap lookups first, so an erased origin costs no replay. A caller
   * that has the configuration key already passes it, so the settings are read once.
   */
  async resolve(
    ctx: RequestContext,
    entry: MatchableSkill,
    options: ColdPassOptions = {},
    configKey?: string,
  ): Promise<OriginPrecedent> {
    const caseId = originCaseIdOf(entry);
    if (caseId === null) return { kind: 'unavailable', caseId, key: 'no-origin' };

    const [caseRecord, run, config] = await Promise.all([
      ctx.repos.cases.get(caseId),
      ctx.repos.analysis.getLatestRun(caseId),
      configKey ?? configKeyOf(ctx),
    ]);
    if (caseRecord === null || run === null) {
      return { kind: 'unavailable', caseId, key: `gone|${caseId}` };
    }
    const { skill, version } = entry;
    const key = [ctx.scope.tenantId, skill.id, version.id, caseId, run.id, config].join('|');
    const nowMs = ctx.now().getTime();
    const cached = this.measured.get(key, nowMs);
    if (cached !== undefined) return outcomeOf(caseId, key, cached);

    options.beforeColdPass?.();
    try {
      const replay = await this.replays.load(ctx, caseId);
      const precedent = impactPrecedentOf({
        reference: caseRecord.reference,
        analysis: replay.analysis,
        pack: replay.inputs.pack,
        minimumEvidence: version.content.minimumEvidence.map((item) => item.requirementId),
      });
      // A path that never reached a diagnosis has no time to diagnosis to compare with.
      const usable = precedent !== null && precedent.reachedDiagnosis ? precedent : null;
      this.measured.set(key, usable, nowMs);
      return outcomeOf(caseId, key, usable);
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      const refused = error instanceof AppError && REPLAY_REFUSALS.includes(error.status);
      if (!refused) {
        ctx.logger.warn(
          { skillId: skill.id, originCaseId: caseId, errorName: errorNameOf(error) },
          'the recorded path of the origin case could not be measured; the application has no precedent',
        );
      }
      return { kind: 'unavailable', caseId, key: `unmeasured|${key}` };
    }
  }
}

function outcomeOf(
  caseId: string,
  key: string,
  precedent: SkillImpactPrecedent | null,
): OriginPrecedent {
  return precedent === null
    ? { kind: 'unavailable', caseId, key: `unmeasured|${key}` }
    : { kind: 'measured', caseId, key, precedent };
}

const errorNameOf = (error: unknown): string => (error instanceof Error ? error.name : 'unknown');
