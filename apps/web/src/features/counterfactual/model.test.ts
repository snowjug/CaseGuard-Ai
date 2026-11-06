import { describe, expect, it } from 'vitest';
import {
  forkList,
  hypothesesResponse,
  recordedActions,
  scenario,
  scenarioList,
} from '../../../test/reasoning-fixtures';
import {
  METRIC_SPECS,
  acceptanceBlockers,
  bearingsOf,
  comparisonTracks,
  describeImprovement,
  headlineImprovements,
  metricDeltas,
  resolveSelection,
  scenariosOfFork,
  strategiesConverge,
  timeSaved,
  withheldAfterBoundary,
} from './model';

const forks = forkList().items;
const [fork1, fork2] = forks as [(typeof forks)[number], (typeof forks)[number]];

describe('counterfactual model: scenarios and selection', () => {
  it('lists the scenarios of one fork in the canonical strategy order', () => {
    const scenarios = [
      scenario({ id: 'a', strategy: 'fastest_diagnosis' }),
      scenario({ id: 'b', strategy: 'balanced' }),
      scenario({ id: 'c', strategy: 'lowest_customer_effort' }),
      scenario({ id: 'd', forkId: 'fork_2' }),
    ];
    expect(scenariosOfFork(scenarios, 'fork_1').map((s) => s.id)).toEqual(['b', 'c', 'a']);
    expect(scenariosOfFork(scenarios, 'fork_2').map((s) => s.id)).toEqual(['d']);
    expect(scenariosOfFork(scenarios, 'fork_9')).toEqual([]);
  });

  it('shows the earliest meaningful fork and its balanced path when nothing is selected', () => {
    const { fork, scenario: shown } = resolveSelection(forks, scenarioList().items, 'fork_1', null);
    expect(fork?.id).toBe('fork_1');
    expect(shown?.id).toBe('scn_1');
  });

  it('resolves a scenario id (deep link) to its fork and that scenario', () => {
    const { fork, scenario: shown } = resolveSelection(
      forks,
      scenarioList().items,
      'fork_1',
      'scn_2',
    );
    expect(fork?.id).toBe('fork_1');
    expect(shown?.id).toBe('scn_2');
    const other = resolveSelection(forks, scenarioList().items, 'fork_1', 'scn_3');
    expect(other.fork?.id).toBe('fork_2');
    expect(other.scenario?.id).toBe('scn_3');
  });

  it('resolves a fork id to the fork and its first scenario, or to no scenario when none exists yet', () => {
    expect(resolveSelection(forks, scenarioList().items, 'fork_1', 'fork_2').scenario?.id).toBe(
      'scn_3',
    );
    const none = resolveSelection(forks, [], 'fork_1', 'fork_2');
    expect(none.fork?.id).toBe('fork_2');
    expect(none.scenario).toBeNull();
  });

  it('falls back to the earliest fork, then the first fork, then to nothing', () => {
    expect(resolveSelection(forks, [], 'fork_2', 'unknown').fork?.id).toBe('fork_2');
    expect(resolveSelection(forks, [], null, 'unknown').fork?.id).toBe('fork_1');
    expect(resolveSelection([], [], null, null)).toEqual({ fork: null, scenario: null });
  });

  it('knows when every strategy takes the same steps', () => {
    const [balanced, fastest] = scenarioList().items as [
      ReturnType<typeof scenario>,
      ReturnType<typeof scenario>,
    ];
    expect(strategiesConverge([balanced])).toBe(false);
    expect(strategiesConverge([balanced, fastest])).toBe(true);
    const different = { ...fastest, steps: fastest.steps.slice(0, 2) };
    expect(strategiesConverge([balanced, different])).toBe(false);
  });
});

