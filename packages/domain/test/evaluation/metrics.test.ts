import { describe, expect, it } from 'vitest';
import { caseInput, engineOutput } from './fixtures';
import {
  actionMeasures,
  caseDetail,
  citationMeasures,
  computeMetrics,
  contradictionMeasures,
  counterfactualMeasures,
  earliestAgreement,
  earliestMeasures,
  forkMeasures,
  hypothesisMeasures,
  invariance,
  leaderAgreement,
  negationMeasures,
  recommendationMeasures,
  rejectionMeasures,
  signalMeasures,
} from './metrics';
import {
  binaryAgreement,
  calibrationOf,
  cohenKappa,
  precisionRecall,
  proportion,
  wilson,
} from './stats';

const INTERMITTENT = 'sig.intermittent-failures';
const TIMEOUT = 'sig.error-timeout';
const PRT_MISSING = 'sig.prt-missing';

describe('statistics', () => {
  it('gives the Wilson 95% interval of a proportion', () => {
    const middle = wilson(5, 10);
    expect(middle?.low).toBeCloseTo(0.2366, 3);
    expect(middle?.high).toBeCloseTo(0.7634, 3);
    expect(wilson(0, 10)?.low).toBe(0);
    expect(wilson(0, 10)?.high).toBeCloseTo(0.2775, 3);
    expect(wilson(10, 10)?.low).toBeCloseTo(0.7225, 3);
    expect(wilson(10, 10)?.high).toBe(1);
    expect(wilson(0, 0)).toBeNull();
  });

  it('marks a proportion with fewer than 20 observations as too few, and one with none as undefined', () => {
    expect(proportion(10, 19).tooFew).toBe(true);
    expect(proportion(10, 20).tooFew).toBe(false);
    const none = proportion(0, 0);
    expect([none.value, none.low, none.tooFew]).toEqual([null, null, true]);
  });

  it('computes precision, recall and F1 from counts, with an undefined side left undefined', () => {
    const baseline = precisionRecall({ tp: 13, fp: 4, fn: 53 });
    expect(baseline.precision.value).toBeCloseTo(13 / 17, 6);
    expect(baseline.recall.value).toBeCloseTo(13 / 66, 6);
    expect(baseline.f1).toBeCloseTo(26 / 83, 6);
    expect(precisionRecall({ tp: 0, fp: 0, fn: 3 }).precision.value).toBeNull();
    expect(precisionRecall({ tp: 0, fp: 0, fn: 3 }).f1).toBeNull();
  });

  it("computes Cohen's kappa and the positive agreement from a 2 x 2 table", () => {
    const table = binaryAgreement({ bothYes: 20, onlyA: 5, onlyB: 10, bothNo: 15 });
    expect(table.n).toBe(50);
    expect(table.observed).toBeCloseTo(0.7, 6);
    expect(table.kappa).toBeCloseTo(0.4, 6);
    expect(table.positiveAgreement).toBeCloseTo(40 / 55, 6);
    expect(
      cohenKappa([
        ['a', 'a'],
        ['b', 'b'],
        ['a', 'a'],
        ['b', 'b'],
      ]).kappa,
    ).toBe(1);
    // Both always say the same one thing: chance agreement is total, so kappa is undefined.
    expect(
      cohenKappa([
        ['a', 'a'],
        ['a', 'a'],
      ]).kappa,
    ).toBeNull();
  });

  it('bins confidences, and scores them with Brier and the expected calibration error', () => {
    const result = calibrationOf([
      { p: 0.9, outcome: true },
      { p: 0.9, outcome: true },
      { p: 0.1, outcome: false },
      { p: 1, outcome: true },
    ]);
    expect(result.n).toBe(4);
    expect(result.brier).toBeCloseTo((0.01 + 0.01 + 0.01 + 0) / 4, 6);
    expect(result.bins[9]?.n).toBe(3);
    expect(
      calibrationOf([
        { p: 0.8, outcome: false },
        { p: 0.8, outcome: false },
      ]).ece,
    ).toBeCloseTo(0.8, 6);
    expect(calibrationOf([]).brier).toBeNull();
  });
});

