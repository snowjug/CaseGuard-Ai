import { describe, expect, it } from 'vitest';
import {
  CounterfactualScenarioSchema,
  HindsightCheckSchema,
  type CounterfactualStrategy,
} from '@caseguard/schemas';
import {
  generateCounterfactuals,
  simulateAlternativePath,
  createTemporalViewBeforeEvent,
} from '../src';
import { CASE_ONE, CASE_TWO, CONFIG, eventBySuffix, prepareCase } from './helpers';

const p = prepareCase(CASE_ONE);
const events = p.normalized.events;
const resolution = p.normalized.resolution;
const STRATEGIES: CounterfactualStrategy[] = [
  'balanced',
  'lowest_customer_effort',
  'fastest_diagnosis',
];
const HIGH_EFFORT = new Set(['high', 'very_high']);

const run = (suffix: string, rolloutCount = 120, seed?: string) => {
  const fork = p.analysis.forks.find((f) => f.eventId === eventBySuffix(p, suffix).id);
  if (!fork) throw new Error(`no fork at ${suffix}`);
  const ctx = seed ? { ...p.ctx, seed } : p.ctx;
  return {
    fork,
    result: generateCounterfactuals({
      analysis: p.analysis,
      fork,
      strategies: STRATEGIES,
      events,
      resolution,
      pack: p.pack,
      config: CONFIG,
      ctx,
      rolloutCount,
    }),
  };
};

