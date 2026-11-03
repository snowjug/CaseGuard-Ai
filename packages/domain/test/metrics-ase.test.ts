import fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  AvoidableEffortDetailsSchema,
  METRIC_DEFINITIONS,
  type CounterfactualScenario,
  type PathMetrics,
  type Range,
} from '@caseguard/schemas';
import {
  ASE_NOTICE,
  computeAvoidableEffort,
  isUsableScenario,
  summarizeAvoidableEffort,
  toAvoidableEffortDetails,
  type AvoidableEffortEstimate,
} from '../src';
import { CASE_ONE, CASE_TWO, prepareCase } from './helpers';
import { scenariosFor } from './quality-fixtures';

const one = prepareCase(CASE_ONE);
const two = prepareCase(CASE_TWO);

let scenarios: CounterfactualScenario[] = [];
let estimate: AvoidableEffortEstimate;

beforeAll(() => {
  scenarios = scenariosFor(one);
  estimate = computeAvoidableEffort({ analysis: one.analysis, pack: one.pack, scenarios });
}, 120_000);

const ase = (list: readonly CounterfactualScenario[]) =>
  computeAvoidableEffort({ analysis: one.analysis, pack: one.pack, scenarios: list });

const inBounds = (r: Range) => {
  for (const v of [r.low, r.mid, r.high]) {
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(100);
  }
  expect(r.low).toBeLessThanOrEqual(r.mid);
  expect(r.mid).toBeLessThanOrEqual(r.high);
};

describe('Avoidable Support Effort on the synthetic cases (FR-ASE-01)', () => {
  it('[FR-ASE-01] Case One has an estimate with a low-high range, built from valid simulated paths', () => {
    expect(estimate.state).toBe('estimated');
    expect(estimate.estimated).toBe(true);
    expect(estimate.simulated).toBe(true);
    expect(estimate.reason).toBeNull();
    expect(estimate.percent).not.toBeNull();
    const percent = estimate.percent as Range;
    inBounds(percent);
    expect(percent.mid).toBeGreaterThan(30);
    expect(percent.mid).toBeLessThan(85);
    expect(percent.high).toBeGreaterThan(percent.low);
    expect(['low', 'medium', 'high']).toContain(estimate.confidence);
  });

  it('[FR-ASE-01] the comparison names the fork, the best valid scenario and the valid paths considered', () => {
    const basis = estimate.basis;
    expect(basis).not.toBeNull();
    if (!basis) return;
    expect(basis.forkId).toBe(one.analysis.earliestMeaningfulForkId);
    const usable = scenarios.filter(isUsableScenario).filter((s) => s.forkId === basis.forkId);
    expect(basis.scenarioIds.sort()).toEqual(usable.map((s) => s.id).sort());
    expect(basis.scenarioIds).toContain(basis.bestScenarioId);
    inBounds(basis.remainingPct);
    expect(basis.remainingPct.mid).toBeCloseTo(100 - (estimate.percent?.mid ?? 0), 0);
  });

  it('[FR-ASE-01] every component is bounded, explained and weights sum to one over the included ones', () => {
    const included = estimate.components.filter((c) => c.included);
    expect(included.length).toBeGreaterThanOrEqual(5);
    expect(included.reduce((s, c) => s + c.weight, 0)).toBeCloseTo(1, 3);
    for (const c of estimate.components) {
      inBounds(c.pct);
      expect(c.assumption.length).toBeGreaterThan(20);
      expect(c.avoidable.low).toBeGreaterThanOrEqual(0);
      expect(c.avoidable.high).toBeLessThanOrEqual(c.total + 1e-6);
      if (!c.included) expect(c.weight).toBe(0);
    }
    const customer = included.find((c) => c.key === 'customer_effort');
    expect(customer?.evidence.length).toBeGreaterThan(0);
    expect(estimate.components.map((c) => c.key).sort()).toEqual(
      [
        'compute_usage',
        'customer_effort',
        'diagnostic_executions',
        'engineer_effort',
        'escalations',
        'low_information_actions',
        'repeated_interactions',
        'token_usage',
        'waiting_time',
      ].sort(),
    );
  });

  it('[FR-ASE-01] carries the notice, the method and the assumptions; it is never presented as measured', () => {
    expect(estimate.notice).toBe(ASE_NOTICE);
    expect(estimate.notice).toContain(METRIC_DEFINITIONS.avoidable_support_effort.definition);
    expect(estimate.notice).toMatch(/never a measured fact/);
    expect(estimate.method).toMatch(/simulated from the knowledge pack/);
    expect(estimate.method).toMatch(/every figure is an estimate/);
    expect(estimate.assumptions.length).toBeGreaterThan(0);
  });

  it('[FR-ASE-01] compute usage is left out when no compute telemetry exists, with the reason stated', () => {
    const compute = estimate.components.find((c) => c.key === 'compute_usage');
    expect(compute?.included).toBe(false);
    expect(compute?.assumption).toMatch(/compute/i);
  });

  it('[FR-ASE-01] Case Two has no decision fork: 0% with an explanation, not a counterfactual', () => {
    const result = computeAvoidableEffort({
      analysis: two.analysis,
      pack: two.pack,
      scenarios: [],
    });
    expect(result.state).toBe('no_decision_forks');
    expect(result.percent).toEqual({ low: 0, mid: 0, high: 0 });
    expect(result.reason).toMatch(/No decision fork/);
    expect(result.components).toEqual([]);
    expect(result.basis).toBeNull();
    expect(result.estimated).toBe(true);
  });

  it('[FR-ASE-01] the contract projection is valid and keeps the counterfactual comparison', () => {
    const details = toAvoidableEffortDetails(estimate);
    expect(() => AvoidableEffortDetailsSchema.parse(details)).not.toThrow();
    expect(details.components.every((c) => c.avoidablePct >= 0 && c.avoidablePct <= 100)).toBe(
      true,
    );
    expect(details.components.reduce((s, c) => s + c.weight, 0)).toBeCloseTo(1, 3);
    expect(details.counterfactual?.scenarioId).toBe(estimate.basis?.bestScenarioId);
    expect(details.counterfactual?.actualPct).toBe(100);
    const empty = toAvoidableEffortDetails(ase([]));
    expect(() => AvoidableEffortDetailsSchema.parse(empty)).not.toThrow();
    expect(empty.components).toEqual([]);
    expect(empty.counterfactual).toBeNull();
  });
});