describe('signals', () => {
  const labels = {
    signals: [
      { event: 'ev01', id: INTERMITTENT },
      { event: 'ev01', id: TIMEOUT },
      { event: 'ev03', id: PRT_MISSING },
    ],
  };

  it('counts reported-and-labelled, reported-only and labelled-only, overall, per signal, per dimension and per category', () => {
    const input = caseInput({
      categories: ['paraphrase', 'noisy'],
      labels,
      engine: { signals: [`ev01|${INTERMITTENT}`, `ev03|${TIMEOUT}`] },
    });
    const result = signalMeasures([input]);
    expect(result.overall).toMatchObject({ tp: 1, fp: 1, fn: 2 });
    expect(result.byId[INTERMITTENT]).toMatchObject({ tp: 1, fp: 0, fn: 0 });
    expect(result.byId[TIMEOUT]).toMatchObject({ tp: 0, fp: 1, fn: 1 });
    expect(result.byDimension['scope']).toMatchObject({ tp: 1 });
    expect(result.byDimension['client-error']).toMatchObject({ fp: 1, fn: 1 });
    expect(result.byDimension['device-state']).toMatchObject({ fn: 1 });
    expect(result.byCategory['paraphrase']).toMatchObject({ tp: 1, fp: 1, fn: 2 });
    expect(result.byCategory['noisy']).toMatchObject({ tp: 1, fp: 1, fn: 2 });
  });

  it('does not count a case without accepted labels, or one the engine refused', () => {
    const reported = { signals: [`ev01|${INTERMITTENT}`] };
    const counted = signalMeasures([
      caseInput({ id: 'ev-d-901-a', labels: null, status: 'unadjudicated', engine: reported }),
      caseInput({ id: 'ev-d-901-b', labels: null, status: 'unlabelled', engine: reported }),
      caseInput({ id: 'ev-d-901-c', labels, engine: { refused: true } }),
    ]);
    expect(counted.cases).toBe(0);
    expect(counted.overall).toMatchObject({ tp: 0, fp: 0, fn: 0 });
  });

  it('says why a labelled signal was missed only where the run explained it', () => {
    const input = caseInput({
      labels,
      engine: { signals: [`ev01|${INTERMITTENT}`], missCauses: { [`ev01|${TIMEOUT}`]: 'wording' } },
    });
    const result = signalMeasures([input]);
    expect(result.missCauses).toEqual({
      'structured-only': 0,
      'type-or-role-gate': 0,
      wording: 1,
      unexplained: 1,
    });
    expect(result.reachableRecall.value).toBeCloseTo(1 / 2, 6);
  });
});

describe('actions', () => {
  it('compares only the events an engineer wrote, and only for a case annotated for actions', () => {
    const annotated = caseInput({
      id: 'ev-d-901-a',
      labels: { signals: [], actions: [{ event: 'ev02', id: 'act.clear-teams-cache' }] },
      engine: {
        actions: [
          'ev02|act.clear-teams-cache',
          'ev01|act.reinstall-teams',
          'ev04|act.validate-fix',
        ],
      },
    });
    const notAnnotated = caseInput({
      id: 'ev-d-901-b',
      labels: { signals: [] },
      engine: { actions: ['ev02|act.validate-fix'] },
    });
    const result = actionMeasures([annotated, notAnnotated]);
    expect(result.cases).toBe(1);
    expect(result.overall).toMatchObject({ tp: 1, fp: 1, fn: 0 });
    expect(result.byDimension['action']).toMatchObject({ tp: 1, fp: 1 });
  });
});

