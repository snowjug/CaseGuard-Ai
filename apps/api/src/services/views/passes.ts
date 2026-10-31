import {
  createTemporalView,
  runDeterministicAnalysis,
  type AnalysisInput,
  type DeterministicAnalysis,
  type EngineContext,
  type TemporalView,
} from '@caseguard/domain';
import type { ActionRanking, AnalysisRun } from '@caseguard/schemas';
import { canonicalJson, sha256Hex } from '@caseguard/security';
import { engineContextForRun, type AnalysisInputs } from '../analysis/inputs';
import { LruCache } from './lru';

/*
 * One engine pass serves every instant of the same window. What a pass depends on is the set of
 * visible events and whether the resolution is visible, never the exact instant, so two requests
 * whose boundaries lie between the same two events (or are one instant spelled two ways) share it.
 * Passes are the memory-heavy part of a recomputation, so the cache that holds them is bounded by an
 * estimate of what they retain, not only by how many there are.
 *
 * Only work somebody was allowed to start is cached. A window enters the cache when a request that
 * has been charged (or runs unmetered) asks for its pass or builds a ranking in it, never before, so
 * the requests the engine budget refuses leave nothing behind and cannot evict a pass another user
 * paid for, by weight or by count.
 */

/**
 * Estimated memory one pass retains, per visible event: the artefacts (claims, evidence, links, the
 * belief timeline, actions, forks) grow with the events. Measured on the synthetic cases and on
 * scaled copies of up to 2,000 events it is 12 to 45 KiB of JSON per event, so the estimate rounds up.
 */
export const PASS_BYTES_PER_EVENT = 48 * 1024;
export const PASS_BASE_BYTES = 64 * 1024;

/**
 * What the pass cache may hold, in estimated bytes. It keeps about three complete sequential scans of
 * the 31 prefixes of a 31-event case (a time scrubber walking the whole record, roughly 26 MiB each)
 * and, for the largest case the data tier accepts (2,000 events, about 94 MiB for one pass), the most
 * recent pass alone. The newest pass is never evicted by its own weight.
 */
export const PASS_CACHE_BYTES = 96 * 1024 * 1024;
/** A bound on bookkeeping when passes are small (a few events each). */
export const PASS_CACHE_ENTRIES = 256;

export const estimatePassBytes = (visibleEvents: number): number =>
  PASS_BASE_BYTES + PASS_BYTES_PER_EVENT * visibleEvents;

/** The part of an action ranking that does not depend on reviewer overrides. */
export type RankingCore = Pick<ActionRanking, 'posterior' | 'candidates' | 'blocked'>;

/** Everything one window of one run shares, whoever asks and whichever instant inside it. */
export class PassEntry {
  /** Started at most once per entry and cleared again when the engine fails, so a retry can run. */
  analysis: Promise<DeterministicAnalysis> | undefined;
  /** Action rankings, which depend on the visible events alone (a decision moment is keyed by fork). */
  readonly rankings = new Map<string, RankingCore>();

  constructor(readonly estimatedBytes: number) {}
}

export interface PassCacheStats {
  /** Engine passes that actually ran (or are running). */
  readonly coldPasses: number;
  /** Requests for an analysis that found a pass already cached or running. */
  readonly reused: number;
  readonly entries: number;
  readonly estimatedBytes: number;
}

export interface PassCacheOptions {
  readonly maxBytes?: number;
  readonly maxEntries?: number;
  /** The engine pass; tests inject a counter. */
  readonly analyse?: (input: AnalysisInput) => DeterministicAnalysis;
}

