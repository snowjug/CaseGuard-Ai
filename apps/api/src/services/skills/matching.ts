import {
  compareIso,
  createTemporalView,
  matchSkills,
  type EngineContext,
  type MatchableSkill,
} from '@caseguard/domain';
import type { AnalysisRun, SkillMatch } from '@caseguard/schemas';
import { canonicalJson, sha256Hex } from '@caseguard/security';
import type { RequestContext } from '../../http/request-context';
import { engineContextForRun, loadAnalysisInputs, type AnalysisInputs } from '../analysis';
import { LruCache } from '../counterfactuals/cache';
import type { MatchOptions } from '../ports';
import { withApplication } from './applied';
import { lastEventAtOf } from './usage';

const MATCH_CACHE_ENTRIES = 64;
const MATCH_TTL_MS = 5 * 60_000;

/** Matches computed on demand are attributed to the matcher, not to the person who happened to read them. */
const MATCHER = 'system:skill-matching';

export interface MatchContext {
  readonly inputs: AnalysisInputs;
  readonly run: AnalysisRun;
  readonly engineCtx: EngineContext;
  readonly lastEventAt: string;
}

/** The case's analysis context for matching, or null when the case has not been analysed yet. */
export async function loadMatchContext(
  ctx: RequestContext,
  caseId: string,
): Promise<MatchContext | null> {
  const inputs = await loadAnalysisInputs(ctx, caseId);
  const run = await ctx.repos.analysis.getLatestRun(caseId);
  if (run === null) return null;
  return {
    inputs,
    run,
    engineCtx: engineContextForRun(run, inputs),
    lastEventAt: lastEventAtOf({ inputs }),
  };
}

/** The persistable content of a match: bookkeeping (who and when it was written) never counts as a change. */
function contentOf(match: SkillMatch): string {
  return canonicalJson({
    ...match,
    createdAt: undefined,
    updatedAt: undefined,
    createdBy: undefined,
    version: undefined,
  });
}

/** `asOf` never reaches past the last recorded event: later instants add no evidence. */
export function clampAsOf(asOf: string, lastEventAt: string): string {
  return compareIso(asOf, lastEventAt) > 0 ? lastEventAt : asOf;
}

/**
 * The skills a read may match. Time-travelling over a case must never show the skill that was extracted
 * from that very case: its triggers were learned partly from what happened later (hindsight), so as of
 * an earlier moment its match would name facts the case had not produced yet. Reading the whole case
 * shows everything, so the skill is matched there like any other.
 */
export function skillsForRead(
  skills: readonly MatchableSkill[],
  caseId: string,
  wholeCase: boolean,
): MatchableSkill[] {
  return wholeCase
    ? [...skills]
    : skills.filter((entry) => !entry.skill.sourceCaseIds.includes(caseId));
}

/** What the matcher is given: which skills, at which version, in which lifecycle state. */
function skillsDigest(skills: readonly MatchableSkill[]): string {
  const identities = skills
    .map((entry) => [entry.skill.id, entry.version.id, entry.skill.lifecycle, entry.skill.workload])
    .sort();
  return sha256Hex(canonicalJson(identities)).slice(0, 16);
}

/**
 * Skill matching with the engine's as-of semantics. `asOf` restricts BOTH the temporal view and the
 * evidence the matcher sees: the matcher is given `createTemporalView(events, asOf)` (the engine's
 * gatekeeper, never the final analysis filtered down), the final resolution can never be part of it,
 * and it derives the knowledge state from the visible events itself, so no engine pass over the case
 * is run. Matches are computed, never written: whole-case matches are stored by the analysis snapshot
 * and by an application, and a read stores nothing.
 *
 * Every instant between two events sees the same evidence, so it shares one answer: the cache is keyed
 * by the visible events (a digest of their ids), not by the instant that was asked for.
 */
export class CaseMatcher {
  private readonly computed = new LruCache<readonly SkillMatch[]>(
    MATCH_CACHE_ENTRIES,
    MATCH_TTL_MS,
  );
  private matchingPasses = 0;

  /** How many times the matcher actually ran (a cache hit does not count). */
  get passes(): number {
    return this.matchingPasses;
  }

