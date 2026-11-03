import { describe, expect, it } from 'vitest';
import {
  FLOOR_METRICS,
  checkFloors,
  describeViolation,
  engineNeeds,
  parseFloors,
  readFloors,
} from './floors';
import { caseInput } from './fixtures';
import { computeMetrics } from './metrics';

const INTERMITTENT = 'sig.intermittent-failures';
const TIMEOUT = 'sig.error-timeout';
const PRT_MISSING = 'sig.prt-missing';
const SITE = 'sig.site-correlated';

/** Four labelled signals, of which the engine finds two and adds one nobody wrote: recall 1/2, precision 2/3. */
const metrics = computeMetrics([
  caseInput({
    labels: {
      signals: [
        { event: 'ev01', id: INTERMITTENT },
        { event: 'ev01', id: TIMEOUT },
        { event: 'ev03', id: PRT_MISSING },
        { event: 'ev03', id: SITE },
      ],
    },
    engine: {
      signals: [`ev01|${INTERMITTENT}`, `ev01|${TIMEOUT}`, `ev03|sig.token-expiry-errors`],
    },
  }),
]);

describe('the floors of the dev split', () => {
  it('lets a measure that is at or above its floor pass, to the last digit', () => {
    expect(checkFloors(metrics, { recall: 0.5, precision: 2 / 3 })).toEqual([]);
    expect(checkFloors(metrics, { recall: 0.1, precision: 0.6 })).toEqual([]);
  });

  it('fails a measure that falls below its floor, and says which and by how much', () => {
    const violations = checkFloors(metrics, { recall: 0.6, precision: 0.5 });
    expect(violations).toEqual([{ metric: 'recall', floor: 0.6, actual: 0.5, kind: 'below' }]);
    expect(describeViolation(violations[0] as (typeof violations)[number])).toBe(
      'recall is 50.0%, below its floor of 60.0%',
    );
  });

  it('fails a floor on a measure that nothing was observed for, instead of passing silently', () => {
    const violations = checkFloors(metrics, { negationAccuracy: 0.5, contradictionRecall: 0.1 });
    expect(violations.map((violation) => [violation.metric, violation.kind])).toEqual([
      ['negationAccuracy', 'not_measurable'],
      ['contradictionRecall', 'not_measurable'],
    ]);
  });

  it('names a measure that does not exist, whether it is read from the file or checked', () => {
    expect(() => parseFloors('{"dev": {"recal": 0.2}}')).toThrow(/recal/);
    expect(() => checkFloors(metrics, { recal: 0.2 })).toThrow(/recal/);
    expect(() => parseFloors('{"dev": {"recall": 1.5}}')).toThrow();
    expect(() => parseFloors('{"validation": {"recall": 0.2}}')).toThrow();
  });

  it('says whether the run has to compute recommendations or counterfactuals for the floors to be measurable', () => {
    expect(engineNeeds({ recall: 0.1 })).toEqual({ recommendations: false, counterfactual: false });
    expect(engineNeeds({ evidenceLinkCompleteness: 0.9, recall: 0.1 })).toEqual({
      recommendations: true,
      counterfactual: false,
    });
    expect(engineNeeds({ counterfactualAgreement: 0.5 })).toEqual({
      recommendations: false,
      counterfactual: true,
    });
  });

  it('has a committed file that is valid: known measures, fractions, and the three starting floors present', () => {
    const { dev } = readFloors();
    for (const [name, floor] of Object.entries(dev)) {
      expect(FLOOR_METRICS[name], name).toBeDefined();
      expect(floor, name).toBeGreaterThanOrEqual(0);
      expect(floor, name).toBeLessThanOrEqual(1);
    }
    expect(Object.keys(dev)).toEqual(
      expect.arrayContaining(['recall', 'precision', 'negationAccuracy']),
    );
  });
});
