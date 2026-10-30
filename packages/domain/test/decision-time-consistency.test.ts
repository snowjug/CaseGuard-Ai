import { beforeAll, describe, expect, it } from 'vitest';
import type {
  CaseEvent,
  CaseResolution,
  CounterfactualScenario,
  CounterfactualStrategy,
  DecisionFork,
  DiagnosticAction,
  InvestigationGraph,
} from '@caseguard/schemas';
import {
  PrefixAnalyzer,
  analyzeView,
  assertPreResolution,
  buildBeliefTimeline,
  buildInvestigationGraph,
  buildTimelineResponse,
  clamp,
  coversWholeCase,
  createFullView,
  createRng,
  createTemporalPrefixView,
  createTemporalView,
  createTemporalViewBeforeEvent,
  decisionTimeSummary,
  futureOnlyTokens,
  generateCounterfactuals,
  inEventOrder,
  isCompleteCase,
  likelihoodOf,
  normalize,
  observationWeight,
  packStaticTokens,
  posteriorBefore,
  posteriorFrom,
  priorBelief,
  round,
  runDeterministicAnalysis,
  scanForLeaks,
  stableId,
  updateBelief,
  type BeliefTimeline,
  type Observation,
  type TemporalView,
} from '../src';
import {
  CASE_ONE,
  CASE_TWO,
  CONFIG,
  NOW,
  eventBySuffix,
  prepareCase,
  type Prepared,
} from './helpers';

const CASES = [
  { name: 'Case One', prepared: prepareCase(CASE_ONE) },
  { name: 'Case Two', prepared: prepareCase(CASE_TWO) },
];
const one = prepareCase(CASE_ONE);
const two = prepareCase(CASE_TWO);

/** The point estimates of a view's own belief timeline (the confidence band never feeds them). */
function timelineOf(
  prepared: Prepared,
  view: TemporalView,
  observations: readonly Observation[],
): BeliefTimeline {
  return buildBeliefTimeline(view, prepared.pack, observations, {
    seed: prepared.ctx.seed,
    samples: 1,
  });
}

const finalPosterior = (timeline: BeliefTimeline) =>
  timeline.steps[timeline.steps.length - 1]?.posterior ?? timeline.prior;

