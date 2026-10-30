import {
  buildMetricEstimates,
  computeAvoidableEffort,
  computeEfficiency,
  computeQualityReview,
  createFullView,
  createTemporalView,
  replayWarnings,
  type AnalysisInput,
  type DeterministicAnalysis,
  type EngineContext,
  type TemporalView,
  type WarningDismissal,
  type WarningReplay,
} from '@caseguard/domain';
import type { AnalysisRun, CaseEvent, MetricEstimate, QualityAssessment } from '@caseguard/schemas';
import type { AnalysisInputs } from '../analysis/inputs';
import type { EngineBudget, EngineBudgetCaller } from '../engine-budget';
import { canonicalInstant } from './instants';
import { LruCache } from './lru';
import {
  PassCache,
  inputsFingerprint,
  passContext,
  passKey,
  passView,
  type PassCacheOptions,
  type RankingCore,
} from './passes';
import { requireRun, type ViewState } from './state';

export type { RankingCore } from './passes';

/**
 * Boundaries kept warm. A boundary holds only the small results that depend on the exact instant
 * (quality, metrics, warning replays), never events or a pass, so a larger LRU than the pass cache's
 * is cheap: a few tens of KiB each.
 */
export const VIEW_BOUNDARY_CAPACITY = 128;

/** What is memoised for one boundary (one instant of one run), shared by everyone who asks for it. */
class BoundaryMemo {
  quality: QualityAssessment | undefined;
  metrics: MetricEstimate[] | undefined;
  readonly warnings = new Map<string, WarningReplay>();
  /** True once some request has paid the engine budget for cold work at this boundary. */
  paid = false;
}

/**
 * One boundary's place in the shared cache. A memo is looked up (`peek`) and only created and cached
 * (`acquire`) by a request that has been allowed to work, so a refused request leaves nothing behind.
 */
interface BoundarySlot {
  peek(): BoundaryMemo | undefined;
  acquire(): BoundaryMemo;
}

/**
 * One request's view of one temporal boundary of a case, computed lazily. `asOf: null` is the whole
 * record (exactly the stored analysis: same context, so the same artefact ids and bands); an instant is
 * the engine run on only what was known then. Nothing here is a filtered copy of the final analysis, so
 * no later event can reach a response through it.
 *
 * COST. The expensive engine pass is shared by every boundary of the same window (see `passes.ts`).
 * The results that depend on the exact instant (quality, metrics, the warning replay, a ranking) are
 * memoised per boundary. Only cold work is charged to the engine budget, and a request is charged at
 * most once: a cold pass always costs a unit; the per-instant work costs one when nobody has paid for
 * this boundary yet. So a fresh instant costs one unit however many views of it are asked for, and a
 * flood of instants one millisecond apart is bounded by the budget like any other. Nothing is cached
 * before the charge succeeds: a request that is refused (a 429) neither fills the caches nor evicts
 * what somebody else paid for.
 */
export class ViewComputation {
  readonly view: TemporalView;
  readonly engineCtx: EngineContext;
  /** Identifies this window in the pass cache; nothing is cached under it until work is allowed. */
  private readonly windowKey: string;
  private analysisMemo: Promise<DeterministicAnalysis> | undefined;
  private charged = false;

  constructor(
    readonly inputs: AnalysisInputs,
    readonly run: AnalysisRun,
    /** The boundary as the client wrote it, for echoing; null is the whole record. */
    readonly asOf: string | null,
    private readonly boundary: BoundarySlot,
    private readonly passes: PassCache,
    private readonly fingerprint: string,
    private readonly charge: (() => void) | undefined,
  ) {
    this.view =
      asOf === null
        ? createFullView(inputs.events, inputs.resolution)
        : createTemporalView(inputs.events, canonicalInstant(asOf), {
            resolution: inputs.resolution,
          });
    this.engineCtx = passContext(run, inputs, this.view);
    this.windowKey = passKey(run, this.view, fingerprint);
  }

  /** The events inside the boundary, in record order. */
  get events(): readonly CaseEvent[] {
    return this.view.events;
  }

  /** How many later events the boundary withheld (their content never reaches the computation). */
  get withheldFutureEventCount(): number {
    return this.view.withheldFutureEventCount;
  }

