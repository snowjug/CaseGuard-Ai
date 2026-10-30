import { describe, expect, it } from 'vitest';
import { RateLimitedError } from '../src/errors';
import {
  ENGINE_BUDGET_MAX_CALLERS,
  ENGINE_BUDGET_PASSES,
  ENGINE_BUDGET_WINDOW_MS,
  EngineBudget,
  engineBudgetFor,
  type EngineBudgetCaller,
} from '../src/services/engine-budget';

/** A caller on a clock the test moves by hand. */
function callers(start = Date.parse('2026-06-01T00:00:00.000Z')) {
  const clock = { ms: start };
  const as = (tenantId: string, userId: string): EngineBudgetCaller => ({
    auth: { tenantId, userId },
    now: () => new Date(clock.ms),
  });
  return { clock, as };
}

function refusal(action: () => void): RateLimitedError {
  try {
    action();
  } catch (error) {
    if (error instanceof RateLimitedError) return error;
    throw error;
  }
  throw new Error('Expected the budget to refuse');
}

describe('EngineBudget', () => {
  it('[NFR-SEC-05] allows 30 cold passes per 60 seconds by default, in one place', () => {
    expect(ENGINE_BUDGET_PASSES).toBe(30);
    expect(ENGINE_BUDGET_WINDOW_MS).toBe(60_000);
    const budget = new EngineBudget();
    expect(budget.passes).toBe(ENGINE_BUDGET_PASSES);
    expect(budget.windowMs).toBe(ENGINE_BUDGET_WINDOW_MS);
    expect(ENGINE_BUDGET_MAX_CALLERS).toBeGreaterThan(1000);
  });

  it('[NFR-SEC-05] serves a burst, then refuses with a 429 and the wait in seconds', () => {
    const { as } = callers();
    const budget = new EngineBudget();
    const ava = as('t1', 'ava');
    for (let i = 0; i < ENGINE_BUDGET_PASSES; i++) budget.charge(ava);
    expect(budget.remaining(ava)).toBe(0);

    const refused = refusal(() => budget.charge(ava));
    expect(refused.status).toBe(429);
    expect(refused.code).toBe('rate_limited');
    // One unit comes back every 2 seconds (30 per 60 s).
    expect(refused.retryAfterSeconds).toBe(2);
    expect(refused.message).not.toMatch(/\b(ava|t1)\b|tenant|bucket|token/i);
    // A refusal takes nothing and says the same thing again.
    expect(budget.remaining(ava)).toBe(0);
    expect(refusal(() => budget.charge(ava)).retryAfterSeconds).toBe(2);
  });

  it('[NFR-SEC-05] refills continuously and completely after the window, never beyond the bucket', () => {
    const { clock, as } = callers();
    const budget = new EngineBudget();
    const ava = as('t1', 'ava');
    for (let i = 0; i < ENGINE_BUDGET_PASSES; i++) budget.charge(ava);

    clock.ms += 1_999;
    expect(refusal(() => budget.charge(ava)).retryAfterSeconds).toBe(1);
    clock.ms += 1;
    budget.charge(ava);
    expect(budget.remaining(ava)).toBe(0);

    clock.ms += ENGINE_BUDGET_WINDOW_MS;
    expect(budget.remaining(ava)).toBe(ENGINE_BUDGET_PASSES);
    // Idle time does not bank more than one bucket.
    clock.ms += 10 * ENGINE_BUDGET_WINDOW_MS;
    expect(budget.remaining(ava)).toBe(ENGINE_BUDGET_PASSES);
    for (let i = 0; i < ENGINE_BUDGET_PASSES; i++) budget.charge(ava);
    expect(() => budget.charge(ava)).toThrow(RateLimitedError);
  });

  it('[NFR-SEC-05] keeps a bucket per user and per tenant', () => {
    const { as } = callers();
    const budget = new EngineBudget();
    const ava = as('t1', 'ava');
    for (let i = 0; i < ENGINE_BUDGET_PASSES; i++) budget.charge(ava);
    expect(() => budget.charge(ava)).toThrow(RateLimitedError);

    // Another user of the same tenant, and the same user id in another tenant, are untouched.
    expect(budget.remaining(as('t1', 'riley'))).toBe(ENGINE_BUDGET_PASSES);
    expect(budget.remaining(as('t2', 'ava'))).toBe(ENGINE_BUDGET_PASSES);
    budget.charge(as('t1', 'riley'));
    budget.charge(as('t2', 'ava'));
    expect(budget.remaining(as('t1', 'riley'))).toBe(ENGINE_BUDGET_PASSES - 1);
    expect(budget.remaining(ava)).toBe(0);
  });

  it('[NFR-SEC-05] is not fooled by a clock that moves backwards', () => {
    const { clock, as } = callers();
    const budget = new EngineBudget();
    const ava = as('t1', 'ava');
    for (let i = 0; i < ENGINE_BUDGET_PASSES; i++) budget.charge(ava);
    clock.ms -= 10 * ENGINE_BUDGET_WINDOW_MS;
    expect(budget.remaining(ava)).toBe(0);
    expect(() => budget.charge(ava)).toThrow(RateLimitedError);
    // Time then runs forward again from the latest instant the bucket has seen.
    clock.ms += 10 * ENGINE_BUDGET_WINDOW_MS + 2_000;
    budget.charge(ava);
    expect(() => budget.charge(ava)).toThrow(RateLimitedError);
  });

  it('[NFR-SEC-05] charges a cost of several units, and never more than the whole bucket', () => {
    const { as } = callers();
    const budget = new EngineBudget({ passes: 4, windowMs: 4_000 });
    const ava = as('t1', 'ava');
    budget.charge(ava, 3);
    expect(budget.remaining(ava)).toBe(1);
    expect(refusal(() => budget.charge(ava, 3)).retryAfterSeconds).toBe(2);
    expect(budget.remaining(ava)).toBe(1);
    // A cost above the bucket is clamped to it, so a single request can always be served eventually.
    budget.charge(as('t1', 'riley'), 100);
    expect(budget.remaining(as('t1', 'riley'))).toBe(0);
  });

  it('[NFR-SEC-05] forgets the least recently active callers beyond its bound', () => {
    const { as } = callers();
    const budget = new EngineBudget({ passes: 2, windowMs: 60_000, maxCallers: 2 });
    const [a, b, c] = [as('t', 'a'), as('t', 'b'), as('t', 'c')] as const;
    budget.charge(a, 2);
    budget.charge(b, 2);
    expect(budget.remaining(a)).toBe(0); // a is now the most recent
    budget.charge(c, 2); // evicts b, the least recently active
    expect(budget.remaining(a)).toBe(0);
    expect(budget.remaining(b)).toBe(2);
  });

  it('[NFR-SEC-05] rejects settings that cannot work', () => {
    expect(() => new EngineBudget({ passes: 0 })).toThrow(RangeError);
    expect(() => new EngineBudget({ passes: Number.NaN })).toThrow(RangeError);
    expect(() => new EngineBudget({ windowMs: -1 })).toThrow(RangeError);
    expect(() => new EngineBudget({ maxCallers: 0 })).toThrow(RangeError);
    const { as } = callers();
    expect(() => new EngineBudget().charge(as('t', 'a'), 0)).toThrow(RangeError);
  });
});

describe('engineBudgetFor', () => {
  it('gives every route family of one app the same budget, and another app its own', () => {
    const app = {};
    const other = {};
    const first = engineBudgetFor(app, { passes: 3 });
    expect(engineBudgetFor(app)).toBe(first);
    expect(engineBudgetFor(app, { passes: 99 })).toBe(first);
    expect(first.passes).toBe(3);
    expect(engineBudgetFor(other)).not.toBe(first);
    expect(engineBudgetFor(other).passes).toBe(ENGINE_BUDGET_PASSES);
  });
});
