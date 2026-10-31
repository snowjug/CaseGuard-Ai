/*
 * The recomputation caches behind the as-of views, without a database: how many engine passes a set
 * of requests really runs, how one pass is shared by a window, what the engine budget charges, and
 * how the size-bounded cache behaves. The engine pass is a counting stand-in wherever the engine's
 * output does not matter, so the file stays fast.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createFullView,
  createTemporalView,
  getCompiledPack,
  runDeterministicAnalysis,
  type AnalysisInput,
  type DeterministicAnalysis,
} from '@caseguard/domain';
import {
  DEFAULT_ACTION_VALUE_CONFIG,
  DEFAULT_QUALITY_CONFIG,
  type AnalysisRun,
  type CaseEvent,
} from '@caseguard/schemas';
import { RateLimitedError, ValidationFailedError } from '../src/errors';
import { simulationSeed, type AnalysisInputs } from '../src/services/analysis/inputs';
import {
  ENGINE_BUDGET_PASSES,
  ENGINE_BUDGET_WINDOW_MS,
  EngineBudget,
  type EngineBudgetCaller,
} from '../src/services/engine-budget';
import { ViewCache, VIEW_BOUNDARY_CAPACITY } from '../src/services/views/computation';
import {
  PASS_CACHE_BYTES,
  PASS_CACHE_ENTRIES,
  coversWholeRecord,
  estimatePassBytes,
  passContext,
  passView,
} from '../src/services/views/passes';
import { canonicalInstant } from '../src/services/views/instants';
import { LruCache } from '../src/services/views/lru';
import { buildAnalysisRun } from './builders';
import { SAMPLE_FILES, normalizeSample } from './support/samples';

const TENANT = 'tenant_cache_unit';
const CASE = 'case_cache_unit';

let inputs: AnalysisInputs;
let events: CaseEvent[];
let real: DeterministicAnalysis;
const run: AnalysisRun = buildAnalysisRun({
  tenantId: TENANT,
  caseId: CASE,
  id: 'run_cache_unit',
  inputHash: 'hash-cache-unit',
  startedAt: '2026-10-29T00:00:00.000Z',
});

beforeAll(() => {
  const normalized = normalizeSample(SAMPLE_FILES.caseOne, { tenantId: TENANT, caseId: CASE });
  const pack = getCompiledPack(normalized.case.workload);
  if (pack === null) throw new Error('The sample workload has no knowledge pack');
  events = [...normalized.events].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  inputs = {
    caseRecord: normalized.case,
    source: normalized.source,
    events: normalized.events,
    resolution: normalized.resolution,
    pack,
    actionConfig: DEFAULT_ACTION_VALUE_CONFIG,
    qualityConfig: DEFAULT_QUALITY_CONFIG,
    skills: [],
    unitPrices: { inputPer1kUsd: null, outputPer1kUsd: null, cachedInputPer1kUsd: null },
  };
  real = runDeterministicAnalysis({
    view: createFullView(inputs.events, inputs.resolution),
    pack,
    config: DEFAULT_ACTION_VALUE_CONFIG,
    ctx: { ...passContext(run, inputs, createFullView(inputs.events, inputs.resolution)) },
  });
}, 60_000);

const at = (suffix: string): string => {
  const event = events.find((item) => item.id.endsWith(suffix));
  if (event === undefined) throw new Error(`No event ${suffix}`);
  return event.timestamp;
};
const shifted = (iso: string, ms: number): string => new Date(Date.parse(iso) + ms).toISOString();

/** A caller on a clock the test moves by hand. */
function callers(start = Date.parse('2026-06-01T00:00:00.000Z')) {
  const clock = { ms: start };
  const as = (tenantId: string, userId: string): EngineBudgetCaller => ({
    auth: { tenantId, userId },
    now: () => new Date(clock.ms),
  });
  return { clock, as };
}

