import { describe, expect, it } from 'vitest';
import {
  CounterfactualScenarioSchema,
  HindsightCheckSchema,
  type CaseEvent,
  type CaseResolution,
  type DecisionFork,
} from '@caseguard/schemas';
import {
  assembleScenario,
  createFullView,
  createTemporalView,
  createTemporalViewBeforeEvent,
  futureOnlyTokens,
  generateCounterfactuals,
  runDeterministicAnalysis,
  scanForLeaks,
  simulateAlternativePath,
} from '../src';
import { CASE_ONE, CONFIG, eventBySuffix, prepareCase } from './helpers';

const p = prepareCase(CASE_ONE);
const events = p.normalized.events;
const resolution = p.normalized.resolution as CaseResolution;
const forkAt = (suffix: string): DecisionFork => {
  const fork = p.analysis.forks.find((f) => f.eventId === eventBySuffix(p, suffix).id);
  if (!fork) throw new Error(`no fork at ${suffix}`);
  return fork;
};

const POISON =
  'ROOT CAUSE IS A QUANTUM FLUX CAPACITOR AT 192.0.2.77 (host qfc-77.poison.example.net)';

/** Replaces the content of every event after `eventId`, and shifts their timestamps, keeping order. */
function mutateFuture(source: readonly CaseEvent[], eventId: string): CaseEvent[] {
  const cut = source.find((e) => e.id === eventId)?.sequence ?? 0;
  return source.map((e) =>
    e.sequence > cut
      ? {
          ...e,
          body: `${POISON} ${e.sequence}`,
          title: POISON,
          timestamp: new Date(Date.parse(e.timestamp) + 3_600_000).toISOString(),
        }
      : e,
  );
}

describe('as-of equivalence: replaying a prefix reproduces the full analysis (FR-TL-06)', () => {
  const cuts = [4, 8, 14, 20, 26].map((i) => events[i] as CaseEvent);
  for (const cut of cuts) {
    it(`prefix ending at ${cut.id.slice(-3)} equals the full run for everything known by then`, () => {
      const view = createTemporalView(events, cut.timestamp);
      const prefix = runDeterministicAnalysis({ view, pack: p.pack, config: CONFIG, ctx: p.ctx });
      const asOf = cut.timestamp;

      const known = <T extends { observedAt: string }>(xs: readonly T[]) =>
        xs.filter((x) => x.observedAt <= asOf);
      expect(prefix.evidence.map((e) => e.id)).toEqual(known(p.analysis.evidence).map((e) => e.id));
      expect(prefix.links.map((l) => l.id)).toEqual(known(p.analysis.links).map((l) => l.id));

      const strip = (c: (typeof p.analysis.claims)[number]) => [
        c.id,
        c.text,
        c.category,
        c.flags,
        c.timestamp,
        c.confidence,
      ];
      expect(prefix.claims.map(strip)).toEqual(
        p.analysis.claims.filter((c) => c.timestamp <= asOf).map(strip),
      );

      const decisionTimeAction = (a: (typeof p.analysis.actions)[number]) => [
        a.id,
        a.actionKey,
        a.customerEffort,
        a.isRepeat,
        a.repeatOfActionId,
        a.lowValue,
        a.relativeValueAtDecision,
        a.statedHypothesisId,
      ];
      expect(prefix.actions.map(decisionTimeAction)).toEqual(
        p.analysis.actions.filter((a) => a.startedAt <= asOf).map(decisionTimeAction),
      );

      const decisionTimeFork = (f: DecisionFork) => ({
        id: f.id,
        category: f.category,
        extra: f.additionalCategories,
        impact: f.impactScore,
        title: f.title,
        summary: f.summary,
        actual: f.actual,
        available: f.informationAvailable,
        unavailable: f.informationUnavailable,
        posterior: f.posteriorAtDecision,
        alternatives: f.alternatives,
        consequences: f.consequences,
        uncertainty: f.uncertainty,
        eligibility: f.eligibility,
        ruleIds: f.ruleIds,
      });
      expect(prefix.forks.map(decisionTimeFork)).toEqual(
        p.analysis.forks.filter((f) => f.timestamp <= asOf).map(decisionTimeFork),
      );

      for (const h of prefix.hypotheses) {
        const full = p.analysis.hypotheses.find((x) => x.key === h.key);
        for (const point of h.timeline) {
          const match = full?.timeline.find((x) => x.eventId === point.eventId);
          if (match) expect(match).toEqual(point);
        }
        for (const point of full?.timeline.filter((x) => x.at <= asOf) ?? []) {
          expect(h.timeline.some((x) => x.eventId === point.eventId)).toBe(true);
        }
      }
    });
  }
});

