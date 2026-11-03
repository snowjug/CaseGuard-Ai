import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { EVALUATION_ROOT } from './dataset';
import type { MetricsResult } from './metrics';

/**
 * A regression guard for the dev split. `evaluation/runs/floors.json` names, per measure, the lowest value the engine may
 * reach on the dev cases; a test fails when a measure falls below its floor. The floors are edited by hand at each
 * milestone (raised when the engine improves, never lowered to hide a regression). Only the dev split has floors: no test
 * reads the validation or the locked split.
 */

export interface FloorMetric {
  readonly description: string;
  /** What the engine run has to compute for the measure to exist. */
  readonly needs?: 'recommendations' | 'counterfactual';
  /** The measure of a run, or null when nothing was observed for it (no cases, or not available yet). */
  readonly value: (metrics: MetricsResult) => number | null;
}

/** The measures a floor can name. All of them are better when higher. */
export const FLOOR_METRICS: Readonly<Record<string, FloorMetric>> = {
  recall: {
    description: 'recall of the labelled signals (micro-averaged)',
    value: (m) => m.signals.overall.recall.value,
  },
  precision: {
    description: 'precision of the reported signals (micro-averaged)',
    value: (m) => m.signals.overall.precision.value,
  },
  f1: { description: 'F1 of the signals', value: (m) => m.signals.overall.f1 },
  actionRecall: {
    description: 'recall of the labelled actions',
    value: (m) => m.actions.overall.recall.value,
  },
  actionPrecision: {
    description: 'precision of the reported actions',
    value: (m) => m.actions.overall.precision.value,
  },
  negationAccuracy: {
    description: 'decisions on present and absent labels the engine got right',
    value: (m) => m.negation.all.value,
  },
  negationSilence: {
    description: 'labelled absences (denied, guessed, intended...) on which the engine stayed silent',
    value: (m) => m.negation.onAbsent.value,
  },
  negativeControlSilence: {
    description: 'negative controls with nothing to find that raise nothing',
    value: (m) => m.rejection.negativeControls.value,
  },
  unsupportedRejection: {
    description: 'unsupported workloads the engine refuses',
    value: (m) => m.rejection.unsupported.value,
  },
  contradictionRecall: {
    description: 'labelled conflicts found (the same two events)',
    value: (m) => m.contradiction.foundPairs?.value ?? null,
  },
  contradictionClassAccuracy: {
    description: 'class right among the conflicts found',
    value: (m) => m.contradiction.classAccuracy?.value ?? null,
  },
  forkPrecision: { description: 'precision of the decision points', value: (m) => m.forks.precision.value },
  forkRecall: { description: 'recall of the labelled decision points', value: (m) => m.forks.recall.value },
  earliestAgreement: {
    description: 'earliest missed moment: exact, or both say there is none',
    value: (m) => m.earliest.agree.value,
  },
  leaderIsCause: {
    description: 'the leading hypothesis is a labelled cause',
    value: (m) => m.hypotheses.leaderIsCause.value,
  },
  citationCorrectness: {
    description: 'citations verified against the stored text',
    value: (m) => m.citations.verified.value,
  },
  evidenceLinkCompleteness: {
    description: 'recommendation-like outputs that carry evidence ids',
    needs: 'recommendations',
    value: (m) => (m.recommendations.cases === 0 ? null : m.recommendations.linked.value),
  },
  counterfactualAgreement: {
    description: 'counterfactual direction agrees with the label',
    needs: 'counterfactual',
    value: (m) => (m.counterfactual.status === 'measured' ? m.counterfactual.agreement.value : null),
  },
};

export const FloorsFileSchema = z.strictObject({
  /** Free text for whoever edits the file: why the floors are where they are. */
  note: z.string().optional(),
  dev: z.record(z.string(), z.number().min(0).max(1)),
});
export type FloorsFile = z.infer<typeof FloorsFileSchema>;

export const FLOORS_PATH = join(EVALUATION_ROOT, 'runs', 'floors.json');

/** Reads and validates the floors file; a floor for a measure that does not exist is an error, not a silent no-op. */
export function parseFloors(text: string): FloorsFile {
  const parsed = FloorsFileSchema.parse(JSON.parse(text));
  const unknown = Object.keys(parsed.dev).filter((name) => FLOOR_METRICS[name] === undefined);
  if (unknown.length > 0) {
    throw new Error(
      `floors.json names measures that do not exist: ${unknown.join(', ')}. Known: ${Object.keys(FLOOR_METRICS).join(', ')}`,
    );
  }
  return parsed;
}

export const readFloors = (path = FLOORS_PATH): FloorsFile => parseFloors(readFileSync(path, 'utf8'));

export interface FloorViolation {
  readonly metric: string;
  readonly floor: number;
  /** Null when the measure could not be observed: no case counted, or the engine does not produce it. */
  readonly actual: number | null;
  readonly kind: 'below' | 'not_measurable';
}

/** The tolerance for floating point: a measure that equals its floor passes. */
const EPSILON = 1e-9;

export function checkFloors(
  metrics: MetricsResult,
  floors: Readonly<Record<string, number>>,
): FloorViolation[] {
  const violations: FloorViolation[] = [];
  for (const [metric, floor] of Object.entries(floors)) {
    const definition = FLOOR_METRICS[metric];
    if (!definition) throw new Error(`There is no measure called "${metric}".`);
    const actual = definition.value(metrics);
    if (actual === null) violations.push({ metric, floor, actual, kind: 'not_measurable' });
    else if (actual < floor - EPSILON) violations.push({ metric, floor, actual, kind: 'below' });
  }
  return violations;
}

export const describeViolation = (violation: FloorViolation): string =>
  violation.kind === 'below'
    ? `${violation.metric} is ${((violation.actual ?? 0) * 100).toFixed(1)}%, below its floor of ${(violation.floor * 100).toFixed(1)}%`
    : `${violation.metric} could not be measured, but has a floor of ${(violation.floor * 100).toFixed(1)}%`;

/** What the engine run has to compute for every measure of the floors to exist. */
export function engineNeeds(floors: Readonly<Record<string, number>>): {
  recommendations: boolean;
  counterfactual: boolean;
} {
  const needs = Object.keys(floors).map((metric) => FLOOR_METRICS[metric]?.needs);
  return {
    recommendations: needs.includes('recommendations'),
    counterfactual: needs.includes('counterfactual'),
  };
}