/** A cache whose engine pass is a counter: it hands back one precomputed analysis, or the real engine's. */
function countingCache(
  options: {
    budget?: EngineBudget;
    maxBytes?: number;
    maxEntries?: number;
    boundaries?: number;
    engine?: 'stub' | 'real';
  } = {},
) {
  const seen: AnalysisInput[] = [];
  const cache = new ViewCache({
    ...(options.budget === undefined ? {} : { budget: options.budget }),
    ...(options.boundaries === undefined ? {} : { boundaries: options.boundaries }),
    passes: {
      analyse: (input) => {
        seen.push(input);
        return options.engine === 'real' ? runDeterministicAnalysis(input) : real;
      },
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
      ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
    },
  });
  return { cache, seen };
}

const { as: callerAs } = callers();
const anyone = callerAs('t', 'u');

describe('one engine pass per window', () => {
  it('[NFR-SEC-05] runs one pass for every spelling of one instant', async () => {
    const { cache, seen } = countingCache();
    const instant = at('e07');
    const spellings = [
      instant,
      instant.replace('Z', '.000Z'),
      instant.replace('Z', '.0000Z'),
      instant.replace('Z', '.00000Z'),
      instant.replace('Z', '.000000000Z'),
    ];
    for (const spelling of spellings) {
      await cache.computation(anyone, inputs, run, spelling).analysis();
    }
    expect(seen).toHaveLength(1);
    expect(cache.passes.stats).toMatchObject({ coldPasses: 1, reused: spellings.length - 1 });
  });

  it('[NFR-SEC-05] shares the pass between all instants strictly between two events', async () => {
    const { cache, seen } = countingCache();
    const first = at('e07');
    const next = at('e08');
    const gap = Date.parse(next) - Date.parse(first);
    expect(gap).toBeGreaterThan(2);
    const instants = [
      first,
      shifted(first, 1),
      shifted(first, 2),
      shifted(first, Math.floor(gap / 2)),
      shifted(first, gap - 1),
    ];
    const analyses: DeterministicAnalysis[] = [];
    for (const instant of instants) {
      analyses.push(await cache.computation(anyone, inputs, run, instant).analysis());
    }
    expect(seen).toHaveLength(1);
    // Each carries its own boundary view over the one shared set of artefacts.
    expect(analyses.map((analysis) => analysis.view.asOf)).toEqual(instants.map(canonicalInstant));
    expect(new Set(analyses.map((analysis) => analysis.claims)).size).toBe(1);
    expect(new Set(analyses.map((analysis) => analysis.view.events.length)).size).toBe(1);
    // The pass is computed on the window's own boundary, whichever instant asked first.
    expect(seen[0]?.view.asOf).toBe(new Date(Date.parse(first)).toISOString());

    // The next event opens a new window.
    await cache.computation(anyone, inputs, run, next).analysis();
    expect(seen).toHaveLength(2);
    expect(seen[1]?.view.events.length).toBe((seen[0]?.view.events.length ?? 0) + 1);
  });

  it('[NFR-SEC-05] separates windows exactly by their visible events and resolution', async () => {
    const { cache, seen } = countingCache();
    const last = events[events.length - 1]?.timestamp ?? '';
    const resolved = inputs.resolution?.resolvedAt ?? last;
    const instants = [
      shifted(at('e01'), -86_400_000),
      shifted(at('e01'), -1),
      shifted(at('e01'), -86_400_000 * 30),
      at('e01'),
      at('e02'),
      shifted(at('e02'), 5),
      at('e10'),
      last,
      shifted(last, 1),
      resolved,
      shifted(resolved, 1),
      '2999-01-01T00:00:00Z',
      '0001-01-01T00:00:00Z',
    ];
    for (const instant of instants)
      await cache.computation(anyone, inputs, run, instant).analysis();
    const expected = new Set(
      instants.map((instant) => {
        const view = createTemporalView(inputs.events, instant, { resolution: inputs.resolution });
        return `${view.events.length}|${view.resolution !== null}`;
      }),
    );
    expect(seen).toHaveLength(expected.size);
    // Whatever was passed in, the pass saw exactly the window's events and resolution.
    for (const input of seen) {
      const instant = instants.find(
        (candidate) =>
          createTemporalView(inputs.events, candidate, { resolution: inputs.resolution })
            .fingerprint === input.view.fingerprint,
      );
      expect(instant).toBeDefined();
    }
  });

  it('[FR-TL-06] runs the whole record on the same window as an instant after its end', async () => {
    const { cache, seen } = countingCache();
    const whole = await cache.computation(anyone, inputs, run, null).analysis();
    const late = await cache.computation(anyone, inputs, run, '2999-01-01T00:00:00Z').analysis();
    expect(seen).toHaveLength(1);
    expect(late.claims).toBe(whole.claims);
  });

  it('[NFR-SEC-05] never shares a pass between runs, tenants or governed configurations', async () => {
    const { cache, seen } = countingCache();
    const instant = at('e07');
    await cache.computation(anyone, inputs, run, instant).analysis();
    await cache
      .computation(anyone, inputs, buildAnalysisRun({ ...run, id: 'run_cache_unit_2' }), instant)
      .analysis();
    await cache
      .computation(anyone, inputs, buildAnalysisRun({ ...run, tenantId: 'tenant_other' }), instant)
      .analysis();
    const changed: AnalysisInputs = {
      ...inputs,
      actionConfig: { ...inputs.actionConfig, version: '9.9.9' },
    };
    await cache.computation(anyone, changed, run, instant).analysis();
    expect(seen).toHaveLength(4);
    await cache.computation(anyone, inputs, run, instant).analysis();
    expect(seen).toHaveLength(4);
  });

  it('[NFR-SEC-05] shares one running pass between concurrent requests and charges only the first', async () => {
    const { as } = callers();
    const budget = new EngineBudget({ passes: 5, windowMs: 60_000 });
    const { cache, seen } = countingCache({ budget });
    const first = as('t', 'first');
    const second = as('t', 'second');
    const instant = at('e07');
    await Promise.all([
      cache.computation(first, inputs, run, instant).analysis(),
      cache.computation(second, inputs, run, shifted(instant, 5)).analysis(),
      cache.computation(second, inputs, run, instant.replace('Z', '.000Z')).analysis(),
    ]);
    expect(seen).toHaveLength(1);
    expect(budget.remaining(first)).toBe(4);
    expect(budget.remaining(second)).toBe(5);
  });

  it('[NFR-SEC-05] lets a failed pass run again, charging the new attempt', async () => {
    const { as } = callers();
    const budget = new EngineBudget({ passes: 5, windowMs: 60_000 });
    let attempts = 0;
    const cache = new ViewCache({
      budget,
      passes: {
        analyse: () => {
          attempts += 1;
          if (attempts === 1) throw new Error('engine failure');
          return real;
        },
      },
    });
    const ava = as('t', 'ava');
    const instant = at('e07');
    await expect(cache.computation(ava, inputs, run, instant).analysis()).rejects.toThrow(
      'engine failure',
    );
    await cache.computation(ava, inputs, run, instant).analysis();
    expect(attempts).toBe(2);
    expect(budget.remaining(ava)).toBe(3);
    await cache.computation(ava, inputs, run, instant).analysis();
    expect(attempts).toBe(2);
  });
});