  /**
   * Spends this request's one unit of the engine budget on the first cold computation it needs. A pass
   * (`'pass'`) is always charged; per-instant work (`'instant'`) is free when someone has already paid
   * for this boundary. Whoever pays marks the boundary paid. It throws, before any work, when the
   * budget is empty.
   */
  private chargeOnce(scope: 'pass' | 'instant'): void {
    if (this.charged || (scope === 'instant' && this.boundary.peek()?.paid === true)) return;
    this.charge?.();
    this.charged = true;
    this.boundary.acquire().paid = true;
  }

  /**
   * The analysis of this boundary: the window's shared pass, carrying the exact boundary view. It
   * always answers with a promise, also when the engine budget refuses (a 429) before any work starts.
   */
  async analysis(): Promise<DeterministicAnalysis> {
    if (this.analysisMemo === undefined) {
      // The pass runs on the window's own boundary view, which is only built if the pass is cold.
      const makeInput = (): AnalysisInput => ({
        view: passView(this.inputs, this.view),
        pack: this.inputs.pack,
        config: this.inputs.actionConfig,
        ctx: this.engineCtx,
      });
      this.analysisMemo = this.passes
        .analysis(this.windowKey, this.view.events.length, makeInput, () => this.chargeOnce('pass'))
        .then((pass) => ({ ...pass, view: this.view }));
    }
    return this.analysisMemo;
  }

  /** The Case Quality Index of this boundary, scored on its own analysis. */
  async quality(): Promise<QualityAssessment> {
    const memo = await this.canonicalQuality();
    // The memo is shared by every spelling of the instant, so the echo is this request's own.
    return memo.asOf === this.asOf ? memo : { ...memo, asOf: this.asOf };
  }

  private async canonicalQuality(): Promise<QualityAssessment> {
    const analysis = await this.analysis();
    const cached = this.boundary.peek()?.quality;
    if (cached !== undefined) return cached;
    const { inputs } = this;
    this.chargeOnce('instant');
    const quality = computeQualityReview({
      analysis,
      pack: inputs.pack,
      ctx: this.engineCtx,
      config: inputs.qualityConfig,
      actionConfig: inputs.actionConfig,
      asOf: this.asOf === null ? null : canonicalInstant(this.asOf),
    });
    this.boundary.acquire().quality = quality;
    return quality;
  }

  /**
   * Metric estimates of this boundary. No counterfactual scenario is passed: a scenario compares itself
   * with the whole real path, which an as-of window must not see, so Avoidable Support Effort reports
   * honestly that it cannot be estimated here.
   */
  async metrics(): Promise<MetricEstimate[]> {
    const analysis = await this.analysis();
    const review = await this.canonicalQuality();
    const cached = this.boundary.peek()?.metrics;
    if (cached !== undefined) return cached;
    const { inputs } = this;
    this.chargeOnce('instant');
    const avoidable = computeAvoidableEffort({ analysis, pack: inputs.pack, scenarios: [] });
    const efficiency = computeEfficiency({
      analysis,
      pack: inputs.pack,
      caseId: inputs.caseRecord.id,
      synthetic: inputs.caseRecord.synthetic,
      unitPrices: inputs.unitPrices,
      avoidable,
    });
    const metrics = buildMetricEstimates({
      analysis,
      pack: inputs.pack,
      ctx: this.engineCtx,
      review,
      avoidable,
      efficiency,
      synthetic: inputs.caseRecord.synthetic,
      actionConfig: inputs.actionConfig,
    });
    this.boundary.acquire().metrics = metrics;
    return metrics;
  }