describe('counterfactual generation cannot see the future (FR-CF-01, FR-CF-02)', () => {
  const fork = forkAt('e09');
  const base = createTemporalViewBeforeEvent(events, fork.eventId);
  const run = (view: typeof base) =>
    simulateAlternativePath({
      preView: view,
      fork,
      strategy: 'balanced',
      pack: p.pack,
      config: CONFIG,
      ctx: p.ctx,
    });
  const actualMetrics = generateCounterfactuals({
    analysis: p.analysis,
    fork,
    strategies: ['balanced'],
    events,
    resolution,
    pack: p.pack,
    config: CONFIG,
    ctx: p.ctx,
    rolloutCount: 20,
  }).actual.metrics;

  it('mutating every later event leaves the simulated path and metrics byte-identical', () => {
    const mutated = createTemporalViewBeforeEvent(mutateFuture(events, fork.eventId), fork.eventId);
    expect(mutated.fingerprint).toBe(base.fingerprint);
    expect(JSON.stringify(run(mutated))).toBe(JSON.stringify(run(base)));
  });

  it('the boundary view never includes the decision event, later events or the resolution', () => {
    expect(
      base.events.every(
        (e) => e.sequence < (events.find((x) => x.id === fork.eventId)?.sequence ?? 0),
      ),
    ).toBe(true);
    expect(base.resolution).toBeNull();
    expect(() =>
      simulateAlternativePath({
        preView: createFullView(events, resolution) as typeof base,
        fork,
        strategy: 'balanced',
        pack: p.pack,
        config: CONFIG,
        ctx: p.ctx,
      }),
    ).toThrow(/Temporal integrity/);
  });

  it('assembled scenarios record a passing leak check with the resolution excluded', () => {
    const futureTokens = futureOnlyTokens(
      events,
      base,
      `${resolution.rootCause} ${resolution.summary}`,
    );
    const scenario = assembleScenario({
      sim: run(base),
      preView: base,
      fork,
      pack: p.pack,
      config: CONFIG,
      ctx: p.ctx,
      evidence: p.analysis.evidence,
      actualMetrics,
      futureTokens,
    });
    expect(scenario.boundary.leakCheck.passed).toBe(true);
    expect(scenario.boundary.leakCheck.resolutionExcluded).toBe(true);
    expect(scenario.boundary.leakCheck.futureReferencesFound).toBe(0);
    expect(scenario.boundary.eventIds.length).toBe(base.events.length);
    expect(scenario.validity.valid).toBe(true);
  });

  it('the leak detector rejects a scenario that mentions an identifier first seen later', () => {
    const futureTokens = futureOnlyTokens(
      events,
      base,
      `${resolution.rootCause} ${resolution.summary}`,
    );
    expect(futureTokens.size).toBeGreaterThan(0);
    const token = [...futureTokens][0] ?? '';
    expect(scanForLeaks([`Check ${token.toUpperCase()} next`], futureTokens)).toContain(token);

    const sim = run(base);
    const first = sim.steps[0];
    if (!first) throw new Error('expected a simulated step');
    first.outcome = { ...first.outcome, simulatedResult: `Resolver ${token} fails` };
    const tainted = assembleScenario({
      sim,
      preView: base,
      fork,
      pack: p.pack,
      config: CONFIG,
      ctx: p.ctx,
      evidence: p.analysis.evidence,
      actualMetrics,
      futureTokens,
    });
    expect(tainted.boundary.leakCheck.passed).toBe(false);
    expect(tainted.validity.valid).toBe(false);
    expect(tainted.status).toBe('rejected');
  });

  it('generation is independent of the resolution; only the hindsight check uses it', () => {
    const request = {
      analysis: p.analysis,
      fork,
      strategies: ['balanced'] as const,
      events,
      pack: p.pack,
      config: CONFIG,
      ctx: p.ctx,
      rolloutCount: 40,
    };
    const withResolution = generateCounterfactuals({ ...request, resolution });
    const without = generateCounterfactuals({ ...request, resolution: null });
    expect(JSON.stringify(withResolution.scenarios)).toBe(JSON.stringify(without.scenarios));
    expect(withResolution.hindsight[0]?.resolutionHypothesisKey).toBe('hyp.dns-resolution');
    expect(without.hindsight[0]?.resolutionHypothesisKey).toBeNull();
    expect(withResolution.hindsight[0]?.usedFinalResolution).toBe(true);
    const text = JSON.stringify(withResolution.scenarios);
    expect(text).not.toContain('CDN and content delivery');
    expect(text).not.toContain('10.20.1.11');
  });

  it('scenario boundary evidence was observed no later than the decision instant', () => {
    const result = generateCounterfactuals({
      analysis: p.analysis,
      fork,
      strategies: ['balanced'],
      events,
      resolution,
      pack: p.pack,
      config: CONFIG,
      ctx: p.ctx,
      rolloutCount: 20,
    });
    const scenario = result.scenarios[0];
    const evidence = new Map(p.analysis.evidence.map((e) => [e.id, e]));
    for (const id of scenario?.boundary.evidenceIds ?? []) {
      expect((evidence.get(id)?.observedAt ?? '') <= fork.timestamp).toBe(true);
    }
    expect(() => CounterfactualScenarioSchema.parse(scenario)).not.toThrow();
    expect(() => HindsightCheckSchema.parse(result.hindsight[0])).not.toThrow();
  });
});