/** Each engine pass is synchronous: let queued I/O run first so a heavy case cannot starve requests. */
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export class PassCache {
  private readonly entries: LruCache<string, PassEntry>;
  private readonly analyse: (input: AnalysisInput) => DeterministicAnalysis;
  private cold = 0;
  private hits = 0;

  constructor(options: PassCacheOptions = {}) {
    this.entries = new LruCache(options.maxEntries ?? PASS_CACHE_ENTRIES, {
      maxWeight: options.maxBytes ?? PASS_CACHE_BYTES,
      weigh: (entry) => entry.estimatedBytes,
    });
    this.analyse = options.analyse ?? runDeterministicAnalysis;
  }

  get stats(): PassCacheStats {
    return {
      coldPasses: this.cold,
      reused: this.hits,
      entries: this.entries.size,
      estimatedBytes: this.entries.weight,
    };
  }

  /**
   * What is cached for a window, if anything. Reading never creates an entry: a window enters the cache
   * only once a request that is allowed to work on it asks for it (`acquire`, `analysis`), so a request
   * the engine budget refuses can neither fill the cache nor push out passes somebody paid for.
   */
  peek(key: string): PassEntry | undefined {
    return this.entries.get(key);
  }

  /**
   * The cached state of a window, created and weighed in full on first use. Only for a caller that is
   * allowed to work on the window (it has been charged, or the work is unmetered): inserting is what
   * evicts the stalest entries.
   */
  acquire(key: string, visibleEvents: number): PassEntry {
    let found = this.entries.get(key);
    if (found === undefined) {
      found = new PassEntry(estimatePassBytes(visibleEvents));
      this.entries.set(key, found);
    }
    return found;
  }

  /**
   * The engine pass of a window. A cached or running pass is returned as it is; otherwise
   * `beforeStart` runs first (it is where a caller is charged, and it may refuse by throwing, before
   * any engine work is done and with nothing cached for the window) and the pass starts on the input
   * `makeInput` builds, which is only built then. Concurrent requests for one window share one run.
   */
  analysis(
    key: string,
    visibleEvents: number,
    makeInput: () => AnalysisInput,
    beforeStart: () => void,
  ): Promise<DeterministicAnalysis> {
    const cached = this.entries.get(key);
    if (cached?.analysis !== undefined) {
      this.hits += 1;
      return cached.analysis;
    }
    beforeStart();
    const entry = cached ?? this.acquire(key, visibleEvents);
    this.cold += 1;
    const started = yieldToEventLoop().then(() => this.analyse(makeInput()));
    entry.analysis = started;
    started.catch(() => {
      if (entry.analysis !== started) return;
      // A retry can run. A window left with nothing but a weight for a pass that does not exist is
      // dropped; a ranking built for it meanwhile keeps it.
      entry.analysis = undefined;
      if (entry.rankings.size === 0 && this.entries.get(key) === entry) this.entries.delete(key);
    });
    return started;
  }
}

/** The earliest event instant of the record, or null for an empty one. */
function firstInstant(inputs: AnalysisInputs): number | null {
  let first: number | null = null;
  for (const event of inputs.events) {
    const at = Date.parse(event.timestamp);
    if (first === null || at < first) first = at;
  }
  return first;
}

/**
 * The view a pass is computed on: the same events and resolution as the requested view, with the
 * boundary pulled back to the latest instant they can see. Every boundary of one window thus runs the
 * identical analysis, whichever was asked first.
 */
export function passView(inputs: AnalysisInputs, view: TemporalView): TemporalView {
  const instants = view.events.map((event) => Date.parse(event.timestamp));
  if (view.resolution !== null) instants.push(Date.parse(view.resolution.resolvedAt));
  let boundary: number;
  if (instants.length > 0) {
    boundary = Math.max(...instants);
  } else {
    // Nothing is visible yet: one millisecond before the first event hides every event.
    const first = firstInstant(inputs);
    boundary = first === null ? 0 : first - 1;
  }
  return createTemporalView(inputs.events, new Date(boundary).toISOString(), {
    resolution: inputs.resolution,
  });
}

/** True when the view holds the whole record: every event, and the resolution if there is one. */
export const coversWholeRecord = (inputs: AnalysisInputs, view: TemporalView): boolean =>
  view.withheldFutureEventCount === 0 && (inputs.resolution === null || view.resolution !== null);

/**
 * What a pass depends on besides the run: both governed configurations, the unit prices and the pack.
 * Governance may change them after an analysis, so they are part of every cache key.
 */
export function inputsFingerprint(inputs: AnalysisInputs): string {
  return sha256Hex(
    canonicalJson({
      action: inputs.actionConfig,
      quality: inputs.qualityConfig,
      prices: inputs.unitPrices,
      pack: [inputs.pack.pack.id, inputs.pack.pack.version],
    }),
  ).slice(0, 16);
}

/** Identifies a window: the run, the configuration and exactly which events and resolution are visible. */
export function passKey(run: AnalysisRun, view: TemporalView, fingerprint: string): string {
  return [
    run.tenantId,
    run.id,
    fingerprint,
    view.fingerprint,
    view.resolution === null ? 'open' : 'resolved',
    view.withheldFutureEventCount,
  ].join('|');
}

/**
 * The identity a pass runs under. Artefact ids and timestamps come from the stored run, so they equal
 * the stored ones. The seed of the confidence bands is the case's simulation seed only when the view
 * is the whole record, which is exactly what the stored run analysed. A window must not be seeded by a
 * hash of the whole stored source (it would change with text recorded after the window), so it gets a
 * seed derived from the pack and the visible events alone. Like the stored seed it names content only:
 * no generated id (case, run, tenant) and no engine version, so the same window of the same content
 * draws the same bands in any database.
 */
export function passContext(
  run: AnalysisRun,
  inputs: AnalysisInputs,
  view: TemporalView,
): EngineContext {
  const stored = engineContextForRun(run, inputs);
  if (coversWholeRecord(inputs, view)) return stored;
  return {
    ...stored,
    seed: sha256Hex(
      canonicalJson({
        pack: [inputs.pack.pack.id, inputs.pack.pack.version],
        events: view.fingerprint,
        resolved: view.resolution !== null,
      }),
    ),
  };
}
