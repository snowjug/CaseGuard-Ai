import {
  createFullView,
  runDeterministicAnalysis,
  type DeterministicAnalysis,
  type EngineContext,
} from '@caseguard/domain';
import type { AnalysisRun } from '@caseguard/schemas';
import { canonicalJson, sha256Hex } from '@caseguard/security';
import { NotAnalysedError } from '../../errors';
import type { RequestContext } from '../../http/request-context';
import { engineContextForRun, loadAnalysisInputs, type AnalysisInputs } from '../analysis';
import { LruCache } from './cache';

/**
 * A stored analysis brought back to life: the case record and the engine context of the run that
 * produced it, plus the full deterministic analysis recomputed from the immutable record. The engine
 * is deterministic, so every id matches what was stored; counterfactual generation, hindsight, skill
 * extraction and replays all need the in-memory analysis the snapshot does not keep.
 */
export interface CaseReplay {
  readonly run: AnalysisRun;
  readonly inputs: AnalysisInputs;
  readonly engineCtx: EngineContext;
  /** The post-hoc analysis of the whole record. Read-only: never mutate it. */
  readonly analysis: DeterministicAnalysis;
}

/**
 * Analyses kept in memory. One skill application walks the case itself, the case the skill came from
 * and up to `MAX_USAGE_CASES - 1` earlier applications (so `MAX_USAGE_CASES + 1` cases), in the same
 * order every time. A least-recently-used cache that is smaller than such a walk misses on every step
 * of it, so it must hold at least the walk and a little more (`skills-application.test.ts` pins the
 * relation). It is bounded by entries, not bytes: a very large case takes a lot of memory.
 */
export const REPLAY_CACHE_ENTRIES = 12;

/**
 * Loads replays and keeps the few most recent analyses (the expensive part). The cache key names the
 * tenant, case, run and the governed action-value configuration, so a changed configuration or a
 * new run never reuses a stale analysis.
 */
export class ReplayLoader {
  private readonly analyses = new LruCache<DeterministicAnalysis>(REPLAY_CACHE_ENTRIES);
  private enginePasses = 0;

  /** How many times the engine really ran for a replay (a cache hit does not count). */
  get passes(): number {
    return this.enginePasses;
  }

  /**
   * 404 when the case does not exist for the caller's tenant, 422 for an unsupported workload and
   * 409 when the case has not been analysed yet.
   */
  async load(ctx: RequestContext, caseId: string): Promise<CaseReplay> {
    const inputs = await loadAnalysisInputs(ctx, caseId);
    const run = await ctx.repos.analysis.getLatestRun(caseId);
    if (run === null) {
      throw new NotAnalysedError('The case has not been analysed yet. Run the analysis first.');
    }
    const engineCtx = engineContextForRun(run, inputs);
    const key = [
      ctx.scope.tenantId,
      caseId,
      run.id,
      sha256Hex(canonicalJson(inputs.actionConfig)).slice(0, 16),
    ].join('|');
    const nowMs = ctx.now().getTime();
    let analysis = this.analyses.get(key, nowMs);
    if (analysis === undefined) {
      this.enginePasses += 1;
      analysis = runDeterministicAnalysis({
        view: createFullView(inputs.events, inputs.resolution),
        pack: inputs.pack,
        config: inputs.actionConfig,
        ctx: engineCtx,
      });
      this.analyses.set(key, analysis, nowMs);
    }
    return { run, inputs, engineCtx, analysis };
  }
}
