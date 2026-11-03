import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { DEFAULT_ACTION_VALUE_CONFIG } from '@caseguard/schemas';
import {
  ACTION_VALUE_FORMULA,
  TEAMS_AUTH_PACK,
  compileKnowledgePack,
  expectedInformationGain,
  outcomeDistributionFor,
  posteriorFrom,
  priorBelief,
  rankActions,
  toBreakdowns,
  topHypotheses,
  type Observation,
  type RankingState,
} from '../src';

const pack = compileKnowledgePack(TEAMS_AUTH_PACK);
const CONFIG = DEFAULT_ACTION_VALUE_CONFIG;
const signalIds = pack.pack.signals.map((s) => s.id);

const observation = (signalId: string, index: number, repeatIndex = 0): Observation => ({
  id: `obs_${signalId}_${index}_${repeatIndex}`,
  signalId,
  eventId: `ev_${index}`,
  eventIndex: index,
  timestamp: '2026-01-01T00:00:00.000Z',
  excerpt: 'synthetic',
  method: 'pattern',
  repeatIndex,
  affectsBelief: true,
  field: null,
  start: null,
  end: null,
  modality: 'asserted',
  cue: null,
  negationOf: null,
});

const observationsArb = fc
  .array(fc.integer({ min: 0, max: signalIds.length - 1 }), { maxLength: 10 })
  .map((indices) => {
    const seen = new Map<string, number>();
    return indices.map((signalIndex, i) => {
      const signalId = signalIds[signalIndex] ?? signalIds[0] ?? '';
      const repeatIndex = seen.get(signalId) ?? 0;
      seen.set(signalId, repeatIndex + 1);
      return observation(signalId, i, repeatIndex);
    });
  });

const stateFrom = (observations: Observation[]): RankingState => ({
  belief: posteriorFrom(pack, observations),
  observedSignals: new Set(observations.map((o) => o.signalId)),
  satisfied: new Set<string>(),
});

describe('belief model (FR-HY-01)', () => {
  it('priors sum to one', () => {
    expect(Object.values(priorBelief(pack)).reduce((s, p) => s + p, 0)).toBeCloseTo(1, 9);
  });

  it('property: a posterior is a probability distribution with the configured floor', () => {
    fc.assert(
      fc.property(observationsArb, (observations) => {
        const posterior = posteriorFrom(pack, observations);
        const values = Object.values(posterior);
        expect(values.reduce((s, p) => s + p, 0)).toBeCloseTo(1, 6);
        for (const p of values) {
          expect(p).toBeGreaterThanOrEqual(pack.pack.policies.posteriorFloor / 2);
          expect(p).toBeLessThanOrEqual(1);
        }
      }),
      { numRuns: 80 },
    );
  });

  it('property: evidence that favours a hypothesis never lowers it beyond the floor (monotonic support)', () => {
    fc.assert(
      fc.property(
        observationsArb,
        fc.integer({ min: 0, max: signalIds.length - 1 }),
        (observations, pick) => {
          const signal = pack.pack.signals[pick];
          if (!signal) return true;
          const best = pack.hypothesisIds.reduce((a, b) =>
            (signal.likelihoods[a] ?? signal.neutral) >= (signal.likelihoods[b] ?? signal.neutral)
              ? a
              : b,
          );
          const before = posteriorFrom(pack, observations);
          const after = posteriorFrom(pack, [
            ...observations,
            observation(signal.id, observations.length, 0),
          ]);
          // A hypothesis at the floor is clamped, so only assert where the clamp cannot interfere.
          if ((before[best] ?? 0) < 0.03) return true;
          // The floor is re-applied after every observation: lifting the smallest hypotheses back to
          // it renormalises everything else, by at most this factor.
          const floorLeak = 1 + (pack.hypothesisIds.length - 1) * pack.pack.policies.posteriorFloor;
          expect(after[best] ?? 0).toBeGreaterThanOrEqual((before[best] ?? 0) / floorLeak - 1e-9);
          return true;
        },
      ),
      { numRuns: 80 },
    );
  });

  it('repeating the same observation counts for less than the first sighting (assumption A-05)', () => {
    const single = posteriorFrom(pack, [observation('sig.error-name-not-resolved', 0, 0)]);
    const doubled = posteriorFrom(pack, [
      observation('sig.error-name-not-resolved', 0, 0),
      observation('sig.error-name-not-resolved', 1, 1),
    ]);
    const prior = priorBelief(pack);
    const firstGain = (single['hyp.dns-resolution'] ?? 0) - (prior['hyp.dns-resolution'] ?? 0);
    const secondGain = (doubled['hyp.dns-resolution'] ?? 0) - (single['hyp.dns-resolution'] ?? 0);
    expect(secondGain).toBeGreaterThan(0);
    expect(secondGain).toBeLessThan(firstGain);
  });

  it('observations flagged as not affecting belief are ignored', () => {
    const ignored = { ...observation('sig.dns-fix-resolved', 0), affectsBelief: false };
    const posterior = posteriorFrom(pack, [ignored]);
    const prior = priorBelief(pack);
    for (const id of pack.hypothesisIds) expect(posterior[id] ?? 0).toBeCloseTo(prior[id] ?? 0, 9);
  });

  it('a clear DNS signature makes DNS the leader', () => {
    const posterior = posteriorFrom(pack, [
      observation('sig.site-correlated', 0),
      observation('sig.error-name-not-resolved', 1),
    ]);
    expect(topHypotheses(posterior, 1)[0]?.id).toBe('hyp.dns-resolution');
  });
});

