import type { CounterfactualScenario, Range } from '@caseguard/schemas';
import { describe, expect, it } from 'vitest';
import { CASE_ONE, CASE_TWO } from '../../../../test/review-fixtures';
import { DECISION_POINTS_SHOWN, deriveDecisionPoints } from './decisions';
import {
  acceptedScenario,
  chooseScenario,
  compareRanges,
  derivePaths,
  describeScenario,
} from './paths';

describe('[REV-DECISION-01] decision points in plain language', () => {
  const points = deriveDecisionPoints(CASE_ONE.forks);

  it('lists them earliest first, numbered from 1, and marks the earliest', () => {
    expect(points).toHaveLength(9);
    expect(points.map((p) => p.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(points.map((p) => p.eventId)).toEqual([
      'e03',
      'e07',
      'e08',
      'e09',
      'e11',
      'e13',
      'e15',
      'e16',
      'e19',
    ]);
    expect(points.filter((p) => p.isEarliest).map((p) => p.number)).toEqual([1]);
    expect(DECISION_POINTS_SHOWN).toBe(3);
  });

  it('says what was known, what was not yet known, what was done and what was better', () => {
    const first = points[0];
    expect(first).toMatchObject({
      title: 'Heavy customer request when a lighter ask was available',
      impactLabel: 'Medium impact',
      categoryLabel: 'Customer effort without proportional value',
      did: {
        label: 'Request HAR and Fiddler traces, full user list and Conditional Access export',
        kindLabel: 'Customer request',
        effortLabel: 'Very high customer effort',
        destructive: false,
      },
      better: {
        label: 'Ask for minimal scoping data',
        kindLabel: 'Customer request',
        effortLabel: 'Low customer effort',
        links: [{ type: 'evidence', id: 'evd_d3340201da14f37674629ae2' }],
      },
    });
    expect(first?.known.eventCount).toBe(2);
    expect(first?.known.evidenceCount).toBe(2);
    expect(first?.known.summary).toMatch(/^2 events and 2 evidence items were on record\./);
    expect(first?.notYetKnown).toContain('Exact client error code or text (not yet collected)');
    expect(first?.uncertainty.levelLabel).toBe('Low uncertainty');
  });

  it('shows what each choice would have cost as the engine’s own estimate, with its wording of the difference', () => {
    const first = points[0];
    expect(first?.estimate.didTime).toBe('4 h (2 h to 8 h)');
    expect(first?.estimate.betterTime).toBe('1 h 30 min (45 min to 3 h)');
    expect(first?.estimate.deltaSummary).toMatch(/^Estimated, not measured:/);
  });

  it('keeps a decision point that has no safe alternative, without inventing one', () => {
    const forks = {
      ...CASE_ONE.forks,
      items: CASE_ONE.forks.items.map((fork) => ({
        ...fork,
        alternatives: [],
        consequences: { ...fork.consequences, bestAlternative: null },
      })),
    };
    const [first] = deriveDecisionPoints(forks);
    expect(first?.better).toBeNull();
    expect(first?.estimate.betterTime).toBeNull();
  });

  it('has nothing to explain for a case without decision points', () => {
    expect(deriveDecisionPoints(CASE_TWO.forks)).toEqual([]);
  });
});

describe('[REV-PATH-01] comparing ranges honestly', () => {
  const recorded = (value: number): Range => ({ low: value, mid: value, high: value });

  it('calls a simulated range better only when even its pessimistic end beats the record', () => {
    expect(compareRanges(recorded(100), { low: 10, mid: 40, high: 99 })).toBe('better');
    expect(compareRanges(recorded(100), { low: 10, mid: 40, high: 100 })).toBe('unclear');
  });

  it('calls it worse only when even its optimistic end is above the record, and unclear otherwise', () => {
    expect(compareRanges(recorded(100), { low: 101, mid: 150, high: 200 })).toBe('worse');
    expect(compareRanges(recorded(100), { low: 100, mid: 150, high: 200 })).toBe('unclear');
    expect(compareRanges(recorded(100), { low: 69, mid: 100, high: 143 })).toBe('unclear');
  });
});

describe('[REV-PATH-02] what should have happened', () => {
  const view = derivePaths(CASE_ONE.forks, CASE_ONE.scenarios);

  it('shows the accepted simulated path at the earliest decision point, labelled as an estimate', () => {
    expect(view.kind).toBe('ready');
    if (view.kind !== 'ready') return;
    const path = view.path;
    expect(path.strategyLabel).toBe('Balanced path');
    expect(path.review).toMatchObject({ state: 'confirmed', label: 'Accepted', accepted: true });
    expect(path.decision).toMatchObject({
      number: 1,
      title: expect.stringMatching(/^Heavy customer request/),
    });
    expect(path.summary).toMatch(/Simulated estimate, not a measurement\.$/);
    expect(path.others.map((o) => o.label).sort()).toEqual([
      'Fastest to diagnosis',
      'Lowest customer effort',
    ]);
  });

  it('reports each measure with the record and the simulated range, and does not call a tie an improvement', () => {
    if (view.kind !== 'ready') throw new Error('expected a ready path');
    const byKey = Object.fromEntries(view.path.rows.map((row) => [row.key, row]));
    expect(byKey.timeToUsefulEvidenceMinutes).toMatchObject({
      recordedText: '1 h 24 min',
      direction: 'unclear',
      directionLabel: 'Within the simulation’s uncertainty',
    });
    expect(byKey.timeToUsefulEvidenceMinutes?.simulatedText).toBe(
      '1 h 40 min (1 h 09 min to 2 h 23 min)',
    );
    expect(byKey.timeToDiagnosisMinutes?.direction).toBe('better');
    expect(byKey.customerInteractions).toMatchObject({
      recordedText: '5',
      simulatedText: '5 (2 to 6)',
      direction: 'unclear',
    });
    expect(byKey.customerEffortMinutes?.direction).toBe('better');
    expect(view.path.headline).toBe(
      'In this simulated estimate, 2 of 4 measures come out better than the record, 2 within the simulation’s uncertainty. Confidence in the comparison is low.',
    );
  });

  it('carries the confidence, the validity checks and the assumptions of the engine', () => {
    if (view.kind !== 'ready') throw new Error('expected a ready path');
    expect(view.path.confidence).toMatchObject({ level: 'low', label: 'Low confidence' });
    expect(view.path.confidence.rationale).toMatch(/^Diagnosis reached in 52% of 200 rollouts/);
    expect(view.path.validity).toMatchObject({
      valid: true,
      passed: 8,
      total: 8,
      leakCheckPassed: true,
    });
    expect(view.path.usable).toBe(true);
    expect(view.path.assumptions).toHaveLength(5);
    expect(view.path.rollouts).toEqual({ count: 200, diagnosisReachedText: '52%' });
    expect(view.path.steps).toHaveLength(8);
    expect(view.path.steps[0]).toMatchObject({
      index: 1,
      label: 'Ask for minimal scoping data',
      ownerLabel: 'Customer admin',
      outcome: expect.any(String),
    });
  });

  it('refuses to call a path usable when it failed a check or the check that it used only what was known then', () => {
    const scenario = CASE_ONE.scenarios[0] as CounterfactualScenario;
    const failed: CounterfactualScenario = {
      ...scenario,
      validity: {
        valid: false,
        checks: scenario.validity.checks.map((check, i) =>
          i === 0 ? { ...check, passed: false } : check,
        ),
      },
      boundary: {
        ...scenario.boundary,
        leakCheck: { ...scenario.boundary.leakCheck, passed: false },
      },
    };
    const path = describeScenario(failed, CASE_ONE.forks, [failed]);
    expect(path.usable).toBe(false);
    expect(path.validity).toMatchObject({ passed: 7, total: 8, leakCheckPassed: false });
    expect(path.problems).toEqual([
      'It failed one or more validity checks.',
      'It did not pass the check that it used only what was known then.',
    ]);
  });

  it('says there is nothing to compare when no decision point stood out', () => {
    expect(derivePaths(CASE_TWO.forks, CASE_TWO.scenarios)).toEqual({ kind: 'no-decision-points' });
  });

  it('says so when the earliest decision point has not been simulated, and whether it can be', () => {
    const none = derivePaths(CASE_ONE.forks, []);
    expect(none).toMatchObject({
      kind: 'not-simulated',
      eligible: true,
      decision: { number: 1, title: expect.stringMatching(/^Heavy customer request/) },
    });
  });

  it('chooses an accepted path, then the balanced one, then the first that completed', () => {
    const [balanced, fastest, lowest] = CASE_ONE.scenarios.filter(
      (s) =>
        s.strategy === 'balanced' ||
        s.strategy === 'fastest_diagnosis' ||
        s.strategy === 'lowest_customer_effort',
    ) as [CounterfactualScenario, CounterfactualScenario, CounterfactualScenario];
    const pending = (s: CounterfactualScenario): CounterfactualScenario => ({
      ...s,
      reviewState: 'pending',
    });
    expect(chooseScenario([pending(balanced), { ...fastest, reviewState: 'corrected' }])?.id).toBe(
      fastest.id,
    );
    expect(chooseScenario([pending(fastest), pending(balanced), pending(lowest)])?.id).toBe(
      balanced.id,
    );
    expect(chooseScenario([pending(fastest), { ...pending(lowest), status: 'failed' }])?.id).toBe(
      fastest.id,
    );
    expect(chooseScenario([])).toBeNull();
    expect(acceptedScenario(CASE_ONE.scenarios)?.reviewState).toBe('confirmed');
    expect(acceptedScenario([pending(balanced)])).toBeNull();
  });
});
