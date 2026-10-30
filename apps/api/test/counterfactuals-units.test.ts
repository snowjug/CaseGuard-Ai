import { describe, expect, it } from 'vitest';
import { projectScenario } from '@caseguard/ai';
import {
  createFullView,
  createTemporalViewBeforeEvent,
  getCompiledPack,
  runDeterministicAnalysis,
  type CompiledPack,
  type EngineContext,
} from '@caseguard/domain';
import {
  COUNTERFACTUAL_STRATEGIES,
  DEFAULT_ACTION_VALUE_CONFIG,
  type CaseEvent,
  type CounterfactualScenario,
  type DecisionFork,
} from '@caseguard/schemas';
import { LruCache } from '../src/services/counterfactuals/cache';
import {
  carryReview,
  isDecided,
  planReviewCarry,
  sameSimulation,
} from '../src/services/counterfactuals/carry';
import {
  MAX_DEFAULT_FORKS,
  defaultScenarioPlan,
  generateForFork,
  orderStrategies,
  type GenerationSource,
} from '../src/services/counterfactuals/generate';
import {
  finalizeScenario,
  futureTokensFor,
  type SimulatorRun,
} from '../src/services/counterfactuals/narrative';
import { acceptanceBlockers } from '../src/services/counterfactuals/review';
import { SAMPLE_FILES, normalizeSample } from './support/samples';

/* Pure unit tests: no database, no HTTP. The engine runs on the real synthetic Case One. */

const normalized = normalizeSample(SAMPLE_FILES.caseOne, {
  tenantId: 'tenant_unit',
  caseId: 'case_unit_one',
});
const compiled = getCompiledPack(normalized.case.workload);
if (compiled === null) throw new Error('the teams-authentication pack is missing');
const pack: CompiledPack = compiled;

const engineCtx: EngineContext = {
  tenantId: 'tenant_unit',
  caseId: 'case_unit_one',
  runId: 'run_unit_1',
  now: '2026-01-15T09:00:00.000Z',
  createdBy: 'system:analysis',
  seed: 'unit-seed',
};
const analysis = runDeterministicAnalysis({
  view: createFullView(normalized.events, normalized.resolution),
  pack,
  config: DEFAULT_ACTION_VALUE_CONFIG,
  ctx: engineCtx,
});
const earliestFork = analysis.forks.find((candidate) => candidate.isEarliestMeaningful);
if (earliestFork === undefined) throw new Error('Case One has no earliest meaningful fork');
const fork: DecisionFork = earliestFork;

const sourceWith = (
  events: readonly CaseEvent[] = normalized.events,
  resolution = normalized.resolution,
): GenerationSource => ({
  analysis,
  engineCtx,
  inputs: { events, resolution, pack, actionConfig: DEFAULT_ACTION_VALUE_CONFIG },
});

const generated = generateForFork(sourceWith(), fork, COUNTERFACTUAL_STRATEGIES);
const balancedScenario = generated.scenarios.find((s) => s.strategy === 'balanced');
if (balancedScenario === undefined) throw new Error('the engine produced no balanced scenario');
const balanced: CounterfactualScenario = balancedScenario;
const firstStep = balanced.steps[0];
if (firstStep === undefined) throw new Error('the balanced scenario has no steps');
const rest = balanced.steps.slice(1);

describe('the default scenario plan', () => {
  it('gives the earliest meaningful fork every strategy and the other eligible forks the balanced one', () => {
    const plan = defaultScenarioPlan(analysis.forks);
    expect(plan[0]?.fork.id).toBe(fork.id);
    expect(plan[0]?.strategies).toEqual(COUNTERFACTUAL_STRATEGIES);
    for (const item of plan.slice(1)) expect(item.strategies).toEqual(['balanced']);
    expect(plan.map((item) => item.fork.id).sort()).toEqual(
      analysis.forks
        .filter((f) => f.eligibility.eligible)
        .map((f) => f.id)
        .sort(),
    );
  });

  it('skips forks the engine found ineligible and caps the number of simulated forks', () => {
    const ineligible = analysis.forks.map((f, index) =>
      index === 1 ? { ...f, eligibility: { ...f.eligibility, eligible: false } } : f,
    );
    expect(
      defaultScenarioPlan(ineligible).some((item) => item.fork.id === analysis.forks[1]?.id),
    ).toBe(false);
    const many = Array.from({ length: MAX_DEFAULT_FORKS + 5 }, (_, i) => ({
      ...fork,
      id: `fork_copy_${i}`,
      isEarliestMeaningful: i === 3,
    }));
    const plan = defaultScenarioPlan(many);
    expect(plan).toHaveLength(MAX_DEFAULT_FORKS);
    expect(plan[0]?.fork.id).toBe('fork_copy_3');
  });

  it('orders strategies canonically and drops duplicates', () => {
    expect(orderStrategies(['fastest_diagnosis', 'balanced', 'fastest_diagnosis'])).toEqual([
      'balanced',
      'fastest_diagnosis',
    ]);
    expect(orderStrategies([])).toEqual([]);
  });
});