describe('counterfactual scenarios (FR-CF-01..07)', () => {
  const { result } = run('e09');

  it('[FR-CF-03] every scenario is labelled simulated, lists assumptions and satisfies the contract', () => {
    expect(result.scenarios).toHaveLength(3);
    for (const scenario of result.scenarios) {
      expect(() => CounterfactualScenarioSchema.parse(scenario)).not.toThrow();
      expect(scenario.labels).toEqual({ simulated: true, estimated: true });
      expect(scenario.assumptions.length).toBeGreaterThanOrEqual(4);
      expect(scenario.summary).toMatch(/Simulated estimate/);
      for (const step of scenario.steps) {
        expect(step.simulated).toBe(true);
        expect(step.predictedOutcome.simulatedResult.length).toBeGreaterThan(0);
        expect(step.uncertainty).toMatch(/low|medium|high/);
      }
    }
  });

  it('[FR-CF-04] steps are safe, supported and respect prerequisites', () => {
    for (const scenario of result.scenarios) {
      expect(scenario.status).toBe('completed');
      expect(scenario.validity.valid).toBe(true);
      for (const step of scenario.steps) {
        const action = p.pack.actions.get(step.actionKey);
        expect(action?.destructive).toBe(false);
        expect(action?.valueClass).not.toBe('remediation');
        expect(step.safe).toBe(true);
        expect(step.supported).toBe(true);
      }
    }
  });

  it('[FR-CF-02] records a leak check that passed for every scenario', () => {
    for (const scenario of result.scenarios) {
      expect(scenario.boundary.leakCheck.passed).toBe(true);
      expect(scenario.boundary.leakCheck.futureReferencesFound).toBe(0);
      expect(scenario.boundary.leakCheck.resolutionExcluded).toBe(true);
      expect(scenario.boundary.asOf).toBe(eventBySuffix(p, 'e09').timestamp);
    }
  });

  it('[FR-CF-05] compares actual and counterfactual on every metric with ordered ranges and signed improvements', () => {
    for (const scenario of result.scenarios) {
      const m = scenario.counterfactualMetrics;
      for (const range of [
        m.actionCount,
        m.customerInteractions,
        m.timeToUsefulEvidenceMinutes,
        m.timeToDiagnosisMinutes,
        m.diagnosticVolume,
        m.tokenEstimate,
        m.customerEffortMinutes,
        m.informationGainBits,
      ]) {
        expect(range.low).toBeLessThanOrEqual(range.mid + 1e-9);
        expect(range.mid).toBeLessThanOrEqual(range.high + 1e-9);
      }
      expect(scenario.improvements.timeToDiagnosisMinutes).toBeGreaterThan(0);
      expect(scenario.improvements.customerEffortMinutes).toBeGreaterThan(0);
      expect(scenario.improvements.tokenEstimate).toBeGreaterThan(0);
      expect(scenario.improvements.timeToDiagnosisMinutesPct).toBeGreaterThan(0.5);
      expect(scenario.actualMetrics.timeToDiagnosisMinutes.mid).toBeGreaterThan(
        m.timeToDiagnosisMinutes.mid,
      );
      expect(scenario.comparisonConfidence.level).toMatch(/low|medium|high/);
    }
  });

  it('[FR-CF-07] the hindsight check is separate, labelled, and agrees with the recorded root cause', () => {
    expect(result.hindsight).toHaveLength(3);
    for (const check of result.hindsight) {
      expect(() => HindsightCheckSchema.parse(check)).not.toThrow();
      expect(check.usedFinalResolution).toBe(true);
      expect(check.notice).toMatch(/never available|does not influence/i);
      expect(check.resolutionHypothesisKey).toBe('hyp.dns-resolution');
      expect(check.consistentWithResolution).toBe(true);
    }
  });

  it('the strategy "lowest customer effort" never asks for a high-effort step', () => {
    const scenario = result.scenarios.find((s) => s.strategy === 'lowest_customer_effort');
    expect(scenario?.steps.every((s) => !HIGH_EFFORT.has(s.customerEffort))).toBe(true);
  });

  it('the best step at a late fork is the DNS resolver comparison, and diagnosis is reached quickly', () => {
    const balanced = result.scenarios.find((s) => s.strategy === 'balanced');
    expect(balanced?.steps[0]?.actionKey).toBe('act.dns-resolver-comparison');
    expect(balanced?.steps[0]?.posteriorAfter[0]?.key).toBe('hyp.dns-resolution');
    expect(balanced?.rollouts.diagnosisReachedShare).toBeGreaterThan(0.8);
    expect(balanced?.counterfactualMetrics.timeToDiagnosisMinutes.mid).toBeLessThan(240);
  });

  it('is reproducible for a seed and varies with the seed only in sampled ranges', () => {
    const again = run('e09').result;
    expect(JSON.stringify(again.scenarios)).toBe(JSON.stringify(result.scenarios));
    const other = run('e09', 120, 'another-seed').result;
    expect(other.scenarios[0]?.steps.map((s) => s.actionKey)).toEqual(
      result.scenarios[0]?.steps.map((s) => s.actionKey),
    );
    expect(other.scenarios[0]?.rollouts.seed).not.toBe(result.scenarios[0]?.rollouts.seed);
  });

  it('the earliest fork is honest about low confidence when little was known', () => {
    const early = run('e03').result.scenarios[0];
    expect(early?.comparisonConfidence.level).toBe('low');
    expect(early?.steps.length).toBeGreaterThan(1);
    expect(early?.branchNotes.length).toBeGreaterThan(0);
  });

  it('every fork of Case One yields valid, leak-free scenarios under every strategy', () => {
    for (const fork of p.analysis.forks) {
      const res = generateCounterfactuals({
        analysis: p.analysis,
        fork,
        strategies: STRATEGIES,
        events,
        resolution,
        pack: p.pack,
        config: CONFIG,
        ctx: p.ctx,
        rolloutCount: 40,
      });
      for (const scenario of res.scenarios) {
        expect(scenario.status, `${fork.title} / ${scenario.strategy}`).toBe('completed');
        expect(scenario.boundary.leakCheck.passed).toBe(true);
      }
      expect(res.hindsight.every((h) => h.consistentWithResolution === true)).toBe(true);
    }
  });

  it('predicted outcome probabilities are valid and the alternatives are bounded', () => {
    for (const scenario of result.scenarios) {
      for (const step of scenario.steps) {
        const total =
          step.predictedOutcome.probability +
          step.predictedOutcome.alternatives.reduce((s, a) => s + a.probability, 0);
        expect(total).toBeGreaterThan(0.95);
        expect(total).toBeLessThan(1.05);
        expect(step.predictedOutcome.alternatives.length).toBeLessThanOrEqual(4);
      }
    }
  });
});

describe('simulation guards', () => {
  it('stops at diagnosis and never exceeds the pack step limit', () => {
    const fork = p.analysis.forks[0];
    if (!fork) throw new Error('expected a fork');
    const view = createTemporalViewBeforeEvent(events, fork.eventId);
    const sim = simulateAlternativePath({
      preView: view,
      fork,
      strategy: 'balanced',
      pack: p.pack,
      config: CONFIG,
      ctx: p.ctx,
      rolloutCount: 30,
    });
    expect(sim.steps.length).toBeLessThanOrEqual(p.pack.pack.policies.maxCounterfactualSteps);
    const executed = new Set(sim.steps.map((s) => s.action.id));
    expect(executed.size).toBe(sim.steps.length);
  });

  it('the efficient case offers nothing to simulate', () => {
    expect(prepareCase(CASE_TWO).analysis.forks).toHaveLength(0);
  });
});