describe('the null state when no valid counterfactual exists (FR-ASE-01)', () => {
  it('[FR-ASE-01] with no simulated path the estimate is null and says why', () => {
    const result = ase([]);
    expect(result.state).toBe('no_valid_counterfactual');
    expect(result.percent).toBeNull();
    expect(result.reason).toMatch(/No counterfactual path has been simulated/);
    expect(result.components).toEqual([]);
    expect(result.estimated).toBe(true);
  });

  it('[FR-ASE-01] rejected, invalid and leaking paths are never used', () => {
    const rejected = scenarios.map((s) => ({ ...s, reviewState: 'rejected' as const }));
    const invalid = scenarios.map((s) => ({ ...s, validity: { ...s.validity, valid: false } }));
    const failed = scenarios.map((s) => ({ ...s, status: 'failed' as const }));
    const leaking = scenarios.map((s) => ({
      ...s,
      boundary: { ...s.boundary, leakCheck: { ...s.boundary.leakCheck, passed: false } },
    }));
    for (const list of [rejected, invalid, failed, leaking]) {
      const result = ase(list);
      expect(result.state).toBe('no_valid_counterfactual');
      expect(result.percent).toBeNull();
      expect(result.basis).toBeNull();
    }
    expect(ase(rejected).reason).toMatch(/rejected by a reviewer/);
    expect(ase(invalid).reason).toMatch(/failed the validity checks/);
  });

  it('[FR-ASE-01] a rejected best path is ignored and the estimate falls back to the remaining valid ones', () => {
    const best = estimate.basis?.bestScenarioId;
    const remaining = scenarios.map((s) =>
      s.id === best ? { ...s, reviewState: 'rejected' as const } : s,
    );
    const result = ase(remaining);
    expect(result.state).toBe('estimated');
    expect(result.basis?.bestScenarioId).not.toBe(best);
    expect(result.basis?.scenarioIds).not.toContain(best);
    inBounds(result.percent as Range);
  });

  it('[FR-ASE-01] summaries roll up per-case estimates without counting null states as zero', () => {
    const zero = computeAvoidableEffort({ analysis: two.analysis, pack: two.pack, scenarios: [] });
    const summary = summarizeAvoidableEffort([estimate, zero, ase([])]);
    expect(summary.caseCount).toBe(2);
    expect(summary.withoutCounterfactual).toBe(1);
    expect(summary.avgPercent).toBeCloseTo((estimate.percent?.mid ?? 0) / 2, 0);
    expect(summary.patterns.length).toBeGreaterThan(0);
    for (const pattern of summary.patterns) {
      expect(pattern.avgAvoidablePct).toBeGreaterThanOrEqual(0);
      expect(pattern.avgAvoidablePct).toBeLessThanOrEqual(100);
      expect(pattern.caseCount).toBe(1);
    }
    const sorted = [...summary.patterns].sort((a, b) => b.avgAvoidablePct - a.avgAvoidablePct);
    expect(summary.patterns.map((p) => p.component)).toEqual(sorted.map((p) => p.component));
    expect(summarizeAvoidableEffort([])).toEqual({
      caseCount: 0,
      withoutCounterfactual: 0,
      avgPercent: null,
      patterns: [],
    });
  });

  it('[FR-ASE-01] component weights can be overridden and are re-normalised', () => {
    const result = computeAvoidableEffort({
      analysis: one.analysis,
      pack: one.pack,
      scenarios,
      weights: Object.fromEntries(
        estimate.components.map((c) => [c.key, c.key === 'customer_effort' ? 3 : 0]),
      ),
    });
    const included = result.components.filter((c) => c.included);
    expect(included.map((c) => c.key)).toEqual(['customer_effort']);
    expect(included[0]?.weight).toBe(1);
    expect(result.percent?.mid).toBeCloseTo(included[0]?.pct.mid ?? -1, 1);
  });
});