describe('temporal integrity of the pure generator', () => {
  const eventIndex = normalized.events.findIndex((e) => e.id === fork.eventId);
  const later = new Set(normalized.events.slice(eventIndex).map((e) => e.id));

  it('uses exactly the events recorded before the decision, at the fork’s decision time', () => {
    const before = normalized.events.slice(0, eventIndex).map((e) => e.id);
    for (const scenario of generated.scenarios) {
      expect(scenario.boundary.asOf).toBe(fork.timestamp);
      expect(scenario.boundary.eventIds).toEqual(before);
      expect(scenario.boundary.eventCount).toBe(before.length);
      expect(scenario.boundary.leakCheck).toMatchObject({
        passed: true,
        futureReferencesFound: 0,
        resolutionExcluded: true,
      });
      expect(scenario.status).toBe('completed');
      expect(scenario.labels).toEqual({ simulated: true, estimated: true });
    }
  });

  it('is not influenced by the later events or the resolution it is handed', () => {
    const poisoned = normalized.events.map((event) =>
      later.has(event.id)
        ? {
            ...event,
            title: `LATE-TITLE resolver-zz.contoso.test`,
            body: `LATE-BODY 10.250.250.250 ERR-ZZ9999 the proxy node px-zz-99.contoso.test is the cause`,
          }
        : event,
    );
    const resolution = normalized.resolution
      ? {
          ...normalized.resolution,
          summary: 'A different story entirely: 10.251.251.251 was the cause.',
          rootCause: 'A completely different root cause at px-zz-98.contoso.test.',
        }
      : null;
    const again = generateForFork(
      sourceWith(poisoned, resolution),
      fork,
      COUNTERFACTUAL_STRATEGIES,
    );
    expect(again.scenarios).toEqual(generated.scenarios);
    for (const scenario of again.scenarios) {
      const text = JSON.stringify(scenario);
      expect(text).not.toMatch(/10\.250\.250\.250|ERR-ZZ9999|px-zz-99|LATE-/);
      expect(scenario.boundary.leakCheck.passed).toBe(true);
    }
  });

  it('keeps hindsight apart: it is returned next to the scenarios and never inside them', () => {
    expect(generated.hindsight).toHaveLength(generated.scenarios.length);
    for (const [index, check] of generated.hindsight.entries()) {
      expect(check.scenarioId).toBe(generated.scenarios[index]?.id);
      expect(check.usedFinalResolution).toBe(true);
    }
    expect(JSON.stringify(generated.scenarios)).not.toMatch(/usedFinalResolution|Post-hoc/);
  });
});