describe('counterfactual model: acceptance and the temporal boundary', () => {
  it('has no blockers for a completed, valid path that passed the no-hindsight check', () => {
    expect(acceptanceBlockers(scenario())).toEqual([]);
  });

  it('names every reason a path cannot be accepted', () => {
    const base = scenario();
    expect(acceptanceBlockers({ ...base, status: 'rejected' })).toEqual([
      'The engine marked the path rejected.',
    ]);
    const invalid = {
      ...base,
      validity: {
        valid: false,
        checks: [{ id: 'boundary-respected', passed: false, detail: 'Used a later event.' }],
      },
    };
    expect(acceptanceBlockers(invalid)).toEqual([
      'It failed validity checks (boundary-respected).',
    ]);
    const leaked = {
      ...base,
      boundary: {
        ...base.boundary,
        leakCheck: { ...base.boundary.leakCheck, passed: false, futureReferencesFound: 2 },
      },
    };
    expect(acceptanceBlockers(leaked)).toEqual(['It did not pass the no-hindsight check.']);
    const unexcluded = {
      ...base,
      boundary: {
        ...base.boundary,
        leakCheck: { ...base.boundary.leakCheck, resolutionExcluded: false },
      },
    };
    expect(acceptanceBlockers(unexcluded)).toEqual(['It did not pass the no-hindsight check.']);
  });

  it('counts the events the boundary withheld', () => {
    expect(withheldAfterBoundary(scenario(), 31)).toBe(29);
    expect(withheldAfterBoundary(scenario(), 1)).toBe(0);
    expect(withheldAfterBoundary(scenario(), null)).toBeNull();
  });

  it('says which hypotheses each piece of evidence supports or contradicts, skipping neutral links', () => {
    const data = hypothesesResponse();
    const bearings = bearingsOf({
      items: data.items,
      links: [
        ...data.links,
        { ...data.links[0]!, id: 'hel_neutral', evidenceId: 'evd_other', polarity: 'neutral' },
      ],
    });
    expect(bearings.get('evd_name')).toEqual([
      { hypothesisName: 'DNS resolution failure for sign-in endpoints', polarity: 'supports' },
    ]);
    expect(bearings.get('evd_policy')).toEqual([
      { hypothesisName: 'Conditional Access or MFA policy enforcement', polarity: 'contradicts' },
    ]);
    expect(bearings.has('evd_other')).toBe(false);
    expect(bearingsOf(undefined).size).toBe(0);
  });
});

describe('counterfactual model: the two paths', () => {
  const tracks = comparisonTracks(fork1, scenario(), recordedActions());

  it('measures both paths from the decision instant', () => {
    expect(tracks.forkStepId).toBe('fork_1');
    expect(tracks.actual.totalMinutes).toBe(2994);
    expect(tracks.counterfactual.totalMinutes).toBe(444);
  });

  it('builds the recorded path from the decision to the diagnosis and leaves out later actions', () => {
    expect(tracks.actual.steps.map((s) => s.kind)).toEqual(['fork', 'action', 'action', 'outcome']);
    expect(tracks.actual.steps.map((s) => s.durationMinutes)).toEqual([0, 119, 51, 2824]);
    expect(tracks.actual.steps.map((s) => s.label)).not.toContain(
      'Recommend removing the failing resolver (after the diagnosis)',
    );
    expect(tracks.recordedActionCount).toBe(3);
  });

  it('marks destructive recorded actions and well-chosen ones differently', () => {
    const statuses = tracks.actual.steps.map((s) => s.status);
    expect(statuses[1]).toBe('productive');
    expect(statuses[2]).toBe('unsupported');
  });

  it('builds the simulated path from its steps and ends at the simulated diagnosis', () => {
    expect(tracks.counterfactual.steps.map((s) => s.label)).toEqual([
      'Ask for minimal scoping data',
      'Correlate failing attempts with Entra sign-in logs',
      'Review Conditional Access configuration',
      'Diagnosis reached (simulated)',
    ]);
    expect(tracks.counterfactual.steps.map((s) => s.durationMinutes)).toEqual([90, 25, 20, 309]);
    const total = tracks.counterfactual.steps.reduce((sum, s) => sum + (s.durationMinutes ?? 0), 0);
    expect(total).toBe(444);
  });

  it('adds no closing marker when the last step already reaches the diagnosis', () => {
    const quick = scenario({
      counterfactualMetrics: {
        ...scenario().counterfactualMetrics,
        timeToDiagnosisMinutes: { low: 100, mid: 135, high: 200 },
      },
    });
    const result = comparisonTracks(fork1, quick, recordedActions());
    expect(result.counterfactual.steps.at(-1)?.kind).toBe('action');
  });

  it('does not use actions before the decision', () => {
    const earlier = recordedActions().map((a) => ({ ...a, startedAt: '2026-03-09T09:00:00Z' }));
    expect(comparisonTracks(fork2, scenario(), earlier).actual.steps.map((s) => s.kind)).toEqual([
      'fork',
      'outcome',
    ]);
  });
});