  async compute(
    ctx: RequestContext,
    caseId: string,
    options: MatchOptions = {},
  ): Promise<SkillMatch[]> {
    const loaded = await loadMatchContext(ctx, caseId);
    if (loaded === null) return [];
    const requested = options.asOf;
    const wholeCase = requested === undefined;
    const { inputs } = loaded;
    const clamped = wholeCase ? loaded.lastEventAt : clampAsOf(requested, loaded.lastEventAt);
    const skills = skillsForRead(inputs.skills, caseId, wholeCase);

    const view = createTemporalView(inputs.events, clamped);
    const lastVisible = view.events[view.events.length - 1];
    // The evidence cut: the moment of the last event the view can see (the asked-for instant when none).
    const instant = lastVisible?.timestamp ?? clamped;
    const fresh = this.freshMatches(ctx, {
      loaded,
      skills,
      view,
      instant,
      cacheable: lastVisible !== undefined,
      beforeColdPass: options.beforeColdPass,
    });

    const stored = await ctx.repos.skills.listMatchesForCase(caseId);
    const storedById = new Map(stored.map((match) => [match.id, match]));
    const result: SkillMatch[] = [];
    for (const match of fresh) {
      const before = storedById.get(match.id);
      const entry = skills.find((candidate) => candidate.skill.id === match.skillId);
      let current = match;
      if (before?.applied === true && entry !== undefined) {
        // An application is a fact about the case; as of an earlier instant it had not happened yet.
        const appliedAt = before.appliedAt;
        const happened =
          requested === undefined || (appliedAt !== null && compareIso(appliedAt, requested) <= 0);
        if (happened) {
          current = withApplication({
            fresh: match,
            before,
            entry,
            analysis: { view },
            pack: inputs.pack,
            config: inputs.actionConfig,
            caseId,
            throughAt: instant,
          });
        }
      }
      if (!wholeCase || before === undefined) {
        result.push(current);
        continue;
      }
      // A stored match keeps its identity (who first wrote it, when, its version); nothing is written here.
      const kept: SkillMatch = {
        ...current,
        createdAt: before.createdAt,
        createdBy: before.createdBy,
        updatedAt: before.updatedAt,
        version: before.version,
      };
      result.push(contentOf(kept) === contentOf(before) ? before : kept);
    }

    if (wholeCase) result.push(...(await this.withdrawnApplications(ctx, stored, fresh)));
    return result;
  }

  /**
   * The applications of skills that can no longer be matched (deprecated or retired since). An
   * application is a human decision and part of the case's history, so it stays visible, flagged by
   * the skill's current lifecycle state.
   */
  private async withdrawnApplications(
    ctx: RequestContext,
    stored: readonly SkillMatch[],
    fresh: readonly SkillMatch[],
  ): Promise<SkillMatch[]> {
    const present = new Set(fresh.map((match) => match.id));
    const result: SkillMatch[] = [];
    for (const match of stored) {
      if (!match.applied || present.has(match.id)) continue;
      const skill = await ctx.repos.skills.get(match.skillId);
      result.push(skill === null ? match : { ...match, lifecycle: skill.lifecycle });
    }
    return result;
  }

  /**
   * The matches of `skills` against the events visible at `instant`, before anything stored is laid
   * over them. Deterministic for its key, so a hit is exactly what a recomputation would give. A miss
   * is announced to `beforeColdPass` before the engine runs (the caller's engine budget is spent
   * there, and an empty budget refuses it).
   */
  private freshMatches(
    ctx: RequestContext,
    read: {
      readonly loaded: MatchContext;
      readonly skills: readonly MatchableSkill[];
      readonly view: ReturnType<typeof createTemporalView>;
      readonly instant: string;
      readonly cacheable: boolean;
      readonly beforeColdPass: (() => void) | undefined;
    },
  ): readonly SkillMatch[] {
    const { loaded, skills, view, instant, cacheable } = read;
    const { inputs, run } = loaded;
    const key = [
      ctx.scope.tenantId,
      inputs.caseRecord.id,
      run.id,
      sha256Hex(canonicalJson(inputs.actionConfig)).slice(0, 16),
      skillsDigest(skills),
      view.fingerprint,
    ].join('|');
    const nowMs = ctx.now().getTime();
    const cached = cacheable ? this.computed.get(key, nowMs) : undefined;
    if (cached !== undefined) return cached;

    // An instant before the first event sees nothing: that pass is trivial, so it is not metered.
    if (cacheable) read.beforeColdPass?.();
    this.matchingPasses += 1;
    // The clock of a computed match is the analysis, not the read: the same inputs give the same match.
    const matchCtx: EngineContext = {
      ...loaded.engineCtx,
      now: run.completedAt ?? run.startedAt,
      createdBy: MATCHER,
    };
    const { matches } = matchSkills({
      skills,
      analysisAsOf: { view },
      asOf: instant,
      pack: inputs.pack,
      config: inputs.actionConfig,
      ctx: matchCtx,
      caseInfo: { workload: inputs.caseRecord.workload, product: inputs.caseRecord.product },
    });
    if (cacheable) this.computed.set(key, matches, nowMs);
    return matches;
  }
}