describe('action value (FR-AV-01, FR-AV-02, FR-AV-03)', () => {
  it('every action outcome distribution is a probability distribution for every hypothesis', () => {
    for (const action of pack.pack.actions) {
      if (action.outcomes.length === 0) continue;
      for (const hypothesis of pack.hypothesisIds) {
        const dist = outcomeDistributionFor(pack, action, hypothesis);
        expect(
          dist.reduce((s, p) => s + p, 0),
          `${action.id}/${hypothesis}`,
        ).toBeCloseTo(1, 9);
        dist.forEach((p) => expect(p).toBeGreaterThanOrEqual(0));
      }
    }
  });

  it('property: expected information gain is never negative and never exceeds the prior entropy', () => {
    const maxBits = Math.log2(pack.hypothesisIds.length);
    fc.assert(
      fc.property(observationsArb, (observations) => {
        const state = stateFrom(observations);
        for (const action of pack.pack.actions) {
          const { bits } = expectedInformationGain(pack, action, state.belief);
          expect(bits).toBeGreaterThanOrEqual(0);
          expect(bits).toBeLessThanOrEqual(maxBits + 1e-9);
        }
      }),
      { numRuns: 40 },
    );
  });

  it('[FR-AV-03] property: no destructive, over-ceiling or premature-remediation action is ever recommended', () => {
    fc.assert(
      fc.property(observationsArb, (observations) => {
        const state = stateFrom(observations);
        const { candidates } = rankActions(pack, CONFIG, state);
        for (const evaluation of candidates) {
          expect(evaluation.action.destructive).toBe(false);
          expect(evaluation.action.operationalRisk).toBeLessThan(CONFIG.riskCeiling);
          expect(evaluation.action.valueClass).not.toBe('remediation');
          expect(evaluation.requiresFirst).toEqual([]);
        }
      }),
      { numRuns: 40 },
    );
  });

  it('ranks by descending score with deterministic tie-breaking', () => {
    const state = stateFrom([observation('sig.site-correlated', 0)]);
    const { candidates } = rankActions(pack, CONFIG, state);
    for (let i = 1; i < candidates.length; i++) {
      expect(candidates[i - 1]?.score ?? 0).toBeGreaterThanOrEqual(candidates[i]?.score ?? 0);
    }
    expect(rankActions(pack, CONFIG, state).candidates.map((c) => c.action.id)).toEqual(
      candidates.map((c) => c.action.id),
    );
  });

  it('[FR-AV-01] breakdowns expose unit-normalised terms, a formula and a safety verdict', () => {
    const state = stateFrom([
      observation('sig.site-correlated', 0),
      observation('sig.error-name-not-resolved', 1),
    ]);
    const { candidates, blocked } = toBreakdowns(pack, CONFIG, state);
    expect(ACTION_VALUE_FORMULA).toMatch(/not a scientific law/i);
    expect(candidates.length).toBeGreaterThan(0);
    expect(blocked.length).toBeGreaterThan(0);
    for (const b of candidates) {
      for (const value of Object.values(b.normalized)) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
      expect(b.relativeScore).toBeGreaterThanOrEqual(0);
      expect(b.relativeScore).toBeLessThanOrEqual(1);
      expect(b.safety.allowed).toBe(true);
      expect(b.rank).toBeGreaterThanOrEqual(1);
    }
    expect(candidates[0]?.relativeScore).toBe(1);
    for (const b of blocked) expect(b.safety.allowed).toBe(false);
  });

  it('[FR-AV-02] sensitivity analysis reports rank ranges that bracket the base rank', () => {
    const state = stateFrom([
      observation('sig.site-correlated', 0),
      observation('sig.error-name-not-resolved', 1),
    ]);
    const { candidates } = toBreakdowns(pack, CONFIG, state);
    for (const b of candidates) {
      expect(b.sensitivity.minRank).toBeLessThanOrEqual(b.rank);
      expect(b.sensitivity.maxRank).toBeGreaterThanOrEqual(b.rank);
      expect(b.sensitivity.scenarios.length).toBeGreaterThan(0);
    }
  });

  it('an action whose outcome is already known has no information value', () => {
    const known = stateFrom([observation('sig.error-name-not-resolved', 0)]);
    const evaluation = rankActions(pack, CONFIG, known).blocked.find(
      (e) => e.action.id === 'act.request-har-capture',
    );
    expect(evaluation?.blockedReasons.join(' ')).toMatch(/Already known/);
  });
});