const rangeArb: fc.Arbitrary<Range> = fc
  .tuple(
    fc.double({ min: 0, max: 5000, noNaN: true }),
    fc.double({ min: 0, max: 5000, noNaN: true }),
    fc.double({ min: 0, max: 5000, noNaN: true }),
  )
  .map((values) => {
    const [low = 0, mid = 0, high = 0] = [...values].sort((a, b) => a - b);
    return { low, mid, high };
  });

const metricsArb: fc.Arbitrary<PathMetrics> = fc.record({
  actionCount: rangeArb,
  customerInteractions: rangeArb,
  timeToUsefulEvidenceMinutes: rangeArb,
  timeToDiagnosisMinutes: rangeArb,
  diagnosticVolume: rangeArb,
  tokenEstimate: rangeArb,
  customerEffortMinutes: rangeArb,
  operationalRisk: fc.double({ min: 0, max: 1, noNaN: true }),
  informationGainBits: rangeArb,
  unsupportedBranches: fc.nat(5),
});

describe('Avoidable Support Effort properties (FR-ASE-01)', () => {
  const variantArb = fc.record({
    status: fc.constantFrom('completed', 'completed', 'completed', 'rejected', 'failed'),
    review: fc.constantFrom('pending', 'confirmed', 'corrected', 'rejected'),
    valid: fc.boolean(),
    leakFree: fc.boolean(),
    actual: metricsArb,
    counterfactual: metricsArb,
  });

  type Variant = typeof variantArb extends fc.Arbitrary<infer T> ? T : never;

  /** Case One's scenario of its earliest fork, once per variant, with the variant's status and numbers. */
  const listOf = (variants: readonly Variant[]): CounterfactualScenario[] => {
    const base = scenariosFor(one).find((s) => s.forkId === one.analysis.earliestMeaningfulForkId);
    if (!base) throw new Error('Case One has no scenario for its earliest fork');
    return variants.map((v, i) => ({
      ...base,
      id: `scn_prop_${i}`,
      status: v.status,
      reviewState: v.review,
      validity: { ...base.validity, valid: v.valid },
      boundary: {
        ...base.boundary,
        leakCheck: { ...base.boundary.leakCheck, passed: v.leakFree },
      },
      actualMetrics: v.actual,
      counterfactualMetrics: v.counterfactual,
    }));
  };

  /** The weights are reported to four decimals, each off by at most 5e-5, so their sum is 1 within that rounding. */
  const expectWeightsSumToOne = (weights: readonly number[]) => {
    const sum = weights.reduce((s, w) => s + w, 0);
    expect(Math.abs(sum - 1)).toBeLessThanOrEqual(weights.length * 5e-5 + 1e-9);
  };

  it('[FR-ASE-01] never exceeds 100%, never negative, whatever the simulated numbers are', () => {
    fc.assert(
      fc.property(fc.array(variantArb, { maxLength: 4 }), (variants) => {
        const list = listOf(variants);
        const result = ase(list);
        expect(result.estimated).toBe(true);
        if (list.some(isUsableScenario)) {
          expect(result.state).toBe('estimated');
          inBounds(result.percent as Range);
          const included = result.components.filter((c) => c.included);
          expectWeightsSumToOne(included.map((c) => c.weight));
          for (const c of result.components) {
            inBounds(c.pct);
            expect(c.avoidable.low).toBeGreaterThanOrEqual(0);
            expect(c.avoidable.high).toBeLessThanOrEqual(c.total + 1e-6);
          }
          const details = toAvoidableEffortDetails(result);
          expect(() => AvoidableEffortDetailsSchema.parse(details)).not.toThrow();
        } else {
          expect(result.state).toBe('no_valid_counterfactual');
          expect(result.percent).toBeNull();
          expect(result.reason).not.toBeNull();
        }
      }),
      { numRuns: 120 },
    );
  });

  it('[FR-ASE-01] reports weights to four decimals, so two renormalised weights can sum to 1.0001', () => {
    // Found by a random run on CI (fast-check seed 105150624, on a documents-only commit): a real path with a vanishing
    // amount of two efforts and a counterfactual with none. Only two components have data, their weights are
    // renormalised and each is reported to four decimals; the estimate itself uses the unrounded weights.
    const tiny = { low: 0, mid: Number.MIN_VALUE, high: Number.MIN_VALUE };
    const zero = { low: 0, mid: 0, high: 0 };
    const nothing: PathMetrics = {
      actionCount: zero,
      customerInteractions: zero,
      timeToUsefulEvidenceMinutes: zero,
      timeToDiagnosisMinutes: zero,
      diagnosticVolume: zero,
      tokenEstimate: zero,
      customerEffortMinutes: zero,
      operationalRisk: 0,
      informationGainBits: zero,
      unsupportedBranches: 0,
    };
    const result = ase(
      listOf([
        {
          status: 'completed',
          review: 'pending',
          valid: true,
          leakFree: true,
          actual: { ...nothing, actionCount: tiny, tokenEstimate: tiny },
          counterfactual: nothing,
        },
      ]),
    );
    expect(result.state).toBe('estimated');
    const included = result.components.filter((c) => c.included);
    expect(included.length).toBeGreaterThan(1);
    expectWeightsSumToOne(included.map((c) => c.weight));
  });

  it('[FR-ASE-01] a cheaper counterfactual never lowers the estimate (monotonicity)', () => {
    fc.assert(
      fc.property(metricsArb, fc.double({ min: 0, max: 1, noNaN: true }), (metrics, factor) => {
        const base = scenariosFor(one).find(
          (s) => s.forkId === one.analysis.earliestMeaningfulForkId,
        );
        if (!base) throw new Error('Case One has no scenario for its earliest fork');
        const scale = (r: Range): Range => ({
          low: r.low * factor,
          mid: r.mid * factor,
          high: r.high * factor,
        });
        const cheaper: PathMetrics = {
          ...metrics,
          actionCount: scale(metrics.actionCount),
          customerInteractions: scale(metrics.customerInteractions),
          timeToDiagnosisMinutes: scale(metrics.timeToDiagnosisMinutes),
          diagnosticVolume: scale(metrics.diagnosticVolume),
          tokenEstimate: scale(metrics.tokenEstimate),
          customerEffortMinutes: scale(metrics.customerEffortMinutes),
        };
        const at = (m: PathMetrics) =>
          ase([{ ...base, counterfactualMetrics: m }]).percent?.mid ?? Number.NaN;
        expect(at(cheaper)).toBeGreaterThanOrEqual(at(metrics) - 1e-9);
      }),
      { numRuns: 100 },
    );
  });
});