describe('the engine budget on recomputation', () => {
  it('[NFR-SEC-05] charges cold windows only, refuses before any engine work, and serves cached ones free', async () => {
    const { clock, as } = callers();
    const budget = new EngineBudget({ passes: 3, windowMs: 60_000 });
    const { cache, seen } = countingCache({ budget });
    const ava = as('t', 'ava');
    const windows = ['e03', 'e04', 'e05', 'e06'].map(at);

    for (const instant of windows.slice(0, 3)) {
      await cache.computation(ava, inputs, run, instant).analysis();
    }
    expect(seen).toHaveLength(3);
    expect(budget.remaining(ava)).toBe(0);

    // A fourth window is refused with a 429 and no pass runs.
    await expect(cache.computation(ava, inputs, run, windows[3] ?? '').analysis()).rejects.toThrow(
      RateLimitedError,
    );
    expect(seen).toHaveLength(3);
    expect(cache.passes.stats.coldPasses).toBe(3);

    // Cached windows, in any spelling and at any instant inside them, stay free.
    for (const instant of windows.slice(0, 3)) {
      await cache.computation(ava, inputs, run, instant.replace('Z', '.000Z')).analysis();
      await cache.computation(ava, inputs, run, shifted(instant, 1)).analysis();
    }
    expect(seen).toHaveLength(3);
    expect(budget.remaining(ava)).toBe(0);

    // The refusal told the caller how long to wait, and after the window the bucket has refilled.
    const refusal = await cache
      .computation(ava, inputs, run, windows[3] ?? '')
      .analysis()
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(RateLimitedError);
    if (refusal instanceof RateLimitedError) expect(refusal.retryAfterSeconds).toBe(20);
    clock.ms += 60_000;
    await cache.computation(ava, inputs, run, windows[3] ?? '').analysis();
    expect(seen).toHaveLength(4);
    expect(budget.remaining(ava)).toBe(2);
  });

  it('[NFR-SEC-05] keeps the budget per user and per tenant, not per case or per cache', async () => {
    const { as } = callers();
    const budget = new EngineBudget({ passes: 1, windowMs: 60_000 });
    const { cache } = countingCache({ budget });
    const windows = ['e03', 'e04', 'e05', 'e06', 'e07'].map(at);
    await cache.computation(as('t', 'ava'), inputs, run, windows[0] ?? '').analysis();
    await expect(
      cache.computation(as('t', 'ava'), inputs, run, windows[1] ?? '').analysis(),
    ).rejects.toThrow(RateLimitedError);
    // Another user, and the same user id in another tenant, have their own bucket.
    await cache.computation(as('t', 'riley'), inputs, run, windows[1] ?? '').analysis();
    await cache.computation(as('other', 'ava'), inputs, run, windows[2] ?? '').analysis();
    // A window another user already paid for is free for everybody.
    await cache.computation(as('t', 'ava'), inputs, run, windows[1] ?? '').analysis();
  });

  it('[NFR-SEC-05] takes one unit per request however many cold computations it needs', async () => {
    const { as } = callers();
    const budget = new EngineBudget({ passes: 10, windowMs: 60_000 });
    const { cache } = countingCache({ budget, engine: 'real' });
    const ava = as('t', 'ava');
    const computation = cache.computation(ava, inputs, run, at('e07'));
    // A cold pass, the warning replay of this instant and a cold ranking: one request, one unit.
    await computation.analysis();
    await computation.warnings([]);
    computation.rankingFor('at', () => ({ posterior: [], candidates: [], blocked: [] }));
    expect(budget.remaining(ava)).toBe(9);
    // Everything is cached now, so the same request again is free.
    const again = cache.computation(ava, inputs, run, at('e07'));
    await again.analysis();
    await again.warnings([]);
    again.rankingFor('at', () => {
      throw new Error('a cached ranking is never rebuilt');
    });
    expect(budget.remaining(ava)).toBe(9);
  });

  it('[NFR-SEC-05] charges the per-instant work of a fresh instant once, even when the pass is cached', async () => {
    const { as } = callers();
    const budget = new EngineBudget({ passes: 10, windowMs: 60_000 });
    const { cache } = countingCache({ budget, engine: 'real' });
    const instant = at('e07');
    await cache.computation(as('t', 'warm'), inputs, run, instant).analysis();
    expect(budget.remaining(as('t', 'warm'))).toBe(9);

    // A fresh instant in the same window: the pass is free, the first cold per-instant work pays...
    const ava = as('t', 'ava');
    const next = cache.computation(ava, inputs, run, shifted(instant, 7));
    await next.analysis();
    expect(budget.remaining(ava)).toBe(10);
    await next.warnings([]);
    expect(budget.remaining(ava)).toBe(9);
    // ...and the rest of that instant is paid for: quality, metrics and a ranking cost nothing more,
    // for this request and for everybody else who asks for it.
    await next.quality();
    await next.metrics();
    next.rankingFor('at', () => ({ posterior: [], candidates: [], blocked: [] }));
    expect(budget.remaining(ava)).toBe(9);
    const bob = as('t', 'bob');
    const same = cache.computation(bob, inputs, run, shifted(instant, 7).replace('Z', '0Z'));
    await same.quality();
    await same.warnings([]);
    expect(budget.remaining(bob)).toBe(10);

    // A ranking belongs to the window, so a third instant of it finds the ranking built and pays only
    // for what is its own.
    const third = cache.computation(bob, inputs, run, shifted(instant, 3_000));
    third.rankingFor('at', () => {
      throw new Error('the window already has its ranking');
    });
    expect(budget.remaining(bob)).toBe(10);
    await third.quality();
    expect(budget.remaining(bob)).toBe(9);
  });

  it('[NFR-SEC-05] bounds a flood of instants one millisecond apart, though they share one pass', async () => {
    const { as } = callers();
    const budget = new EngineBudget({ passes: 3, windowMs: 60_000 });
    const { cache, seen } = countingCache({ budget, engine: 'real' });
    const attacker = as('t', 'attacker');
    const instant = at('e07');
    const quality = async (offset: number) =>
      cache.computation(attacker, inputs, run, shifted(instant, offset)).quality();
    // The first instant starts the pass (one unit); the next two pay for their own quality; then the
    // allowance is gone, however cheap the work would have been.
    await quality(0);
    await quality(1);
    await quality(2);
    expect(seen).toHaveLength(1);
    await expect(quality(3)).rejects.toThrow(RateLimitedError);
    await expect(quality(4)).rejects.toThrow(RateLimitedError);
    expect(seen).toHaveLength(1);
    // What has been computed stays free in every spelling.
    await quality(1);
    await cache
      .computation(attacker, inputs, run, shifted(instant, 2).replace('Z', '00Z'))
      .quality();
    expect(budget.remaining(attacker)).toBe(0);
  });

  it('[NFR-SEC-05] charges a pass that was evicted again, although its instant was paid for', async () => {
    const { as } = callers();
    const budget = new EngineBudget({ passes: 10, windowMs: 60_000 });
    const { cache, seen } = countingCache({ budget, maxBytes: estimatePassBytes(3) });
    const [a, b] = [at('e02'), at('e03')] as const;
    await cache.computation(as('t', 'first'), inputs, run, a).analysis();
    await cache.computation(as('t', 'first'), inputs, run, b).analysis(); // evicts a
    expect(seen).toHaveLength(2);
    const second = as('t', 'second');
    await cache.computation(second, inputs, run, a).analysis();
    expect(seen).toHaveLength(3);
    expect(budget.remaining(second)).toBe(9);
  });
});