describe('negation and modality', () => {
  it('is right when the engine fires for what is present and stays silent for what is absent, and ignores "other"', () => {
    const input = caseInput({
      labels: {
        signals: [{ event: 'ev01', id: INTERMITTENT }],
        absent: [
          { event: 'ev03', id: TIMEOUT, reason: 'negated' },
          { event: 'ev03', id: PRT_MISSING, reason: 'speculative' },
          { event: 'ev01', id: 'sig.site-correlated', reason: 'other' },
        ],
      },
      engine: { signals: [`ev01|${INTERMITTENT}`, `ev03|${TIMEOUT}`] },
    });
    const result = negationMeasures([input]);
    expect(result.all).toMatchObject({ successes: 2, n: 3 });
    expect(result.onAbsent).toMatchObject({ successes: 1, n: 2 });
    expect(result.onPresent).toMatchObject({ successes: 1, n: 1 });
    expect(result.byReason['negated']).toMatchObject({ successes: 0, n: 1 });
    expect(result.byReason['speculative']).toMatchObject({ successes: 1, n: 1 });
    expect(result.byReason['other']).toBeUndefined();
  });

  it('skips a case that is not annotated for absences, so that old labels cannot flatter the figure', () => {
    const input = caseInput({
      labels: { signals: [{ event: 'ev01', id: INTERMITTENT }] },
      engine: { signals: [`ev01|${INTERMITTENT}`] },
    });
    expect(negationMeasures([input]).cases).toBe(0);
  });
});

describe('contradictions', () => {
  const labelled = {
    signals: [],
    conflicts: [
      {
        class: 'direct_contradiction' as const,
        events: ['ev01', 'ev03'] as [string, string],
        subject: 'sig.error-timeout',
      },
    ],
  };

  it('is not available while the engine reports no conflicts, and says how many are labelled', () => {
    const result = contradictionMeasures([caseInput({ labels: labelled })]);
    expect(result).toMatchObject({
      status: 'not_available',
      labelled: 1,
      cases: 1,
      foundPairs: null,
      precision: null,
    });
  });

  it('finds a labelled conflict by its pair of events in either order, then scores class, subject and precision', () => {
    const input = caseInput({
      labels: labelled,
      engine: {
        conflicts: [
          { class: 'temporal_update', events: ['ev03', 'ev01'], subject: 'sig.error-timeout' },
          { class: 'source_disagreement', events: ['ev01', 'ev02'], subject: 'other' },
        ],
      },
    });
    const result = contradictionMeasures([input]);
    expect(result.status).toBe('measured');
    expect(result.foundPairs).toMatchObject({ successes: 1, n: 1 });
    expect(result.classAccuracy).toMatchObject({ successes: 0, n: 1 });
    expect(result.subjectAgreement).toMatchObject({ successes: 1, n: 1 });
    expect(result.precision).toMatchObject({ successes: 1, n: 2 });
  });

  it('does not need the subject to find a conflict', () => {
    const input = caseInput({
      labels: labelled,
      engine: {
        conflicts: [
          {
            class: 'direct_contradiction',
            events: ['ev01', 'ev03'],
            subject: 'a key the annotator cannot know',
          },
        ],
      },
    });
    const result = contradictionMeasures([input]);
    expect(result.foundPairs).toMatchObject({ successes: 1, n: 1 });
    expect(result.classAccuracy).toMatchObject({ successes: 1, n: 1 });
    expect(result.subjectAgreement).toMatchObject({ successes: 0, n: 1 });
  });
});

describe('unsupported cases and negative controls', () => {
  it('counts the unsupported cases the engine refuses, and the negative controls with nothing reported and no fork', () => {
    const result = rejectionMeasures([
      caseInput({ id: 'ev-d-901-a', categories: ['unsupported'], engine: { refused: true } }),
      caseInput({ id: 'ev-d-901-b', categories: ['unsupported'], labels: { signals: [] } }),
      caseInput({ id: 'ev-d-901-c', categories: ['negative-control'], labels: { signals: [] } }),
      caseInput({
        id: 'ev-d-901-d',
        categories: ['negative-control'],
        labels: { signals: [] },
        engine: { signals: [`ev01|${TIMEOUT}`] },
      }),
      caseInput({
        id: 'ev-d-901-e',
        categories: ['negative-control'],
        labels: { signals: [] },
        engine: {
          forks: [
            { event: 'ev02', categories: ['low_value_action'], severity: 'low', earliest: true },
          ],
        },
      }),
      // A control that does carry a labelled signal has something to find, so it is not asked to stay silent.
      caseInput({
        id: 'ev-d-901-f',
        categories: ['negative-control'],
        labels: { signals: [{ event: 'ev01', id: INTERMITTENT }] },
      }),
    ]);
    expect(result.unsupported).toMatchObject({ successes: 1, n: 2 });
    expect(result.negativeControls).toMatchObject({ successes: 1, n: 3 });
  });
});

