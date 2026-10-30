import { RateLimitedError } from '../errors';

/*
 * A per-caller allowance of COLD engine work. Recomputing the engine on what was known at an instant
 * costs hundreds of milliseconds to seconds of synchronous CPU, so a caller that keeps asking for
 * instants nobody has asked for before could keep the process busy. Work that finds its result in a
 * cache is free; a request that has to do cold work (a cold engine pass, or per-instant work nobody
 * has computed yet) takes one unit from its bucket, however many cold computations it needs, and an
 * empty bucket is a 429 with Retry-After, answered before any engine work starts.
 *
 * It is a token bucket: it holds up to ENGINE_BUDGET_PASSES units, refills continuously (a full bucket
 * takes ENGINE_BUDGET_WINDOW_MS), and is kept per tenant and user. Views and skill matching draw from
 * the same bucket of one app, see `engineBudgetFor`.
 *
 *   const budget = engineBudgetFor(infra);        // once, when the routes are built
 *   ...
 *   if (!cache.has(key)) budget.charge(ctx);       // only on a miss, before the engine runs
 */

/** Cold engine passes one caller can start in a burst; the bucket refills this many per window. */
export const ENGINE_BUDGET_PASSES = 30;
/** How long an empty bucket takes to refill completely. */
export const ENGINE_BUDGET_WINDOW_MS = 60_000;
/** Callers tracked at once. The least recently active are forgotten and start again with a full bucket. */
export const ENGINE_BUDGET_MAX_CALLERS = 10_000;

export interface EngineBudgetOptions {
  /** Size of the bucket (default ENGINE_BUDGET_PASSES). */
  readonly passes?: number;
  /** Time a drained bucket takes to refill (default ENGINE_BUDGET_WINDOW_MS). */
  readonly windowMs?: number;
  /** Callers tracked at once (default ENGINE_BUDGET_MAX_CALLERS). */
  readonly maxCallers?: number;
}

/** Who is asking, and the clock to read: a RequestContext satisfies it. */
export interface EngineBudgetCaller {
  readonly auth: { readonly tenantId: string; readonly userId: string };
  readonly now: () => Date;
}

interface Bucket {
  tokens: number;
  at: number;
}

function positive(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive`);
  return value;
}

export class EngineBudget {
  readonly passes: number;
  readonly windowMs: number;
  private readonly maxCallers: number;
  private readonly buckets = new Map<string, Bucket>();

  constructor(options: EngineBudgetOptions = {}) {
    this.passes = positive('passes', options.passes ?? ENGINE_BUDGET_PASSES);
    this.windowMs = positive('windowMs', options.windowMs ?? ENGINE_BUDGET_WINDOW_MS);
    this.maxCallers = Math.max(
      1,
      Math.floor(positive('maxCallers', options.maxCallers ?? ENGINE_BUDGET_MAX_CALLERS)),
    );
  }

  /**
   * Takes `cost` units (one cold pass by default) from the caller's bucket, or throws a
   * RateLimitedError (429, Retry-After in seconds) and takes nothing. Call it before the engine runs
   * and only when the result is not already cached.
   */
  charge(caller: EngineBudgetCaller, cost = 1): void {
    const need = Math.min(positive('cost', cost), this.passes);
    const key = keyOf(caller);
    const now = caller.now().getTime();
    const bucket = this.refilled(key, now);
    if (bucket.tokens >= need) {
      bucket.tokens -= need;
      return;
    }
    const perMs = this.passes / this.windowMs;
    const seconds = Math.ceil((need - bucket.tokens) / perMs / 1000);
    throw new RateLimitedError(
      Math.max(1, seconds),
      'Too many views were recomputed in a short time. Views already computed stay available; retry shortly.',
      'engine_budget',
    );
  }

  /** Whole units the caller could take right now (diagnostics and tests). */
  remaining(caller: EngineBudgetCaller): number {
    return Math.floor(this.refilled(keyOf(caller), caller.now().getTime()).tokens);
  }

  private refilled(key: string, now: number): Bucket {
    const known = this.buckets.get(key);
    const bucket: Bucket = known ?? { tokens: this.passes, at: now };
    // A clock that moved backwards must neither refill nor drain the bucket.
    const elapsed = Math.max(0, now - bucket.at);
    bucket.tokens = Math.min(this.passes, bucket.tokens + (elapsed * this.passes) / this.windowMs);
    bucket.at = Math.max(bucket.at, now);
    // Re-inserting keeps the Map ordered by recency, so the first key is the least recently active.
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    for (const oldest of this.buckets.keys()) {
      if (this.buckets.size <= this.maxCallers) break;
      this.buckets.delete(oldest);
    }
    return bucket;
  }
}

const keyOf = (caller: EngineBudgetCaller): string =>
  `${caller.auth.tenantId}|${caller.auth.userId}`;

const shared = new WeakMap<object, EngineBudget>();

/**
 * The budget of one app: every route family that runs cold engine work (views, skill matching) calls
 * this with the same `infra` and so draws from one bucket per user. The first call fixes the options.
 */
export function engineBudgetFor(owner: object, options?: EngineBudgetOptions): EngineBudget {
  let budget = shared.get(owner);
  if (budget === undefined) {
    budget = new EngineBudget(options);
    shared.set(owner, budget);
  }
  return budget;
}
