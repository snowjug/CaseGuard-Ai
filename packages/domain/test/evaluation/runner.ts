import { acceptedFor } from './labels';
import {
  caseDetail,
  caseInputOf,
  computeMetrics,
  invariance,
  type CaseDetail,
  type CaseInput,
  type InvarianceResult,
  type MetricsResult,
} from './metrics';
import { runEngine, type RunOptions } from './engine';
import type { Dataset, LoadedCase } from './dataset';
import type { EngineCaseOutput } from './output';
import type { Split } from './schema';

export interface RunSelection {
  readonly splits: readonly Split[];
  /** Only the cases whose accepted labels come from this annotator (the Wave 1 baseline uses this). */
  readonly annotator?: string | undefined;
}

export interface RunRequest {
  readonly selection: RunSelection;
  readonly engine?: RunOptions;
}

export interface RunOutcome {
  /** The independent cases that were run, by id. */
  readonly selected: readonly LoadedCase[];
  readonly inputs: readonly CaseInput[];
  readonly metrics: MetricsResult;
  readonly invariance: readonly InvarianceResult[];
  readonly details: readonly CaseDetail[];
}

const byId = (a: LoadedCase, b: LoadedCase): number => (a.case.id < b.case.id ? -1 : a.case.id > b.case.id ? 1 : 0);

/**
 * Runs the engine over the cases of a selection and measures the result. Reordered copies are run too, but only to check
 * that they give the analysis of their source: they are not part of the measures.
 */
export function runDataset(dataset: Dataset, request: RunRequest): RunOutcome {
  const wanted = new Set<Split>(request.selection.splits);
  const independents = dataset.cases
    .filter((loaded) => loaded.case.derivedFrom === null && wanted.has(loaded.case.split))
    .sort(byId);
  const selected: LoadedCase[] = [];
  const inputs: CaseInput[] = [];
  const outputs = new Map<string, EngineCaseOutput>();
  for (const loaded of independents) {
    const accepted = acceptedFor(dataset, loaded);
    if (request.selection.annotator !== undefined && accepted?.acceptedFrom !== request.selection.annotator) {
      continue;
    }
    const labelled = accepted?.labels?.signals.map((label) => `${label.event}|${label.id}`) ?? [];
    const output = runEngine(loaded.case, { ...request.engine, explainMisses: labelled });
    selected.push(loaded);
    outputs.set(loaded.case.id, output);
    inputs.push(caseInputOf(loaded.case, accepted, output));
  }

  const checks: InvarianceResult[] = [];
  const copies = dataset.cases
    .filter((loaded) => loaded.case.derivedFrom !== null && outputs.has(loaded.case.derivedFrom))
    .sort(byId);
  for (const copy of copies) {
    const source = outputs.get(copy.case.derivedFrom ?? '');
    if (source) checks.push(invariance(source, runEngine(copy.case, { recommendations: false })));
  }

  return {
    selected,
    inputs,
    metrics: computeMetrics(inputs),
    invariance: checks,
    details: inputs.map(caseDetail),
  };
}