describe('decision points', () => {
  it('matches a labelled fork to an engine fork at the same event, whichever of its categories carries the label', () => {
    const input = caseInput({
      labels: {
        signals: [],
        forks: [
          { event: 'ev02', category: 'low_value_action' },
          { event: 'ev04', category: 'premature_escalation' },
        ],
      },
      engine: {
        forks: [
          {
            event: 'ev02',
            categories: ['alternative_action_available', 'low_value_action'],
            severity: 'medium',
            earliest: true,
          },
          { event: 'ev03', categories: ['assumption_as_fact'], severity: 'low', earliest: false },
        ],
      },
    });
    const result = forkMeasures([input]);
    expect(result.precision).toMatchObject({ successes: 1, n: 2 });
    expect(result.recall).toMatchObject({ successes: 1, n: 2 });
    expect(result.recallByCategory['premature_escalation']).toMatchObject({ successes: 0, n: 1 });
  });

  it('classifies the earliest decision point against the labelled earliest missed moment', () => {
    const agreement = (expected: string | null, actual: string | null) =>
      earliestAgreement(
        caseInput({
          labels: { signals: [], earliestMissed: expected },
          engine: { earliestFork: actual },
        }),
      );
    expect(agreement('ev02', 'ev02')).toBe('exact');
    expect(agreement('ev02', 'ev03')).toBe('near');
    expect(agreement('ev02', 'ev04')).toBe('different');
    expect(agreement('ev02', null)).toBe('missed');
    expect(agreement(null, 'ev02')).toBe('spurious');
    expect(agreement(null, null)).toBe('agree-none');
    expect(earliestAgreement(caseInput({ labels: { signals: [] } }))).toBeNull();
    const summary = earliestMeasures([
      caseInput({
        id: 'ev-d-901-a',
        labels: { signals: [], earliestMissed: 'ev02' },
        engine: { earliestFork: 'ev03' },
      }),
      caseInput({ id: 'ev-d-901-b', labels: { signals: [], earliestMissed: null } }),
    ]);
    expect(summary.agree).toMatchObject({ successes: 1, n: 2 });
    expect(summary.withinOne).toMatchObject({ successes: 2, n: 2 });
  });
});

describe('hypotheses and calibration', () => {
  const hypotheses = (confidence: number) => [
    { key: 'hyp.dns-resolution', prior: 0.2, confidence },
    { key: 'hyp.proxy-egress', prior: 0.2, confidence: 0.3 },
    { key: 'hyp.other', prior: 0.1, confidence: 0.1 },
  ];
  const leader = (causes: string[], confidence: number) =>
    leaderAgreement(
      caseInput({
        labels: { signals: [], causes },
        engine: { hypotheses: hypotheses(confidence) },
      }),
    );

  it('tells a leader moved by evidence from one that leads by its prior, and a wrong one from the catch-all', () => {
    expect(leader(['hyp.dns-resolution'], 0.6)).toBe('right');
    expect(leader(['hyp.dns-resolution'], 0.31)).toBe('right');
    expect(leader(['hyp.proxy-egress'], 0.6)).toBe('wrong');
    expect(leader(['hyp.device-state'], 0.05)).toBe('wrong');
    expect(leader([], 0.6)).toBe('n/a');
    const byPrior = caseInput({
      labels: { signals: [], causes: ['hyp.proxy-egress'] },
      engine: {
        hypotheses: [
          { key: 'hyp.dns-resolution', prior: 0.1, confidence: 0.1 },
          { key: 'hyp.proxy-egress', prior: 0.2, confidence: 0.21 },
        ],
      },
    });
    expect(leaderAgreement(byPrior)).toBe('right-by-prior');
    expect(
      leaderAgreement(
        caseInput({
          labels: { signals: [], causes: ['hyp.dns-resolution'] },
          engine: { hypotheses: [{ key: 'hyp.other', prior: 0.1, confidence: 0.9 }] },
        }),
      ),
    ).toBe('other');
  });

  it('calibrates the named hypotheses against the labelled causes and leaves the catch-all out', () => {
    const result = hypothesisMeasures([
      caseInput({
        labels: { signals: [], causes: ['hyp.dns-resolution'] },
        engine: { hypotheses: hypotheses(0.6) },
      }),
      caseInput({
        id: 'ev-d-901-b',
        labels: { signals: [], causes: [] },
        engine: { hypotheses: hypotheses(0.6) },
      }),
    ]);
    expect(result.cases).toBe(1);
    expect(result.calibration.n).toBe(2);
    expect(result.leaderIsCause).toMatchObject({ successes: 1, n: 1 });
  });
});