describe('what counts as the same simulation', () => {
  it('ignores the run, the model execution, the review, the wording of the steps and the bookkeeping', () => {
    const rebooked: CounterfactualScenario = {
      ...balanced,
      analysisRunId: 'run_other',
      modelExecutionId: 'exec_other',
      reviewState: 'confirmed',
      reviewedBy: 'someone',
      version: 7,
      updatedAt: '2030-01-01T00:00:00.000Z',
      boundary: {
        ...balanced.boundary,
        leakCheck: { ...balanced.boundary.leakCheck, checkedAt: '2030-01-01T00:00:00.000Z' },
      },
    };
    expect(sameSimulation(balanced, rebooked)).toBe(true);
    // A validated model proposal may reword a step; the simulated path is still the same one.
    const reworded: CounterfactualScenario = {
      ...balanced,
      steps: [{ ...firstStep, rationale: 'A model worded this step differently.' }, ...rest],
    };
    expect(sameSimulation(balanced, reworded)).toBe(true);
  });

  it('is a different simulation as soon as an action, a number, the seed or a check changes', () => {
    const variants: Record<string, CounterfactualScenario> = {
      action: { ...balanced, steps: [{ ...firstStep, actionKey: 'act.other' }, ...rest] },
      'step count': { ...balanced, steps: rest },
      number: {
        ...balanced,
        counterfactualMetrics: {
          ...balanced.counterfactualMetrics,
          operationalRisk: balanced.counterfactualMetrics.operationalRisk + 0.01,
        },
      },
      seed: { ...balanced, rollouts: { ...balanced.rollouts, seed: 'another-seed' } },
      status: { ...balanced, status: 'rejected' },
      'leak check': {
        ...balanced,
        boundary: {
          ...balanced.boundary,
          leakCheck: { ...balanced.boundary.leakCheck, passed: false },
        },
      },
      summary: { ...balanced, summary: 'changed' },
    };
    for (const [what, variant] of Object.entries(variants)) {
      expect(sameSimulation(balanced, variant), what).toBe(false);
    }
  });

  it('keeps a reviewer’s decision only when the regenerated simulation is identical', () => {
    const accepted: CounterfactualScenario = {
      ...balanced,
      reviewState: 'confirmed',
      reviewReason: 'Looked realistic.',
      reviewedBy: 'user_riley_reviewer',
      reviewedAt: '2026-01-15T10:00:00.000Z',
    };
    const regenerated = { ...balanced, analysisRunId: 'run_unit_2', modelExecutionId: 'exec_2' };
    expect(carryReview(accepted, regenerated)).toMatchObject({
      reviewState: 'confirmed',
      reviewReason: 'Looked realistic.',
      reviewedBy: 'user_riley_reviewer',
      analysisRunId: 'run_unit_2',
      modelExecutionId: 'exec_2',
    });
    const different = { ...regenerated, summary: 'changed', steps: balanced.steps.slice(1) };
    expect(carryReview(accepted, different).reviewState).toBe('pending');
  });
});