describe('the pass cache is bounded by an estimate of what it holds', () => {
  it('[NFR-SEC-05] holds a sequential scan of every prefix of a 31-event case without thrashing', async () => {
    const { cache, seen } = countingCache();
    const scan = async (): Promise<void> => {
      for (const event of events) {
        await cache.computation(anyone, inputs, run, event.timestamp).analysis();
      }
      await cache.computation(anyone, inputs, run, shifted(at('e01'), -1)).analysis();
    };
    await scan();
    const afterFirst = seen.length;
    expect(afterFirst).toBe(new Set(events.map((event) => event.timestamp)).size + 1);
    await scan();
    await scan();
    expect(seen).toHaveLength(afterFirst);
    expect(cache.passes.stats.estimatedBytes).toBeLessThanOrEqual(PASS_CACHE_BYTES);
    expect(cache.passes.stats.entries).toBeLessThanOrEqual(PASS_CACHE_ENTRIES);
    // The estimate scales with the visible events, and the budget keeps several whole scans.
    expect(estimatePassBytes(31)).toBeGreaterThan(estimatePassBytes(1));
    let scanBytes = 0;
    for (let count = 0; count <= events.length; count++) scanBytes += estimatePassBytes(count);
    expect(scanBytes * 3).toBeLessThanOrEqual(PASS_CACHE_BYTES);
  });

  it('[NFR-SEC-05] evicts the least recently used window when the estimate is exceeded', async () => {
    const budgetBytes = estimatePassBytes(5) * 2;
    const { cache, seen } = countingCache({ maxBytes: budgetBytes });
    const [a, b, c] = [at('e02'), at('e03'), at('e04')] as const;
    await cache.computation(anyone, inputs, run, a).analysis();
    await cache.computation(anyone, inputs, run, b).analysis();
    expect(seen).toHaveLength(2);
    await cache.computation(anyone, inputs, run, a).analysis(); // a is now the most recent
    await cache.computation(anyone, inputs, run, c).analysis(); // evicts b
    expect(seen).toHaveLength(3);
    expect(cache.passes.stats.estimatedBytes).toBeLessThanOrEqual(budgetBytes);
    await cache.computation(anyone, inputs, run, a).analysis();
    expect(seen).toHaveLength(3);
    await cache.computation(anyone, inputs, run, b).analysis();
    expect(seen).toHaveLength(4);
  });

  it('[NFR-SEC-05] always keeps the newest window, even when it alone is above the bound', async () => {
    const { cache, seen } = countingCache({ maxBytes: 1 });
    const instant = at('e30');
    await cache.computation(anyone, inputs, run, instant).analysis();
    await cache.computation(anyone, inputs, run, shifted(instant, 1)).analysis();
    expect(seen).toHaveLength(1);
    expect(cache.passes.stats.entries).toBe(1);
  });

  it('[NFR-SEC-05] weighs entries in an LRU and keeps the newest alone above the bound', () => {
    const cache = new LruCache<string, string>(10, { maxWeight: 10, weigh: (v) => v.length });
    cache.set('a', '1234');
    cache.set('b', '1234');
    expect(cache.weight).toBe(8);
    cache.set('c', '1234'); // 12 > 10: a goes
    expect(cache.get('a')).toBeUndefined();
    expect(cache.weight).toBe(8);
    cache.set('big', '12345678901234'); // alone above the bound: everything else goes, it stays
    expect(cache.size).toBe(1);
    expect(cache.get('big')).toBe('12345678901234');
    cache.set('big', '12'); // replacing an entry replaces its weight
    expect(cache.weight).toBe(2);
    cache.delete('big');
    expect(cache.size).toBe(0);
    expect(cache.weight).toBe(0);
    expect(() => new LruCache(1, { maxWeight: 0, weigh: () => 0 })).toThrow(RangeError);
    expect(VIEW_BOUNDARY_CAPACITY).toBeGreaterThanOrEqual(64);
  });
});