function shuffled<T>(items: readonly T[], seed: string): T[] {
  const rng = createRng(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const a = out[i];
    const b = out[j];
    if (a !== undefined && b !== undefined) {
      out[i] = b;
      out[j] = a;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
describe.each(CASES)(
  '$name: the belief of a view is the last step of its timeline',
  ({ prepared }) => {
    const { pack, ctx, view, analysis } = prepared;
    const all = prepared.normalized.events;

    it('holds exactly at every event instant (an as-of analysis against its own timeline)', () => {
      for (const event of all) {
        const asOfView = createTemporalView(all, event.timestamp);
        const viewAnalysis = analyzeView(asOfView, pack, ctx.caseId);
        const timeline = timelineOf(prepared, asOfView, viewAnalysis.observations);
        // toEqual compares every probability exactly: there is no tolerance in this contract.
        expect(viewAnalysis.belief, `as of ${event.id}`).toEqual(finalPosterior(timeline));
        expect(viewAnalysis.rankingState.belief).toBe(viewAnalysis.belief);
      }
    }, 30_000);

    it('holds for the whole case against the stored timeline', () => {
      expect(analyzeView(view, pack, ctx.caseId).belief).toEqual(finalPosterior(analysis.timeline));
    });

    it('holds for an empty view, whose belief is the prior', () => {
      const empty = createTemporalView(all, '1970-01-01T00:00:00.000Z');
      expect(empty.events).toHaveLength(0);
      expect(analyzeView(empty, pack, ctx.caseId).belief).toEqual(priorBelief(pack));
      expect(timelineOf(prepared, empty, []).prior).toEqual(priorBelief(pack));
    });

    it('holds for seeded random subsets of the events', () => {
      const rng = createRng(`consistency|${prepared.bundle.case.reference}`);
      let checked = 0;
      for (let attempt = 0; attempt < 25; attempt++) {
        const subset = all.filter(() => rng.next() < 0.6);
        if (subset.length === 0) continue;
        const subsetView = createFullView(subset, null);
        const viewAnalysis = analyzeView(subsetView, pack, ctx.caseId);
        const timeline = timelineOf(prepared, subsetView, viewAnalysis.observations);
        expect(viewAnalysis.belief, `subset ${attempt}`).toEqual(finalPosterior(timeline));
        checked++;
      }
      expect(checked).toBeGreaterThan(15);
    }, 30_000);

    it('gives every decision the timeline posterior before its event, as its starting belief', () => {
      expect(analysis.decisions.size).toBeGreaterThan(0);
      for (const decision of analysis.decisions.values()) {
        expect(decision.analysis.belief).toEqual(
          posteriorBefore(analysis.timeline, decision.eventIndex),
        );
        expect(decision.analysis.rankingState.belief).toBe(decision.analysis.belief);
      }
    });

    it('shows the same rounded confidences on every fork as the timeline', () => {
      for (const fork of analysis.forks) {
        const index = view.events.findIndex((e) => e.id === fork.eventId);
        const before = posteriorBefore(analysis.timeline, index);
        expect(fork.posteriorAtDecision.length).toBeGreaterThan(0);
        for (const hypothesis of fork.posteriorAtDecision) {
          expect(hypothesis.confidence).toBe(round(before[hypothesis.key] ?? 0, 3));
        }
      }
    });

    it('is reproduced by the prefix analyser at every boundary, in any order of asking', () => {
      const n = view.events.length;
      const expected = (i: number) => posteriorBefore(analysis.timeline, i);
      const boundaries = Array.from({ length: n + 1 }, (_, i) => i);
      const analyzer = new PrefixAnalyzer(view, pack, ctx.caseId);
      for (const i of boundaries)
        expect(analyzer.at(i).belief, `forwards ${i}`).toEqual(expected(i));
      for (const i of [...boundaries].reverse()) {
        expect(analyzer.at(i).belief, `backwards ${i}`).toEqual(expected(i));
      }
      for (const i of shuffled(boundaries, 'prefix-order')) {
        expect(analyzer.at(i).belief, `shuffled ${i}`).toEqual(expected(i));
      }
    });

    it('is reproduced when whole events are handed over out of order', () => {
      // Events arrive in reverse; the observations inside one event keep their order, as in a timeline.
      const byEvent = new Map<number, Observation[]>();
      for (const obs of analysis.observations) {
        byEvent.set(obs.eventIndex, [...(byEvent.get(obs.eventIndex) ?? []), obs]);
      }
      const reordered = [...byEvent.values()].reverse().flat();
      expect(reordered.map((o) => o.eventIndex)).not.toEqual(
        analysis.observations.map((o) => o.eventIndex),
      );
      const analyzer = new PrefixAnalyzer(view, pack, ctx.caseId, {
        observations: reordered,
        requirementStates: analysis.requirementStates,
      });
      for (let i = 0; i <= view.events.length; i++) {
        expect(analyzer.at(i).belief, `boundary ${i}`).toEqual(
          posteriorBefore(analysis.timeline, i),
        );
      }
    });
  },
);

describe('the one-observation update behind every belief', () => {
  const { pack, analysis } = one;

  it('folds exactly like the timeline does', () => {
    const folded = analysis.observations.reduce(
      (belief, obs) => updateBelief(pack, belief, obs),
      priorBelief(pack),
    );
    expect(posteriorFrom(pack, analysis.observations)).toEqual(folded);
    expect(folded).toEqual(finalPosterior(analysis.timeline));
  });

  it('leaves a belief untouched by an observation that cannot move it', () => {
    const belief = priorBelief(pack);
    const first = analysis.observations[0];
    if (first === undefined) throw new Error('the sample has observations');
    expect(updateBelief(pack, belief, { ...first, affectsBelief: false })).toBe(belief);
    expect(posteriorFrom(pack, [])).toEqual(belief);
    expect(posteriorFrom(pack, [])).not.toBe(belief);
  });

  it('applies the floor after every observation, not once at the end', () => {
    // The previous analysis belief: log-weights accumulated over the whole list, floored once.
    const oneShot = (list: readonly Observation[]): Record<string, number> => {
      const start = priorBelief(pack);
      const logw = pack.hypothesisIds.map((id) => Math.log(Math.max(start[id] ?? 1e-6, 1e-6)));
      for (const obs of list) {
        if (!obs.affectsBelief) continue;
        const w = observationWeight(pack, obs.signalId, obs.repeatIndex);
        pack.hypothesisIds.forEach((id, i) => {
          logw[i] =
            (logw[i] ?? 0) + w * Math.log(clamp(likelihoodOf(pack, obs.signalId, id), 0.01, 0.99));
        });
      }
      const max = Math.max(...logw);
      const probs = normalize(
        normalize(logw.map((l) => Math.exp(l - max))).map((v) =>
          Math.max(v, pack.pack.policies.posteriorFloor),
        ),
      );
      return Object.fromEntries(pack.hypothesisIds.map((id, i) => [id, probs[i] ?? 0]));
    };
    const events = one.normalized.events;
    let widest = 0;
    for (let length = 1; length <= events.length; length++) {
      const upTo = analysis.observations.filter((o) => o.eventIndex < length);
      const old = oneShot(upTo);
      const now = posteriorFrom(pack, upTo);
      for (const id of pack.hypothesisIds) {
        widest = Math.max(widest, Math.abs((old[id] ?? 0) - (now[id] ?? 0)));
      }
    }
    // The two used to differ by a few thousandths, which a reader saw as two different numbers.
    expect(widest).toBeGreaterThan(1e-3);
    expect(posteriorFrom(pack, analysis.observations)).toEqual(finalPosterior(analysis.timeline));
  });

  it('puts observations in the order a timeline applies them: by event, then as listed', () => {
    const base = analysis.observations;
    expect(inEventOrder(base)).toBe(base);
    const reversed = [...base].reverse();
    expect(inEventOrder(reversed).map((o) => o.eventIndex)).toEqual(base.map((o) => o.eventIndex));
    // Observations of one event keep the order they were listed in.
    const byEvent = new Map<number, Observation[]>();
    for (const obs of base)
      byEvent.set(obs.eventIndex, [...(byEvent.get(obs.eventIndex) ?? []), obs]);
    const multi = [...byEvent.values()].find((group) => group.length >= 2);
    const later = [...byEvent.values()].find(
      (group) => (group[0]?.eventIndex ?? 0) > (multi?.[0]?.eventIndex ?? 0),
    );
    if (!multi || !later?.[0]) throw new Error('the sample has an event with several observations');
    const swapped = [...multi].reverse();
    expect(inEventOrder([later[0], ...swapped]).map((o) => o.id)).toEqual(
      [...swapped, later[0]].map((o) => o.id),
    );
  });
});

describe('the rounded confidences agree at the instants the review reported (Case One)', () => {
  for (const suffix of ['e02', 'e03', 'e07', 'e15']) {
    it(`at ${suffix} the analysis belief and the as-of timeline read the same`, () => {
      const asOf = eventBySuffix(one, suffix).timestamp;
      const asOfView = createTemporalView(one.normalized.events, asOf);
      const replay = runDeterministicAnalysis({
        view: asOfView,
        pack: one.pack,
        config: CONFIG,
        ctx: one.ctx,
      });
      const last = replay.timeline.steps[replay.timeline.steps.length - 1];
      const belief = analyzeView(asOfView, one.pack, one.ctx.caseId).belief;
      expect(belief).toEqual(last?.posterior);
      for (const [key, p] of Object.entries(belief)) {
        expect(round(p, 3)).toBe(round(last?.posterior[key] ?? Number.NaN, 3));
      }
    }, 30_000);
  }
});

// ---------------------------------------------------------------------------------------------
// A scenario summary is decision-time only

const STRATEGIES: CounterfactualStrategy[] = [
  'balanced',
  'lowest_customer_effort',
  'fastest_diagnosis',
];
const ROLLOUTS = 40;

const resolutionText = (r: CaseResolution | null): string =>
  r ? `${r.summary} ${r.rootCause} ${r.workaround ?? ''} ${r.permanentFix ?? ''}` : '';

interface Generated {
  prepared: Prepared;
  fork: DecisionFork;
  scenario: CounterfactualScenario;
}

/** Case Two has no detected fork, so the decision moments are the engineer's own actions. */
function pseudoFork(prepared: Prepared, template: DecisionFork, suffix: string): DecisionFork {
  const event = eventBySuffix(prepared, suffix);
  return {
    ...template,
    id: stableId('fork', prepared.ctx.caseId, event.id),
    eventId: event.id,
    timestamp: event.timestamp,
  };
}

let memo: Generated[] | undefined;
function generated(): Generated[] {
  if (memo) return memo;
  const template = one.analysis.forks[0];
  if (!template) throw new Error('Case One has forks');
  const sources: [Prepared, DecisionFork[]][] = [
    [one, one.analysis.forks],
    [two, ['g02', 'g03', 'g05', 'g08'].map((suffix) => pseudoFork(two, template, suffix))],
  ];
  memo = sources.flatMap(([prepared, forks]) =>
    forks.flatMap((fork) =>
      generateCounterfactuals({
        analysis: prepared.analysis,
        fork,
        strategies: STRATEGIES,
        events: prepared.normalized.events,
        resolution: prepared.normalized.resolution,
        pack: prepared.pack,
        config: CONFIG,
        ctx: prepared.ctx,
        rolloutCount: ROLLOUTS,
      }).scenarios.map((scenario) => ({ prepared, fork, scenario })),
    ),
  );
  return memo;
}

function pick(predicate: (g: Generated) => boolean = () => true): Generated {
  const found = generated().find(predicate);
  if (!found) throw new Error('scenarios were generated');
  return found;
}

// Generating every scenario is the slow part of this file; do it once, outside any single test's budget.
beforeAll(() => {
  generated();
}, 120_000);

const HINDSIGHT_WORDING = /real case|versus|in reality/i;

const analysisAt = new Map<string, ReturnType<typeof runDeterministicAnalysis>>();
function asOfAnalysis(prepared: Prepared, asOf: string) {
  const key = `${prepared.ctx.caseId}|${prepared.bundle.case.reference}|${asOf}`;
  const hit = analysisAt.get(key);
  if (hit) return hit;
  const asOfView = createTemporalView(prepared.normalized.events, asOf, {
    resolution: prepared.normalized.resolution,
  });
  const built = runDeterministicAnalysis({
    view: asOfView,
    pack: prepared.pack,
    config: CONFIG,
    ctx: prepared.ctx,
  });
  analysisAt.set(key, built);
  return built;
}

function asOfGraph(
  prepared: Prepared,
  asOf: string | null,
  scenario: CounterfactualScenario | null,
): InvestigationGraph {
  const source = asOf === null ? prepared.analysis : asOfAnalysis(prepared, asOf);
  return buildInvestigationGraph({
    caseTitle: prepared.normalized.case.title,
    caseId: prepared.ctx.caseId,
    events: source.view.events,
    analysis: source,
    asOf,
    now: NOW,
    scenario,
  });
}

function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, out);
  else if (value !== null && typeof value === 'object')
    for (const item of Object.values(value)) stringsIn(item, out);
  return out;
}

describe('decisionTimeSummary writes the simulated path and nothing else', () => {
  const source = {
    label: 'Balanced path',
    boundary: { asOf: '2026-03-09T12:10:00Z' },
    steps: [{ label: 'Alpha' }, { label: 'Beta' }, { label: 'Gamma' }, { label: 'Delta' }],
    counterfactualMetrics: { timeToDiagnosisMinutes: { low: 56, mid: 92, high: 190 } },
    rollouts: { diagnosisReachedShare: 0.9 },
  };

  it('names the decision instant, the first three steps and the simulated time range', () => {
    expect(decisionTimeSummary(source)).toBe(
      'From 2026-03-09 12:10 UTC, the “Balanced path” strategy would take 4 steps (Alpha → Beta → Gamma → …) and is simulated to reach a diagnosis in about 1 h 32 min (range 56 min–3 h 10 min). Simulated estimate, not a measurement.',
    );
  });

  it('says "approach" when fewer than half of the rollouts diagnosed, and "step" for one step', () => {
    const text = decisionTimeSummary({
      ...source,
      steps: [{ label: 'Alpha' }],
      rollouts: { diagnosisReachedShare: 0.49 },
    });
    expect(text).toContain('would take 1 step (Alpha) and is simulated to approach a diagnosis');
  });

  it('says so when no step could be ranked', () => {
    expect(decisionTimeSummary({ ...source, steps: [] })).toBe(
      'No supported next step could be ranked from 2026-03-09 12:10 UTC.',
    );
  });

  it('accepts a whole stored scenario and ignores everything it records about the real case', () => {
    const { scenario } = pick();
    const real = { ...scenario, actualMetrics: { ...scenario.actualMetrics }, improvements: {} };
    expect(decisionTimeSummary(real)).toBe(decisionTimeSummary(scenario));
  });
});

describe('a generated scenario summary is decision-time only (both samples)', () => {
  it('generates scenarios on both samples, every one a completed, valid scenario', () => {
    const all = generated();
    expect(all.filter((g) => g.prepared === one).length).toBe(one.analysis.forks.length * 3);
    expect(all.filter((g) => g.prepared === two).length).toBe(4 * 3);
    for (const g of all) {
      expect(g.scenario.status, g.scenario.id).toBe('completed');
    }
  }, 60_000);

  it('never compares the simulated path with the real one', () => {
    for (const { scenario } of generated()) {
      expect(scenario.summary).not.toMatch(HINDSIGHT_WORDING);
      expect(scenario.summary).toBe(decisionTimeSummary(scenario));
      expect(scenario.summary).toMatch(
        /^(From \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC, the “.+” strategy would take \d+ steps? \(.+\) and is simulated to (reach|approach) a diagnosis in about .+ \(range .+–.+\)\. Simulated estimate, not a measurement\.|No supported next step could be ranked from .+\.)$/,
      );
    }
  }, 60_000);

  it('keeps the comparison with the real path in the comparison fields and the hindsight check', () => {
    const { scenario, prepared, fork } = pick();
    expect(scenario.actualMetrics.timeToDiagnosisMinutes.mid).toBeGreaterThan(0);
    expect(scenario.improvements.timeToDiagnosisMinutes).toBeDefined();
    const check = generateCounterfactuals({
      analysis: prepared.analysis,
      fork,
      strategies: ['balanced'],
      events: prepared.normalized.events,
      resolution: prepared.normalized.resolution,
      pack: prepared.pack,
      config: CONFIG,
      ctx: prepared.ctx,
      rolloutCount: ROLLOUTS,
    }).hindsight[0];
    expect(check?.usedFinalResolution).toBe(true);
    expect(check?.actualTimeToDiagnosisMinutes).toBeGreaterThan(0);
  }, 60_000);

  it('is written from the pre-decision view alone: rewriting the future and the resolution changes nothing but the comparison', () => {
    const events = one.normalized.events;
    const resolution = one.normalized.resolution;
    if (!resolution) throw new Error('Case One has a resolution');
    const poison =
      'THE CAUSE WAS A QUANTUM FLUX CAPACITOR AT 192.0.2.77 (qfc-77.poison.example.net)';
    const wrongResolution: CaseResolution = {
      ...resolution,
      summary: poison,
      rootCause: poison,
      workaround: poison,
      permanentFix: poison,
      rootCauseHypothesisKey: 'hyp.proxy-egress',
    };
    for (const fork of [0, 4, 8].map((i) => one.analysis.forks[i])) {
      if (!fork) continue;
      const cut = events.find((e) => e.id === fork.eventId)?.sequence ?? 0;
      const rewritten: CaseEvent[] = events.map((e) =>
        e.sequence > cut
          ? {
              ...e,
              body: `${poison} ${e.sequence}`,
              title: poison,
              timestamp: new Date(Date.parse(e.timestamp) + 3_600_000).toISOString(),
            }
          : e,
      );
      const rewrittenAnalysis = runDeterministicAnalysis({
        view: createFullView(rewritten, wrongResolution),
        pack: one.pack,
        config: CONFIG,
        ctx: one.ctx,
      });
      const generate = (analysis: Prepared['analysis'], source: CaseEvent[], r: CaseResolution) =>
        generateCounterfactuals({
          analysis,
          fork,
          strategies: ['balanced'],
          events: source,
          resolution: r,
          pack: one.pack,
          config: CONFIG,
          ctx: one.ctx,
          rolloutCount: ROLLOUTS,
        }).scenarios[0];
      const real = generate(one.analysis, [...events], resolution);
      const changed = generate(rewrittenAnalysis, rewritten, wrongResolution);
      if (!real || !changed) throw new Error('a scenario is generated per strategy');
      const decisionTime = (s: CounterfactualScenario) => ({
        ...s,
        actualMetrics: null,
        improvements: null,
      });
      expect(JSON.stringify(decisionTime(changed))).toBe(JSON.stringify(decisionTime(real)));
      expect(changed.summary).toBe(real.summary);
      // The rewrite does change the real path, so the comparison fields could have leaked into the text.
      expect(JSON.stringify(changed.actualMetrics)).not.toBe(JSON.stringify(real.actualMetrics));
    }
  }, 60_000);
});

describe('the as-of graph and timeline are safe for a scenario (both samples)', () => {
  it('prints no hindsight and no identifier from after the window, for every scenario at its own instant', () => {
    const all = generated();
    expect(all.length).toBeGreaterThan(20);
    for (const { prepared, scenario } of all) {
      const asOf = scenario.boundary.asOf;
      const graph = asOfGraph(prepared, asOf, scenario);
      expect(graph.scenarioId).toBe(scenario.id);
      const outcome = graph.nodes.find((n) => n.id === `outcome:sim:${scenario.id}`);
      expect(outcome?.detail).toBe(decisionTimeSummary(scenario));
      expect(outcome?.simulated).toBe(true);

      const windowView = createTemporalView(prepared.normalized.events, asOf);
      assertPreResolution(windowView);
      const future = futureOnlyTokens(
        prepared.normalized.events,
        windowView,
        resolutionText(prepared.normalized.resolution),
        packStaticTokens(prepared.pack),
      );
      const text = stringsIn(graph);
      expect(scanForLeaks(text, future), scenario.id).toEqual([]);
      expect(text.filter((t) => HINDSIGHT_WORDING.test(t))).toEqual([]);
    }
  }, 120_000);

  it('does not print a stored summary at all: a hindsight-laden one (an older run) is replaced', () => {
    const { prepared, scenario } = pick((g) => g.prepared === one);
    const legacy: CounterfactualScenario = {
      ...scenario,
      summary:
        'Simulated 3 h versus 3 days in the real case; the root cause was resolver 10.20.1.11 (aadsts50074).',
    };
    const graph = asOfGraph(prepared, scenario.boundary.asOf, legacy);
    const text = stringsIn(graph).join('\n');
    expect(text).not.toContain('10.20.1.11');
    expect(text).not.toMatch(/real case|aadsts50074/i);
    expect(graph.nodes.find((n) => n.id === `outcome:sim:${scenario.id}`)?.detail).toBe(
      decisionTimeSummary(scenario),
    );
  }, 60_000);

  it('shows the same decision-time text in the whole-record graph', () => {
    const { prepared, scenario } = pick((g) => g.prepared === one);
    const graph = asOfGraph(prepared, null, scenario);
    expect(graph.nodes.find((n) => n.id === `outcome:sim:${scenario.id}`)?.detail).toBe(
      scenario.summary,
    );
  });

  it('withholds a scenario until its decision instant has been reached (graph and timeline)', () => {
    const { prepared, scenario } = pick((g) => g.prepared === one);
    const before = new Date(Date.parse(scenario.boundary.asOf) - 60_000).toISOString();
    const early = asOfGraph(prepared, before, scenario);
    expect(early.scenarioId).toBeNull();
    expect(early.nodes.some((n) => n.simulated)).toBe(false);
    const timelineAt = (asOf: string) =>
      buildTimelineResponse({
        caseRecord: prepared.normalized.case,
        events: prepared.normalized.events,
        analysis: prepared.analysis,
        asOf,
        scenario,
      });
    expect(timelineAt(before).simulatedEvents).toEqual([]);
    expect(timelineAt(scenario.boundary.asOf).simulatedEvents).toHaveLength(scenario.steps.length);
    expect(
      asOfGraph(prepared, scenario.boundary.asOf, scenario).nodes.some((n) => n.simulated),
    ).toBe(true);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
// "Retrospectively produced little information" is a judgement about the complete, resolved case

const RETROSPECTIVE = /^Retrospectively produced little information/;
const withRetrospectiveReason = (actions: readonly DiagnosticAction[]) =>
  actions.filter((a) => a.lowValueReasons.some((reason) => RETROSPECTIVE.test(reason)));
const withoutRetrospective = (action: DiagnosticAction): DiagnosticAction => ({
  ...action,
  lowValueReasons: action.lowValueReasons.filter((reason) => !RETROSPECTIVE.test(reason)),
});
const analyseWith = (prepared: Prepared, view: TemporalView) =>
  runDeterministicAnalysis({ view, pack: prepared.pack, config: CONFIG, ctx: prepared.ctx });

describe('coversWholeCase', () => {
  const events = one.normalized.events;
  const last = events[events.length - 1];
  const first = events[0];

  it('is true only for an inclusive view with nothing withheld', () => {
    expect(coversWholeCase(one.view)).toBe(true);
    expect(coversWholeCase(createFullView(events, null))).toBe(true);
    expect(coversWholeCase(createTemporalView(events, last?.timestamp ?? ''))).toBe(true);
  });

  it('is false for every prefix, decision-moment and boundary view', () => {
    expect(coversWholeCase(createTemporalView(events, first?.timestamp ?? ''))).toBe(false);
    expect(coversWholeCase(createTemporalView(events, eventBySuffix(one, 'e15').timestamp))).toBe(
      false,
    );
    expect(
      coversWholeCase(createTemporalViewBeforeEvent(events, eventBySuffix(one, 'e15').id)),
    ).toBe(false);
    expect(coversWholeCase(createTemporalPrefixView(one.view, 10))).toBe(false);
    expect(coversWholeCase(createTemporalPrefixView(one.view, events.length))).toBe(false);
    // Everything is visible, but a decision-moment ("before") boundary is not the whole record.
    expect(
      coversWholeCase(createTemporalView(events, '2999-01-01T00:00:00Z', { mode: 'before' })),
    ).toBe(false);
  });
});

describe('isCompleteCase', () => {
  const events = one.normalized.events;
  const last = events[events.length - 1];
  const resolution = one.normalized.resolution;

  it('is true for the whole record of a resolved case (both samples)', () => {
    for (const { prepared } of CASES) {
      expect(prepared.normalized.resolution).not.toBeNull();
      expect(isCompleteCase(prepared.view)).toBe(true);
    }
  });

  it('is false for the same events without their recorded resolution: an open case', () => {
    for (const { prepared } of CASES) {
      const open = createFullView(prepared.normalized.events, null);
      expect(open.resolution).toBeNull();
      // Every event is visible, which is why the events alone cannot tell an open case apart.
      expect(coversWholeCase(open)).toBe(true);
      expect(isCompleteCase(open)).toBe(false);
    }
  });

  it('needs the resolution to be inside the boundary, not merely supplied', () => {
    if (!resolution || !last) throw new Error('Case One is resolved and has events');
    const later: CaseResolution = { ...resolution, resolvedAt: '2026-03-13T00:00:00Z' };
    // At the last event a resolution recorded after it is not known yet ...
    const atLast = createTemporalView(events, last.timestamp, { resolution: later });
    expect(atLast.withheldFutureEventCount).toBe(0);
    expect(atLast.resolution).toBeNull();
    expect(isCompleteCase(atLast)).toBe(false);
    // ... and once the boundary reaches it the case is complete.
    expect(isCompleteCase(createFullView(events, later))).toBe(true);
    // The other way round: the resolution is in view but an event recorded after it is withheld.
    const atResolution = createTemporalView(events, resolution.resolvedAt, { resolution });
    expect(atResolution.resolution).not.toBeNull();
    expect(atResolution.withheldFutureEventCount).toBeGreaterThan(0);
    expect(isCompleteCase(atResolution)).toBe(false);
  });

  it('is false for every prefix, decision-moment and boundary view, resolution supplied or not', () => {
    const e15 = eventBySuffix(one, 'e15');
    for (const options of [{}, { resolution }]) {
      expect(isCompleteCase(createTemporalView(events, e15.timestamp, options))).toBe(false);
    }
    expect(isCompleteCase(createTemporalViewBeforeEvent(events, e15.id))).toBe(false);
    expect(isCompleteCase(createTemporalPrefixView(one.view, events.length))).toBe(false);
    expect(
      isCompleteCase(
        createTemporalView(events, '2999-01-01T00:00:00Z', { mode: 'before', resolution }),
      ),
    ).toBe(false);
  });
});

describe('the retrospective low-value reason is produced for the complete case only', () => {
  it('is still produced, exactly as before, when a resolved case is analysed whole', () => {
    const idsOf = (prepared: Prepared) =>
      withRetrospectiveReason(prepared.analysis.actions).map((a) => a.eventId.slice(-3));
    expect(idsOf(one)).toEqual(['e05', 'e11', 'e13', 'e16', 'e19', 'e23']);
    expect(idsOf(two)).toEqual(['g02', 'g03', 'g05']);
    for (const { prepared } of CASES) {
      for (const action of withRetrospectiveReason(prepared.analysis.actions)) {
        const reason = action.lowValueReasons.find((r) => RETROSPECTIVE.test(r)) ?? '';
        expect(reason).toMatch(/\(\d+(\.\d+)? bits\)\.$/);
      }
    }
  });

  it('is never produced for an open case: the same events without the recorded resolution', () => {
    for (const { prepared } of CASES) {
      const open = analyseWith(prepared, createFullView(prepared.normalized.events, null));
      expect(withRetrospectiveReason(open.actions)).toEqual([]);
      // The note is the only thing the resolution decides: every other field is identical.
      expect(open.actions).toEqual(prepared.analysis.actions.map(withoutRetrospective));
      expect(open.timeline).toEqual(prepared.analysis.timeline);
      expect(open.forks).toEqual(prepared.analysis.forks);
    }
  }, 60_000);

  it('is never produced for an open case whose last action has no answer yet', () => {
    // The artefact the rule exists for: the record ends right after a diagnostic request, so its
    // answer is missing only because nothing more has been recorded. The same events do get the
    // note when the case is resolved (hindsight is legitimate there) and do not when it is open.
    for (const { prepared } of CASES) {
      const { events, resolution } = prepared.normalized;
      const flagged = withRetrospectiveReason(prepared.analysis.actions);
      expect(flagged.length).toBeGreaterThan(0);
      for (const action of flagged) {
        const upToAction = events.slice(0, events.findIndex((e) => e.id === action.eventId) + 1);
        const flaggedIn = (view: TemporalView) =>
          withRetrospectiveReason(analyseWith(prepared, view).actions).map((a) => a.eventId);
        expect(flaggedIn(createFullView(upToAction, null)), `open, ${action.eventId}`).toEqual([]);
        expect(
          flaggedIn(createFullView(upToAction, resolution)),
          `resolved, ${action.eventId}`,
        ).toContain(action.eventId);
      }
    }
  }, 120_000);

  it('is never produced for an as-of analysis, at any instant of either sample', () => {
    for (const { prepared } of CASES) {
      const events = prepared.normalized.events;
      for (const event of events.slice(0, -1)) {
        const asOfView = createTemporalView(events, event.timestamp, {
          resolution: prepared.normalized.resolution,
        });
        expect(coversWholeCase(asOfView)).toBe(false);
        expect(isCompleteCase(asOfView)).toBe(false);
        const replay = analyseWith(prepared, asOfView);
        expect(
          withRetrospectiveReason(replay.actions).map((a) => `${event.id}:${a.eventId}`),
        ).toEqual([]);
      }
    }
  }, 120_000);

  it('hides it in the prefix that ends at the very action the complete case flags', () => {
    const flagged = withRetrospectiveReason(one.analysis.actions);
    const firstFlagged = flagged[0];
    if (!firstFlagged) throw new Error('the sample has a retrospectively low-value action');
    const event = one.normalized.events.find((e) => e.id === firstFlagged.eventId);
    const asOfView = createTemporalView(one.normalized.events, event?.timestamp ?? '');
    const replay = runDeterministicAnalysis({
      view: asOfView,
      pack: one.pack,
      config: CONFIG,
      ctx: one.ctx,
    });
    const same = replay.actions.find((a) => a.eventId === firstFlagged.eventId);
    expect(same).toBeDefined();
    expect(same?.lowValueReasons.some((r) => RETROSPECTIVE.test(r))).toBe(false);
  }, 60_000);

  it('does not change whether an action counts as low value', () => {
    // Fork detection filters the retrospective reason out; the flag never depended on it.
    for (const action of one.analysis.actions) {
      const reasons = action.lowValueReasons.filter((r) => !RETROSPECTIVE.test(r));
      if (action.lowValue) expect(reasons.length).toBeGreaterThan(0);
      else expect(reasons).toEqual([]);
    }
  });
});