  /**
   * The live-warning replay over this boundary's own analysis. Dismissals made at or before the
   * boundary continue the lifecycle; later ones are not yet known and are ignored by the replay. The
   * replay re-evaluates the rules at every event, which costs about as much as a pass.
   */
  async warnings(dismissals: readonly WarningDismissal[]): Promise<WarningReplay> {
    const boundary = this.asOf === null ? Number.POSITIVE_INFINITY : Date.parse(this.asOf);
    const relevant = dismissals.filter((d) => Date.parse(d.at) <= boundary);
    const key = relevant
      .map((d) => `${d.dedupeKey}@${d.at}`)
      .sort()
      .join('|');
    const cached = this.boundary.peek()?.warnings.get(key);
    if (cached !== undefined) return cached;

    this.chargeOnce('instant');
    const analysis = await this.analysis();
    const { inputs } = this;
    const replay = replayWarnings({
      events: inputs.events,
      resolution: inputs.resolution,
      pack: inputs.pack,
      ctx: this.engineCtx,
      config: inputs.actionConfig,
      ...(this.asOf === null ? {} : { asOf: canonicalInstant(this.asOf) }),
      analysis,
      dismissals: relevant,
    });
    this.boundary.acquire().warnings.set(key, replay);
    return replay;
  }

  /**
   * Memoises an action ranking built for this window (or for a decision moment inside it). A ranking
   * depends on the visible events alone, so every boundary of the window shares it; building one
   * re-reads those events, so a cold one is charged like other per-instant work.
   */
  rankingFor(key: string, build: () => RankingCore): RankingCore {
    const cached = this.passes.peek(this.windowKey)?.rankings.get(key);
    if (cached !== undefined) return cached;
    this.chargeOnce('instant');
    const built = build();
    this.passes.acquire(this.windowKey, this.view.events.length).rankings.set(key, built);
    return built;
  }
}

export interface ViewCacheOptions {
  /** Charged for cold work (see `ViewComputation`); omit to leave recomputation unmetered (unit tests). */
  readonly budget?: EngineBudget;
  readonly passes?: PassCacheOptions;
  /** Boundaries kept warm (default VIEW_BOUNDARY_CAPACITY). */
  readonly boundaries?: number;
}

/**
 * The per-process caches behind recomputed views: engine passes (heavy, one per window of a run,
 * bounded by an estimate of their size) and the small per-instant results (quality, metrics, warning
 * replays), plus the engine budget that meters cold work per caller.
 */
export class ViewCache {
  readonly passes: PassCache;
  private readonly boundaries: LruCache<string, BoundaryMemo>;
  private readonly budget: EngineBudget | undefined;

  constructor(options: ViewCacheOptions = {}) {
    this.passes = new PassCache(options.passes);
    this.boundaries = new LruCache(options.boundaries ?? VIEW_BOUNDARY_CAPACITY);
    this.budget = options.budget;
  }

  get size(): number {
    return this.boundaries.size;
  }

  /**
   * The computation of a boundary for one request. Every spelling of one instant, and every instant of
   * one window, resolves to the same cached pass; `caller` is charged only if that pass, or the warning
   * replay of this exact instant, has to be computed cold. Creating a computation caches nothing: the
   * window and the boundary are cached by the first work the request is allowed to do.
   */
  computation(
    caller: EngineBudgetCaller,
    inputs: AnalysisInputs,
    run: AnalysisRun,
    asOf: string | null,
  ): ViewComputation {
    const fingerprint = inputsFingerprint(inputs);
    const instant = asOf === null ? 'full' : canonicalInstant(asOf);
    // The record's size is part of the key: events appended after a run change what "whole" means.
    const key = [
      run.tenantId,
      run.id,
      instant,
      fingerprint,
      inputs.events.length,
      inputs.resolution === null ? 0 : 1,
    ].join('|');
    const budget = this.budget;
    const boundary: BoundarySlot = {
      peek: () => this.boundaries.get(key),
      acquire: () => {
        let memo = this.boundaries.get(key);
        if (memo === undefined) {
          memo = new BoundaryMemo();
          this.boundaries.set(key, memo);
        }
        return memo;
      },
    };
    return new ViewComputation(
      inputs,
      run,
      asOf,
      boundary,
      this.passes,
      fingerprint,
      budget === undefined ? undefined : () => budget.charge(caller),
    );
  }
}

/** What every view service shares: the process-wide caches of recomputed views. */
export interface ViewDeps {
  readonly cache: ViewCache;
}

/** The computation of the requested boundary; 409 when the case has never been analysed. */
export function computationFor(
  caller: EngineBudgetCaller,
  deps: ViewDeps,
  state: ViewState,
  asOf: string | null,
): ViewComputation {
  return deps.cache.computation(caller, state.inputs, requireRun(state), asOf);
}