describe('a request the engine budget refuses leaves nothing behind', () => {
  const visibleOf = (instant: string): number =>
    createTemporalView(inputs.events, instant, { resolution: inputs.resolution }).events.length;
  /** Windows nobody has paid for: every request for one of them is refused by an empty bucket. */
  const strangers = (): string[] =>
    ['e16', 'e18', 'e20', 'e22', 'e24', 'e26', 'e28', 'e30'].map(at);

  /** Five passes somebody paid for, in a cache with room for exactly them, and a caller with no budget. */
  async function warmVictims(bound: 'bytes' | 'entries') {
    const { as } = callers();
    const budget = new EngineBudget({ passes: 10, windowMs: 60_000 });
    const victims = ['e10', 'e11', 'e12', 'e13', 'e14'].map(at);
    const room =
      bound === 'bytes'
        ? {
            maxBytes: victims.reduce(
              (sum, instant) => sum + estimatePassBytes(visibleOf(instant)),
              0,
            ),
          }
        : { maxEntries: victims.length };
    const { cache, seen } = countingCache({ budget, ...room });
    const victim = as('t', 'victim');
    for (const instant of victims) {
      await cache.computation(victim, inputs, run, instant).analysis();
    }
    const attacker = as('t', 'attacker');
    budget.charge(attacker, budget.passes);
    expect(budget.remaining(attacker)).toBe(0);
    return { cache, seen, victim, attacker, victims };
  }

  it.each(['bytes', 'entries'] as const)(
    '[NFR-SEC-05] never lets refused requests for other windows evict passes somebody paid for (bounded by %s)',
    async (bound) => {
      const { cache, seen, victim, attacker, victims } = await warmVictims(bound);
      const before = cache.passes.stats;
      expect(before.entries).toBe(victims.length);

      for (const instant of strangers()) {
        await expect(cache.computation(attacker, inputs, run, instant).analysis()).rejects.toThrow(
          RateLimitedError,
        );
      }
      // Nothing was cached for them: neither the entries nor the weight grew, and no pass ran.
      expect(cache.passes.stats).toEqual(before);
      expect(seen).toHaveLength(victims.length);

      // Every paid pass is still there, free for the one who paid and for anybody else.
      for (const instant of victims) {
        await cache.computation(victim, inputs, run, instant).analysis();
        await cache.computation(attacker, inputs, run, instant).analysis();
      }
      expect(seen).toHaveLength(victims.length);
      expect(cache.passes.stats.coldPasses).toBe(before.coldPasses);
    },
  );

  it('[NFR-SEC-05] caches nothing for a ranking the budget refuses', async () => {
    const { cache, attacker } = await warmVictims('bytes');
    const before = cache.passes.stats;
    for (const instant of strangers()) {
      const refused = cache.computation(attacker, inputs, run, instant);
      expect(() =>
        refused.rankingFor('at', () => {
          throw new Error('a ranking is never built for a refused request');
        }),
      ).toThrow(RateLimitedError);
    }
    expect(cache.passes.stats).toEqual(before);
  });

  it('[NFR-SEC-05] keeps every paid boundary when refused requests ask for other instants', async () => {
    const { as } = callers();
    const budget = new EngineBudget({ passes: 10, windowMs: 60_000 });
    const { cache } = countingCache({ budget, engine: 'real', boundaries: 4 });
    const victim = as('t', 'victim');
    const instants = ['e10', 'e11', 'e12'].map(at);
    for (const instant of instants) {
      await cache.computation(victim, inputs, run, instant).quality();
    }
    const paid = budget.remaining(victim);
    expect(paid).toBe(7);
    expect(cache.size).toBe(instants.length);

    // Other instants of the same windows: the passes are cached, so only the work of the instant
    // itself is refused, and the refusal must not push a paid boundary out of its (tiny) cache.
    const attacker = as('t', 'attacker');
    budget.charge(attacker, budget.passes);
    for (const instant of instants) {
      for (const offset of [1, 2, 3]) {
        await expect(
          cache.computation(attacker, inputs, run, shifted(instant, offset)).quality(),
        ).rejects.toThrow(RateLimitedError);
      }
    }
    expect(cache.size).toBe(instants.length);
    for (const instant of instants) {
      await cache.computation(victim, inputs, run, instant).quality();
    }
    expect(budget.remaining(victim)).toBe(paid);
  });

  it('[NFR-SEC-05] caches a window, weighed in full, only once its pass was paid for and started', async () => {
    const { cache } = countingCache();
    const instant = at('e12');
    const computation = cache.computation(anyone, inputs, run, instant);
    // Asking for a computation caches nothing; being allowed to work does.
    expect(cache.passes.stats).toMatchObject({ entries: 0, estimatedBytes: 0 });
    await computation.analysis();
    const weight = estimatePassBytes(visibleOf(instant));
    expect(cache.passes.stats).toMatchObject({ entries: 1, estimatedBytes: weight });
    // The same window again is a free read and weighs no more.
    await cache.computation(anyone, inputs, run, shifted(instant, 1)).analysis();
    expect(cache.passes.stats).toMatchObject({ entries: 1, estimatedBytes: weight, reused: 1 });
  });

  it('[NFR-SEC-05] keeps nothing for a pass that failed, but keeps a ranking built for its window', async () => {
    const failing = new ViewCache({
      passes: {
        analyse: () => {
          throw new Error('engine failure');
        },
      },
    });
    const instant = at('e07');
    await expect(failing.computation(anyone, inputs, run, instant).analysis()).rejects.toThrow(
      'engine failure',
    );
    expect(failing.passes.stats).toMatchObject({ entries: 0, estimatedBytes: 0 });

    const core = { posterior: [], candidates: [], blocked: [] };
    const computation = failing.computation(anyone, inputs, run, instant);
    computation.rankingFor('at', () => core);
    await expect(computation.analysis()).rejects.toThrow('engine failure');
    expect(failing.passes.stats.entries).toBe(1);
    const again = failing.computation(anyone, inputs, run, shifted(instant, 1));
    expect(
      again.rankingFor('at', () => {
        throw new Error('the ranking of the window is still cached');
      }),
    ).toBe(core);
  });
});