describe('counterfactual model: metrics and improvements', () => {
  it('compares every metric the specification lists, with the simulated range', () => {
    const deltas = metricDeltas(scenario());
    expect(deltas.map((d) => d.key)).toEqual(METRIC_SPECS.map((spec) => spec.key));
    const diagnosis = deltas.find((d) => d.key === 'timeToDiagnosisMinutes');
    expect(diagnosis).toMatchObject({
      actual: 2994,
      counterfactual: 444,
      low: 197,
      high: 649,
      better: 'lower',
    });
    const risk = deltas.find((d) => d.key === 'operationalRisk');
    expect(risk).toMatchObject({ actual: 0.8, counterfactual: 0.08, low: null, high: null });
    expect(deltas.find((d) => d.key === 'informationGainBits')?.better).toBe('higher');
  });

  it('lists the headline improvements the API computed and nothing it did not', () => {
    expect(headlineImprovements(scenario()).map((line) => line.key)).toEqual([
      'timeToDiagnosisMinutesPct',
      'customerEffortMinutesPct',
      'tokenEstimatePct',
      'operationalRiskPct',
    ]);
    expect(headlineImprovements(scenario({ improvements: {} }))).toEqual([]);
    expect(
      headlineImprovements({ ...scenario(), improvements: { tokenEstimatePct: Number.NaN } }),
    ).toEqual([]);
  });

  it('words an improvement as less or more of something', () => {
    expect(
      describeImprovement({
        key: 'timeToDiagnosisMinutesPct',
        label: 'time to diagnosis',
        fraction: 0.852,
      }),
    ).toBe('85% less time to diagnosis');
    expect(describeImprovement({ key: 'x', label: 'customer effort', fraction: -0.208 })).toBe(
      '21% more customer effort',
    );
  });
});

describe('counterfactual model: the time saved, as a range', () => {
  const withSimulated = (low: number, mid: number, high: number) => {
    const base = scenario();
    return {
      ...base,
      counterfactualMetrics: {
        ...base.counterfactualMetrics,
        timeToDiagnosisMinutes: { low, mid, high },
      },
    };
  };

  it('is a saving only when even the pessimistic end of the simulated range beats what happened', () => {
    expect(timeSaved(scenario())).toEqual({
      verdict: 'faster',
      recorded: 2994,
      simulated: { low: 197, mid: 444, high: 649 },
      saved: { low: 2345, mid: 2550, high: 2797 },
      claimed: true,
    });
  });

  it('never presents a range that includes the recorded time as a saving, and says when it is slower', () => {
    expect(timeSaved(withSimulated(2000, 2800, 3600)).verdict).toBe('unclear');
    expect(timeSaved(withSimulated(3100, 3500, 3900)).verdict).toBe('slower');
    expect(timeSaved(withSimulated(3100, 3500, 3900)).saved.mid).toBe(-506);
  });

  it('claims nothing for an illustration, which the engine marks as claiming no saving', () => {
    const illustration = scenario({
      quality: {
        basis: {
          scenario: 'illustrative',
          summary: 'A worked example.',
          parts: [
            { what: 'Recorded path', basis: 'measured', note: 'Read from the case.' },
            { what: 'Alternative path', basis: 'illustrative', note: 'An example.' },
          ],
        },
        feasibility: { level: 'feasible', reasons: [] },
        constraints: [],
        skillApplicability: { status: 'not_assessed', skills: [], note: 'Not checked.' },
        validation: ['Check it before relying on it.'],
        timeSavedClaim: 'none',
      },
    });
    expect(timeSaved(illustration).claimed).toBe(false);
    // A scenario stored before the engine wrote its quality down keeps leading with its range.
    expect(timeSaved(scenario()).claimed).toBe(true);
  });
});
