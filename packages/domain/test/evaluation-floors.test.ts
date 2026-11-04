import { describe, expect, it } from 'vitest';
import { evaluateSplit } from './evaluation/evaluate';
import { checkFloors, describeViolation, engineNeeds, readFloors } from './evaluation/floors';

/**
 * The regression guard for the dev split: `evaluation/runs/floors.json` names the lowest value each measure may reach on the
 * dev cases, and this test fails when one falls below. The parent edits the floors at each milestone (raise them when the
 * engine improves, never lower one to hide a regression). The mechanism is unit-tested with synthetic results in
 * `evaluation/floors.test.ts`.
 *
 * This runs the engine on EVERY case of the dev split, including the ones written for the evaluation. Whoever authors
 * evaluation cases does not run it (the cases must not be labelled or reworded with the engine's output in sight); the
 * parent and CI do.
 */
const floors = readFloors().dev;
const needs = engineNeeds(floors);
const run = evaluateSplit('dev', {
  recommendations: needs.recommendations,
  counterfactual: needs.counterfactual,
  detail: false,
});

describe('[eval] the dev floors', () => {
  it('measures every case of the dev split, with the labels of the annotators that were accepted', () => {
    expect(run.inputs.length).toBeGreaterThan(0);
    expect(run.metrics.cases.total).toBe(run.inputs.length);
  });

  it('has no measure below its floor in evaluation/runs/floors.json', () => {
    expect(checkFloors(run.metrics, floors).map(describeViolation)).toEqual([]);
  });
});
