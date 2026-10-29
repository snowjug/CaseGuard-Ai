import {
  checkConformance,
  compareIso,
  createTemporalView,
  matchSkills,
  runDeterministicAnalysis,
  toMatchConformance,
  type DeterministicAnalysis,
  type EngineContext,
} from '@caseguard/domain';
import type { AnalysisRun, SkillMatch } from '@caseguard/schemas';
import { canonicalJson, sha256Hex } from '@caseguard/security';
import type { RequestContext } from '../../http/request-context';
import { engineContextForRun, loadAnalysisInputs, type AnalysisInputs } from '../analysis';
import { LruCache } from '../counterfactuals/cache';
import { lastEventAtOf } from './usage';

const AS_OF_CACHE_ENTRIES = 16;
const AS_OF_TTL_MS = 5 * 60_000;

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
    engineCtx: engineContextForRun(run),
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
 * Skill matching with the engine's as-of semantics. `asOf` restricts BOTH the temporal view and the
 * evidence the matcher sees: the analysis the matcher receives is recomputed on
 * `createTemporalView(events, asOf)`, never filtered down from the final analysis, and the final
 * resolution can never be part of it. Only the whole-case match is persisted; as-of matches are
 * returned without being stored.
 */
export class CaseMatcher {
  private readonly asOfAnalyses = new LruCache<DeterministicAnalysis>(
    AS_OF_CACHE_ENTRIES,
    AS_OF_TTL_MS,
  );

  analysisAsOf(ctx: RequestContext, match: MatchContext, asOf: string): DeterministicAnalysis {
    const { inputs, run, engineCtx } = match;
    const key = [
      ctx.scope.tenantId,
      inputs.caseRecord.id,
      run.id,
      asOf,
      sha256Hex(canonicalJson(inputs.actionConfig)).slice(0, 16),
    ].join('|');
    const nowMs = ctx.now().getTime();
    const cached = this.asOfAnalyses.get(key, nowMs);
    if (cached !== undefined) return cached;
    const analysis = runDeterministicAnalysis({
      view: createTemporalView(inputs.events, asOf),
      pack: inputs.pack,
      config: inputs.actionConfig,
      ctx: engineCtx,
    });
    this.asOfAnalyses.set(key, analysis, nowMs);
    return analysis;
  }

  async match(
    ctx: RequestContext,
    caseId: string,
    options: { readonly asOf?: string | undefined } = {},
  ): Promise<SkillMatch[]> {
    const loaded = await loadMatchContext(ctx, caseId);
    if (loaded === null) return [];
    const requested = options.asOf;
    const wholeCase = requested === undefined;
    const asOf = wholeCase ? loaded.lastEventAt : clampAsOf(requested, loaded.lastEventAt);
    const { inputs } = loaded;

    const analysisAsOf = this.analysisAsOf(ctx, loaded, asOf);
    const matchCtx: EngineContext = {
      ...loaded.engineCtx,
      now: ctx.now().toISOString(),
      createdBy: MATCHER,
    };
    const set = matchSkills({
      skills: inputs.skills,
      analysisAsOf,
      asOf,
      pack: inputs.pack,
      config: inputs.actionConfig,
      ctx: matchCtx,
      caseInfo: { workload: inputs.caseRecord.workload, product: inputs.caseRecord.product },
    });

    const stored = await ctx.repos.skills.listMatchesForCase(caseId);
    const merged = set.matches.map((fresh) => {
      const before = stored.find((candidate) => candidate.id === fresh.id);
      const entry = inputs.skills.find((candidate) => candidate.skill.id === fresh.skillId);
      let match = fresh;
      if (before?.applied === true && entry !== undefined) {
        // An application is a fact about the case; as of an earlier instant it had not happened yet.
        const appliedAt = before.appliedAt;
        const happened =
          wholeCase || (appliedAt !== null && compareIso(appliedAt, requested ?? asOf) <= 0);
        if (happened) {
          match = {
            ...fresh,
            applied: true,
            appliedAt: before.appliedAt,
            appliedBy: before.appliedBy,
            conformance: toMatchConformance(
              checkConformance({
                version: entry.version,
                analysis: analysisAsOf,
                pack: inputs.pack,
                config: inputs.actionConfig,
                caseId,
                appliedAt: before.appliedAt,
                throughAt: asOf,
              }),
            ),
          };
        }
      }
      return { match, before };
    });
    if (!wholeCase) return merged.map((entry) => entry.match);

    // The whole-case match is persisted, but only when something changed: a read must not churn rows.
    const now = ctx.now().toISOString();
    const result: SkillMatch[] = [];
    const writes: SkillMatch[] = [];
    for (const { match, before } of merged) {
      if (before === undefined) {
        const created = { ...match, createdBy: MATCHER, version: 1 };
        writes.push(created);
        result.push(created);
        continue;
      }
      const kept: SkillMatch = {
        ...match,
        createdAt: before.createdAt,
        createdBy: before.createdBy,
        updatedAt: before.updatedAt,
        version: before.version,
      };
      if (contentOf(kept) === contentOf(before)) {
        result.push(before);
        continue;
      }
      const updated = { ...kept, updatedAt: now, version: before.version + 1 };
      writes.push(updated);
      result.push(updated);
    }
    if (writes.length > 0) {
      await ctx.repos.transaction(async (tx) => {
        for (const write of writes) await tx.skills.upsertMatch(write);
      });
    }
    return result;
  }
}