describe('what a pass depends on', () => {
  it('[FR-TL-06] derives the pass window from the visible events and resolution alone', () => {
    const last = events[events.length - 1]?.timestamp ?? '';
    const resolved = inputs.resolution?.resolvedAt ?? last;
    const cases: [string, string][] = [
      [shifted(at('e07'), 1), at('e07')],
      [at('e07'), at('e07')],
      [shifted(at('e01'), -5_000), shifted(at('e01'), -1)],
      [shifted(at('e01'), -86_400_000), shifted(at('e01'), -1)],
    ];
    for (const [asOf, boundary] of cases) {
      const view = createTemporalView(inputs.events, asOf, { resolution: inputs.resolution });
      const pass = passView(inputs, view);
      expect(pass.asOf).toBe(new Date(Date.parse(boundary)).toISOString());
      expect(pass.fingerprint).toBe(view.fingerprint);
      expect(pass.events.length).toBe(view.events.length);
      expect(pass.resolution === null).toBe(view.resolution === null);
    }
    // The resolution is visible in its own window, with every event.
    const whole = passView(
      inputs,
      createTemporalView(inputs.events, '2999-01-01T00:00:00Z', { resolution: inputs.resolution }),
    );
    expect(whole.events.length).toBe(events.length);
    expect(whole.resolution === null).toBe(inputs.resolution === null);
    expect(Date.parse(whole.asOf)).toBe(Math.max(Date.parse(last), Date.parse(resolved)));
  });

  it('[FR-TL-06] seeds a window by what it sees, not by a hash of the whole stored source', () => {
    const asOf = at('e07');
    const strict = createTemporalView(inputs.events, asOf, { resolution: inputs.resolution });
    const whole = createFullView(inputs.events, inputs.resolution);
    expect(coversWholeRecord(inputs, strict)).toBe(false);
    expect(coversWholeRecord(inputs, whole)).toBe(true);

    // The same past with a different future (and so another stored hash) seeds the window alike.
    const rewritten: AnalysisInputs = {
      ...inputs,
      events: inputs.events.map((event) =>
        Date.parse(event.timestamp) > Date.parse(asOf)
          ? {
              ...event,
              body: `${event.body} rewritten`,
              timestamp: shifted(event.timestamp, 86_400_000),
            }
          : event,
      ),
      resolution:
        inputs.resolution === null
          ? null
          : {
              ...inputs.resolution,
              summary: 'rewritten',
              resolvedAt: shifted(inputs.resolution.resolvedAt, 86_400_000),
            },
    };
    const otherRun = buildAnalysisRun({ ...run, id: 'run_other', inputHash: 'another-hash' });
    const strictOther = createTemporalView(rewritten.events, asOf, {
      resolution: rewritten.resolution,
    });
    expect(passContext(otherRun, rewritten, strictOther).seed).toBe(
      passContext(run, inputs, strict).seed,
    );
    expect(passContext(run, inputs, strict).seed).not.toBe(run.inputHash);
    // A window with a different set of visible events is seeded differently.
    const longer = createTemporalView(inputs.events, at('e08'), { resolution: inputs.resolution });
    expect(passContext(run, inputs, longer).seed).not.toBe(passContext(run, inputs, strict).seed);
    // The whole record is exactly what the stored run analysed, so it keeps the stored seed and ids.
    const stored = passContext(run, inputs, whole);
    expect(stored.seed).toBe(simulationSeed(inputs));
    expect(stored.runId).toBe(run.id);
    expect(stored.now).toBe(run.startedAt);
    expect(passContext(run, inputs, strict).runId).toBe(run.id);
  });

  it('answers an instant that is not a valid timestamp with a 422, never a crash', () => {
    expect(() => canonicalInstant('not-a-time')).toThrow(ValidationFailedError);
    expect(() => new ViewCache().computation(anyone, inputs, run, 'nonsense')).toThrow(
      ValidationFailedError,
    );
    expect(ENGINE_BUDGET_PASSES).toBe(30);
    expect(ENGINE_BUDGET_WINDOW_MS).toBe(60_000);
  });
});