describe('citations, recommendations and counterfactual direction', () => {
  it('adds up citations and recommendation links over the cases that have them', () => {
    const cases = [
      caseInput({
        id: 'ev-d-901-a',
        engine: {
          citations: { total: 4, verified: 3, mismatch: 1, notCheckable: 0 },
          recommendations: { total: 5, withEvidence: 4, general: 1 },
        },
      }),
      caseInput({
        id: 'ev-d-901-b',
        engine: { citations: { total: 2, verified: 2, mismatch: 0, notCheckable: 0 } },
      }),
    ];
    expect(citationMeasures(cases).verified).toMatchObject({ successes: 5, n: 6 });
    expect(recommendationMeasures(cases)).toMatchObject({ cases: 1, total: 5 });
    expect(recommendationMeasures(cases).linked).toMatchObject({ successes: 5, n: 5 });
  });

  it('is not run until the engine simulated a path, then compares the label with "clearly better"', () => {
    const labelled = (direction: 'better' | 'none' | 'unclear', clearlyBetter?: boolean) =>
      caseInput({
        id: `ev-d-901-${direction}-${String(clearlyBetter)}`,
        labels: { signals: [], counterfactualDirection: direction },
        engine:
          clearlyBetter === undefined
            ? {}
            : {
                counterfactual: {
                  simulated: true,
                  timeToDiagnosisGain: 0.3,
                  customerEffortGain: 0,
                  clearlyBetter,
                },
              },
      });
    expect(counterfactualMeasures([labelled('better')]).status).toBe('not_run');
    const result = counterfactualMeasures([
      labelled('better', true),
      labelled('none', true),
      labelled('none', false),
      labelled('unclear', true),
    ]);
    expect(result.status).toBe('measured');
    expect(result.agreement).toMatchObject({ successes: 2, n: 3 });
    expect(result.confusion).toEqual({
      better: { better: 1, none: 0 },
      none: { better: 1, none: 1 },
    });
  });
});

describe('a whole run and the invariance of order', () => {
  it('measures an empty run without dividing by zero', () => {
    const result = computeMetrics([]);
    expect(result.signals.overall.precision.value).toBeNull();
    expect(result.negation.all.n).toBe(0);
    expect(result.contradiction.status).toBe('no_labels');
  });

  it('keeps the per-case lines apart from the aggregates', () => {
    const detail = caseDetail(
      caseInput({
        labels: { signals: [{ event: 'ev01', id: INTERMITTENT }] },
        engine: { signals: [`ev03|${TIMEOUT}`] },
      }),
    );
    expect(detail.signals).toEqual({
      tp: [],
      fp: [`ev03|${TIMEOUT}`],
      fn: [`ev01|${INTERMITTENT}`],
    });
  });

  it('reports what differs between a reordered copy and its source', () => {
    const source = engineOutput({ signals: [`ev01|${TIMEOUT}`], earliestFork: 'ev02' });
    expect(
      invariance(
        source,
        engineOutput({
          caseId: 'ev-d-902-copy',
          signals: [`ev01|${TIMEOUT}`],
          earliestFork: 'ev02',
        }),
      ).identical,
    ).toBe(true);
    const different = invariance(
      source,
      engineOutput({ caseId: 'ev-d-902-copy', signals: [], earliestFork: 'ev04' }),
    );
    expect(different.identical).toBe(false);
    expect(different.differences).toEqual(['signals', 'earliest fork']);
  });
});