describe('carrying reviews through a regeneration', () => {
  const decision = {
    reviewReason: 'A reason a person wrote.',
    reviewedBy: 'user_riley_reviewer',
    reviewedAt: '2026-01-15T10:00:00.000Z',
  };
  const stored = (state: CounterfactualScenario['reviewState']): CounterfactualScenario => ({
    ...balanced,
    ...decision,
    reviewState: state,
    version: 2,
  });
  // What a later run produces: the same engine output under a new run, so a pending scenario.
  const regenerated: CounterfactualScenario = {
    ...balanced,
    analysisRunId: 'run_unit_2',
    version: 1,
  };
  const changed: CounterfactualScenario = {
    ...regenerated,
    rollouts: { ...balanced.rollouts, seed: 'another-seed' },
  };
  const other = generated.scenarios.find((s) => s.strategy === 'fastest_diagnosis');
  if (other === undefined) throw new Error('the engine produced no fastest_diagnosis scenario');

  it('tells a decided scenario from one that is still waiting', () => {
    expect(isDecided(balanced)).toBe(false);
    for (const state of ['confirmed', 'rejected', 'corrected'] as const) {
      expect(isDecided(stored(state)), state).toBe(true);
    }
  });

  it('keeps an accepted and a rejected decision when the simulation is the same', () => {
    for (const state of ['confirmed', 'rejected'] as const) {
      const plan = planReviewCarry([stored(state)], [regenerated]);
      expect(plan.carried).toEqual([stored(state)]);
      expect(plan.reset).toEqual([]);
      // The regenerated scenario, with the decision: its run and version are the new ones.
      expect(plan.scenarios).toEqual([{ ...regenerated, ...decision, reviewState: state }]);
    }
  });

  it('keeps the decision when only the wording of a step differs', () => {
    const reworded: CounterfactualScenario = {
      ...regenerated,
      steps: [{ ...firstStep, rationale: 'Reworded by a model.' }, ...rest],
    };
    const plan = planReviewCarry([stored('confirmed')], [reworded]);
    expect(plan.reset).toEqual([]);
    expect(plan.scenarios[0]).toMatchObject({ reviewState: 'confirmed', ...decision });
    expect(plan.scenarios[0]?.steps[0]?.rationale).toBe('Reworded by a model.');
  });

  it('resets the decision, and says so, when the simulation changed', () => {
    const plan = planReviewCarry([stored('confirmed')], [changed]);
    expect(plan.carried).toEqual([]);
    expect(plan.reset).toEqual([stored('confirmed')]);
    expect(plan.scenarios).toEqual([changed]);
    expect(plan.scenarios[0]).toMatchObject({
      reviewState: 'pending',
      reviewReason: null,
      reviewedBy: null,
      reviewedAt: null,
    });
  });

  it('has nothing to carry or reset for a scenario nobody decided on, or one that is new', () => {
    const waiting = planReviewCarry([balanced], [changed]);
    expect(waiting).toEqual({ scenarios: [changed], carried: [], reset: [] });
    const fresh = planReviewCarry([], [regenerated]);
    expect(fresh).toEqual({ scenarios: [regenerated], carried: [], reset: [] });
  });

  it('plans only what was regenerated and leaves other stored scenarios alone', () => {
    const plan = planReviewCarry(
      [stored('confirmed'), { ...other, ...decision, reviewState: 'rejected' }],
      [regenerated],
    );
    expect(plan.scenarios.map((s) => s.id)).toEqual([balanced.id]);
    expect(plan.carried.map((s) => s.id)).toEqual([balanced.id]);
    expect(plan.reset).toEqual([]);
  });

  it('decides each scenario on its own', () => {
    const regeneratedOther: CounterfactualScenario = {
      ...other,
      analysisRunId: 'run_unit_2',
      version: 1,
      rollouts: { ...other.rollouts, seed: 'another-seed' },
    };
    const plan = planReviewCarry(
      [stored('confirmed'), { ...other, ...decision, reviewState: 'rejected' }],
      [regenerated, regeneratedOther],
    );
    expect(plan.scenarios.map((s) => s.reviewState)).toEqual(['confirmed', 'pending']);
    expect(plan.carried.map((s) => s.id)).toEqual([balanced.id]);
    expect(plan.reset.map((s) => s.id)).toEqual([other.id]);
  });
});

describe('who may accept a scenario', () => {
  it('lets a completed, valid, leak-free scenario be accepted', () => {
    expect(acceptanceBlockers(balanced)).toEqual([]);
  });

  it('lists every reason the engine gave against a scenario it rejected', () => {
    const rejected: CounterfactualScenario = {
      ...balanced,
      status: 'rejected',
      validity: {
        valid: false,
        checks: [{ id: 'steps-safe', passed: false, detail: 'A step is destructive.' }],
      },
      boundary: {
        ...balanced.boundary,
        leakCheck: { ...balanced.boundary.leakCheck, passed: false, futureReferencesFound: 2 },
      },
    };
    const blockers = acceptanceBlockers(rejected).join(' ');
    expect(blockers).toMatch(/marked the scenario rejected/);
    expect(blockers).toMatch(/failed validity checks \(steps-safe\)/);
    expect(blockers).toMatch(/temporal leak check/);
  });
});

