import {
  buildMetricEstimates,
  computeAvoidableEffort,
  computeEfficiency,
  computeQualityReview,
  createFullView,
  createTemporalView,
  replayWarnings,
  runDeterministicAnalysis,
  type DeterministicAnalysis,
  type EngineContext,
  type TemporalView,
  type WarningDismissal,
  type WarningReplay,
} from '@caseguard/domain';
import type {
  ActionRanking,
  AnalysisRun,
  CaseEvent,
  MetricEstimate,
  QualityAssessment,
} from '@caseguard/schemas';
import { canonicalJson, sha256Hex } from '@caseguard/security';
import { engineContextForRun, type AnalysisInputs } from '../analysis/inputs';
import { LruCache } from './lru';
import { requireRun, type ViewState } from './state';

/** About sixteen recomputed views stay warm: a time scrubber revisits a handful of instants. */
export const VIEW_CACHE_CAPACITY = 16;

/** The part of an action ranking that does not depend on reviewer overrides. */
export type RankingCore = Pick<ActionRanking, 'posterior' | 'candidates' | 'blocked'>;

/** Each engine pass is synchronous: let queued I/O run first so a heavy case cannot starve requests. */
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * One analysis of one temporal view of a case, computed lazily and at most once. `asOf: null` is the
 * whole record (exactly the stored analysis: same context, so the same artefact ids); an instant is
 * the engine run on only what was known then. Nothing here is ever a filtered copy of the final
 * analysis, so no later event can reach a response through it.
 */
export class ViewComputation {
  readonly view: TemporalView;
  readonly engineCtx: EngineContext;
  private analysisMemo: DeterministicAnalysis | undefined;
  private qualityMemo: QualityAssessment | undefined;
  private metricsMemo: MetricEstimate[] | undefined;
  private readonly warningMemo = new Map<string, WarningReplay>();
  private readonly rankingMemo = new Map<string, RankingCore>();

  constructor(
    readonly inputs: AnalysisInputs,
    readonly run: AnalysisRun,
    readonly asOf: string | null,
  ) {
    this.engineCtx = engineContextForRun(run);
    this.view =
      asOf === null
        ? createFullView(inputs.events, inputs.resolution)
        : createTemporalView(inputs.events, asOf, { resolution: inputs.resolution });
  }

  /** The events inside the boundary, in record order. */
  get events(): readonly CaseEvent[] {
    return this.view.events;
  }

  /** How many later events the boundary withheld (their content never reaches the computation). */
  get withheldFutureEventCount(): number {
    return this.view.withheldFutureEventCount;
  }

  async analysis(): Promise<DeterministicAnalysis> {
    if (this.analysisMemo === undefined) {
      await yieldToEventLoop();
      this.analysisMemo ??= runDeterministicAnalysis({
        view: this.view,
        pack: this.inputs.pack,
        config: this.inputs.actionConfig,
        ctx: this.engineCtx,
      });
    }
    return this.analysisMemo;
  }

  /** The Case Quality Index of this view, scored on the view's own analysis. */
  async quality(): Promise<QualityAssessment> {
    const analysis = await this.analysis();
    this.qualityMemo ??= computeQualityReview({
      analysis,
      pack: this.inputs.pack,
      ctx: this.engineCtx,
      config: this.inputs.qualityConfig,
      actionConfig: this.inputs.actionConfig,
      asOf: this.asOf,
    });
    return this.qualityMemo;
  }

  /**
   * Metric estimates of this view. No counterfactual scenario is passed: a scenario compares itself
   * with the whole real path, which an as-of window must not see, so Avoidable Support Effort reports
   * honestly that it cannot be estimated here.
   */
  async metrics(): Promise<MetricEstimate[]> {
    const analysis = await this.analysis();
    const review = await this.quality();
    const { inputs } = this;
    if (this.metricsMemo === undefined) {
      const avoidable = computeAvoidableEffort({ analysis, pack: inputs.pack, scenarios: [] });
      const efficiency = computeEfficiency({
        analysis,
        pack: inputs.pack,
        caseId: inputs.caseRecord.id,
        synthetic: inputs.caseRecord.synthetic,
        unitPrices: inputs.unitPrices,
        avoidable,
      });
      this.metricsMemo = buildMetricEstimates({
        analysis,
        pack: inputs.pack,
        ctx: this.engineCtx,
        review,
        avoidable,
        efficiency,
        synthetic: inputs.caseRecord.synthetic,
        actionConfig: inputs.actionConfig,
      });
    }
    return this.metricsMemo;
  }

  /**
   * The live-warning replay over this view's own analysis. Dismissals made at or before the boundary
   * continue the lifecycle; later ones are not yet known and are ignored by the replay itself.
   */
  async warnings(dismissals: readonly WarningDismissal[]): Promise<WarningReplay> {
    const boundary = this.asOf === null ? Number.POSITIVE_INFINITY : Date.parse(this.asOf);
    const relevant = dismissals.filter((d) => Date.parse(d.at) <= boundary);
    const key = relevant
      .map((d) => `${d.dedupeKey}@${d.at}`)
      .sort()
      .join('|');
    const cached = this.warningMemo.get(key);
    if (cached !== undefined) return cached;

    const analysis = await this.analysis();
    const replay = replayWarnings({
      events: this.inputs.events,
      resolution: this.inputs.resolution,
      pack: this.inputs.pack,
      ctx: this.engineCtx,
      config: this.inputs.actionConfig,
      ...(this.asOf === null ? {} : { asOf: this.asOf }),
      analysis,
      dismissals: relevant,
    });
    this.warningMemo.set(key, replay);
    return replay;
  }

  /** Memoises an action ranking built for this view (or for a decision moment inside it). */
  rankingFor(key: string, build: () => RankingCore): RankingCore {
    const cached = this.rankingMemo.get(key);
    if (cached !== undefined) return cached;
    const built = build();
    this.rankingMemo.set(key, built);
    return built;
  }
}

/**
 * What a recomputation depends on besides the immutable record: the two governed configurations and
 * the unit prices. Governance may change them after an analysis, so they are part of the cache key.
 */
function inputsFingerprint(inputs: AnalysisInputs): string {
  return sha256Hex(
    canonicalJson({
      action: inputs.actionConfig,
      quality: inputs.qualityConfig,
      prices: inputs.unitPrices,
      pack: [inputs.pack.pack.id, inputs.pack.pack.version],
    }),
  ).slice(0, 16);
}

/** A small per-process LRU of view computations, keyed by tenant, run, boundary and configuration. */
export class ViewCache {
  private readonly entries: LruCache<string, ViewComputation>;

  constructor(capacity: number = VIEW_CACHE_CAPACITY) {
    this.entries = new LruCache(capacity);
  }

  get size(): number {
    return this.entries.size;
  }

  computation(inputs: AnalysisInputs, run: AnalysisRun, asOf: string | null): ViewComputation {
    const key = [run.tenantId, run.id, asOf ?? 'full', inputsFingerprint(inputs)].join('|');
    let found = this.entries.get(key);
    if (found === undefined) {
      found = new ViewComputation(inputs, run, asOf);
      this.entries.set(key, found);
    }
    return found;
  }
}

/** What every view service shares: the process-wide cache of recomputed views. */
export interface ViewDeps {
  readonly cache: ViewCache;
}

/** The computation of the requested boundary; 409 when the case has never been analysed. */
export function computationFor(
  deps: ViewDeps,
  state: ViewState,
  asOf: string | null,
): ViewComputation {
  return deps.cache.computation(state.inputs, requireRun(state), asOf);
}