describe('model wording', () => {
  const proposalFor = (scenario: CounterfactualScenario) =>
    projectScenario(scenario, { fork, strategy: scenario.strategy, pack });
  const run = (
    proposal: SimulatorRun['proposal'],
    source: SimulatorRun['source'],
  ): SimulatorRun => ({
    strategy: 'balanced',
    modelExecutionId: 'exec_unit_1',
    source,
    proposal,
  });
  const tokens = futureTokensFor(
    { events: normalized.events, resolution: normalized.resolution, pack },
    fork,
  );
  const finalize = (r: SimulatorRun) =>
    finalizeScenario({ scenario: balanced, run: r, fork, pack, futureTokens: () => tokens });
  const withRationale = (text: string, order = 1) => {
    const base = proposalFor(balanced);
    return {
      ...base,
      steps: base.steps.map((s) => (s.order === order ? { ...s, rationale: text } : s)),
    };
  };

  it('links the execution and changes nothing else when the engine’s own result came back', () => {
    for (const source of ['deterministic', 'deterministic_fallback'] as const) {
      expect(finalize(run(withRationale('Different wording.'), source))).toEqual({
        ...balanced,
        modelExecutionId: 'exec_unit_1',
      });
    }
    expect(finalize(run(null, null))).toEqual({ ...balanced, modelExecutionId: 'exec_unit_1' });
  });

  it('lets a validated model proposal contribute the rationale of a step, and nothing else', () => {
    const text = 'Start with the cheapest scoping request: it unlocks the log check.';
    for (const source of ['model', 'cache'] as const) {
      const result = finalize(run(withRationale(text), source));
      expect(result.steps[0]?.rationale).toBe(text);
      expect(result.steps.slice(1)).toEqual(balanced.steps.slice(1));
      // Numbers, ids, checks and status are the engine's, untouched.
      expect({ ...result, steps: [], modelExecutionId: null }).toEqual({
        ...balanced,
        steps: [],
        modelExecutionId: null,
      });
      expect(result.steps[0]).toEqual({ ...balanced.steps[0], rationale: text });
    }
  });

  it('refuses wording that names something only known after the decision moment', () => {
    const [token] = [...tokens];
    expect(token).toBeDefined();
    const result = finalize(run(withRationale(`Check ${token} first.`), 'model'));
    expect(result.steps).toEqual(balanced.steps);
  });

  it('ignores wording that does not line up with the engine’s steps, strategy or fork', () => {
    const base = proposalFor(balanced);
    const wrongAction = {
      ...base,
      steps: base.steps.map((s, i) =>
        i === 0 ? { ...s, actionKey: 'act.other', rationale: 'x y z' } : s,
      ),
    };
    expect(finalize(run(wrongAction, 'model')).steps).toEqual(balanced.steps);
    expect(finalize(run({ ...base, strategy: 'fastest_diagnosis' }, 'model')).steps).toEqual(
      balanced.steps,
    );
    expect(finalize(run({ ...base, forkEventId: 'evt_other' }, 'model')).steps).toEqual(
      balanced.steps,
    );
    expect(finalize(run({ ...base, steps: [] }, 'model')).steps).toEqual(balanced.steps);
  });

  it('does not rewrite a step whose wording is the engine’s own projection', () => {
    expect(finalize(run(proposalFor(balanced), 'model')).steps).toEqual(balanced.steps);
  });
});

describe('the bounded cache', () => {
  it('evicts the least recently used entry first', () => {
    const cache = new LruCache<number>(2);
    cache.set('a', 1, 0);
    cache.set('b', 2, 0);
    expect(cache.get('a', 0)).toBe(1); // a is now the most recently used
    cache.set('c', 3, 0);
    expect(cache.get('b', 0)).toBeUndefined();
    expect(cache.get('a', 0)).toBe(1);
    expect(cache.get('c', 0)).toBe(3);
    expect(cache.size).toBe(2);
  });

  it('expires entries after the time to live, using the time it is given', () => {
    const cache = new LruCache<string>(4, 1000);
    cache.set('k', 'v', 5_000);
    expect(cache.get('k', 5_999)).toBe('v');
    expect(cache.get('k', 6_000)).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('computes a missing value once and rejects a cache without room', async () => {
    const cache = new LruCache<number>(2);
    let calls = 0;
    const compute = () => {
      calls += 1;
      return Promise.resolve(42);
    };
    expect(await cache.getOrCompute('x', 0, compute)).toBe(42);
    expect(await cache.getOrCompute('x', 0, compute)).toBe(42);
    expect(calls).toBe(1);
    expect(() => new LruCache<number>(0)).toThrow(RangeError);
  });
});

// Documents what the leak guard is made of, so a change to the engine's definition is noticed here.
describe('what counts as knowledge from the future', () => {
  it('is computed from the events after the decision and from the resolution only', () => {
    const view = createTemporalViewBeforeEvent(normalized.events, fork.eventId);
    expect(view.resolution).toBeNull();
    expect(
      futureTokensFor({ events: normalized.events, resolution: null, pack }, fork).size,
    ).toBeLessThanOrEqual(tokensWithResolution().size);
  });

  function tokensWithResolution() {
    return futureTokensFor(
      { events: normalized.events, resolution: normalized.resolution, pack },
      fork,
    );
  }
});
