import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { acceptedFor } from './labels';
import {
  EVALUATION_ROOT,
  caseSetHash,
  canonicalJson,
  loadDataset,
  readLockedRuns,
  sha256,
  testSetHash,
  writeJson,
  type Dataset,
} from './dataset';
import { enginePackIdentity, runEngine } from './engine';
import { gitHead, uncommittedUnder } from './git';
import { appendRun, lockProblems } from './locked';
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
import { renderMarkdown } from './report';
import { runDataset } from './runner';
import {
  EVAL_LOCKED_RUNS_SCHEMA,
  type LockedRunRecord,
  type LockedRuns,
  type Split,
} from './schema';
import {
  buildArtifact,
  engineVersion,
  withoutPerId,
  type RunArtifact,
  type RunResults,
} from './artifact';

/**
 * The functions behind every command line of the evaluation (`eval:dev`, `eval:validation`, `eval:locked`): what they
 * print and write is what these return, so a test or another script can call them and read the same structured results.
 *
 *  - `evaluateCase(caseId, split)`: one case, with its accepted labels, what the engine said and how the two compare;
 *  - `evaluateSplit(split)`: every measure over a split, the per-case lines, the artifact and the Markdown report;
 *  - `evaluateLocked()`: the locked test split. It is the only way to run the engine on it: it checks the lock and the
 *    log, records the run in the append-only log of locked runs and returns aggregates only unless asked for detail.
 *
 * The first two refuse the test split on purpose.
 */

export interface EvaluationOptions {
  /** Only the cases whose accepted labels come from this annotator. */
  readonly annotator?: string | undefined;
  /** Quality improvements, warnings and coaching suggestions, for the evidence-link measure. Default: on. */
  readonly recommendations?: boolean;
  /** Simulated better paths at the earliest decision point. Slow. Default: off. */
  readonly counterfactual?: boolean;
  /** Per-case lines in the artifact and the report. Default: on for dev, off for the others. */
  readonly detail?: boolean;
  /** A dataset that is already loaded (tests). Otherwise only the files of the split are read. */
  readonly dataset?: Dataset;
}

export interface CaseEvaluation {
  readonly caseId: string;
  readonly split: Split;
  /** The accepted labels (a reordered copy repeats its source's) and the engine's output for the case. */
  readonly input: CaseInput;
  readonly detail: CaseDetail;
  /** The measures over this one case. */
  readonly metrics: MetricsResult;
  /** For a reordered copy only: whether it gives exactly the analysis of its source. */
  readonly invariance: InvarianceResult | null;
}

export interface SplitEvaluation {
  readonly split: Split;
  readonly inputs: readonly CaseInput[];
  readonly metrics: MetricsResult;
  readonly invariance: readonly InvarianceResult[];
  readonly details: readonly CaseDetail[];
  /** The JSON the command line writes to `evaluation/runs/<split>-latest.json`. */
  readonly artifact: RunArtifact;
  /** The Markdown the command line prints. */
  readonly markdown: string;
}

const LOCKED_MESSAGE =
  'The locked test split is evaluated only by evaluateLocked() (`eval:locked`): it checks the lock, records the run in the log of locked runs and shows aggregates only.';

const engineOptions = (options: EvaluationOptions) => ({
  recommendations: options.recommendations ?? true,
  counterfactual: options.counterfactual ?? false,
});

function datasetFor(split: Split, options: EvaluationOptions): Dataset {
  const dataset = options.dataset ?? loadDataset({ splits: [split] });
  if (dataset.problems.length > 0) throw new Error(dataset.problems.join('\n'));
  return dataset;
}

const safeHead = (): string | null => {
  try {
    return gitHead();
  } catch {
    return null;
  }
};
const now = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

export function evaluateCase(
  caseId: string,
  split: Split,
  options: EvaluationOptions = {},
): CaseEvaluation {
  if (split === 'test') throw new Error(LOCKED_MESSAGE);
  const dataset = datasetFor(split, options);
  const loaded = dataset.cases.find(
    (entry) => entry.case.id === caseId && entry.case.split === split,
  );
  if (!loaded) throw new Error(`There is no case ${caseId} in the ${split} split.`);
  const accepted = acceptedFor(dataset, loaded);
  const labelled = accepted?.labels?.signals.map((label) => `${label.event}|${label.id}`) ?? [];
  const output = runEngine(loaded.case, { ...engineOptions(options), explainMisses: labelled });
  const input = caseInputOf(loaded.case, accepted, output);
  let check: InvarianceResult | null = null;
  if (loaded.case.derivedFrom !== null) {
    const source = dataset.cases.find((entry) => entry.case.id === loaded.case.derivedFrom);
    if (source) check = invariance(runEngine(source.case, { recommendations: false }), output);
  }
  return {
    caseId,
    split,
    input,
    detail: caseDetail(input),
    metrics: computeMetrics([input]),
    invariance: check,
  };
}

function assemble(
  split: Split,
  dataset: Dataset,
  options: EvaluationOptions,
  detail: boolean,
  transform: (metrics: MetricsResult) => MetricsResult,
  title: string,
  perId: boolean,
): SplitEvaluation {
  const outcome = runDataset(dataset, {
    selection: { splits: [split], annotator: options.annotator },
    engine: engineOptions(options),
  });
  const metrics = transform(outcome.metrics);
  const results: RunResults = {
    metrics,
    invariance: outcome.invariance,
    details: detail ? outcome.details : null,
  };
  const artifact = buildArtifact({
    split,
    generatedAt: now(),
    gitCommit: safeHead(),
    dataset,
    selected: outcome.selected,
    selection: { splits: [split], annotator: options.annotator ?? null },
    options: { ...engineOptions(options), detail },
    results,
  });
  const markdown = renderMarkdown(
    metrics,
    outcome.invariance,
    {
      title,
      annotators: artifact.meta.annotators,
      lines: [
        `engine ${artifact.meta.engine.version} (${artifact.meta.engine.package}), pack ${artifact.meta.pack.id}@${artifact.meta.pack.version} (sha256 ${artifact.meta.pack.sha256.slice(0, 12)})`,
        `case set sha256 ${artifact.meta.dataset.caseSetSha256.slice(0, 12)}, results sha256 ${artifact.resultsSha256.slice(0, 12)}`,
        artifact.meta.gitCommit
          ? `git commit ${artifact.meta.gitCommit.slice(0, 10)}`
          : 'no git commit available',
      ],
    },
    { perId, details: detail ? outcome.details : null },
  );
  return {
    split,
    inputs: outcome.inputs,
    metrics,
    invariance: outcome.invariance,
    details: outcome.details,
    artifact,
    markdown,
  };
}

export function evaluateSplit(split: Split, options: EvaluationOptions = {}): SplitEvaluation {
  if (split === 'test') throw new Error(LOCKED_MESSAGE);
  return assemble(
    split,
    datasetFor(split, options),
    options,
    options.detail ?? split === 'dev',
    (metrics) => metrics,
    `Evaluation run: ${split} split`,
    true,
  );
}

// ---------------------------------------------------------------- the locked split

export interface LockedOptions {
  /** Per-case lines. They are recorded in the log as given, and must never be used to change a detector. */
  readonly detail?: boolean;
  readonly recommendations?: boolean;
  readonly counterfactual?: boolean;
}

export interface LockedEvaluation extends SplitEvaluation {
  /** The record that was appended to `evaluation/runs/locked-runs.json`. */
  readonly record: LockedRunRecord;
}

export async function evaluateLocked(options: LockedOptions = {}): Promise<LockedEvaluation> {
  const dataset = loadDataset({ splits: ['test'] });
  if (dataset.problems.length > 0) throw new Error(dataset.problems.join('\n'));
  const logPath = join(EVALUATION_ROOT, 'runs', 'locked-runs.json');
  const log: LockedRuns = (existsSync(logPath) ? readLockedRuns() : null) ?? {
    schema: EVAL_LOCKED_RUNS_SCHEMA,
    runs: [],
  };
  const testHash = testSetHash(dataset.cases);
  const problems = lockProblems({
    manifest: dataset.manifest,
    uncommitted: uncommittedUnder(['evaluation/cases/test', 'evaluation/annotations']),
    testHash,
    log,
  });
  if (problems.length > 0)
    throw new Error(`Refusing to run the locked split.\n${problems.join('\n')}`);

  const detail = options.detail === true;
  const evaluation = assemble(
    'test',
    dataset,
    { recommendations: options.recommendations, counterfactual: options.counterfactual },
    detail,
    withoutPerId,
    'Locked test split (aggregates only)',
    false,
  );
  const pack = enginePackIdentity();
  const version = engineVersion();
  const next = appendRun(log, {
    ranAt: now(),
    gitCommit: safeHead() ?? '0'.repeat(40),
    engineVersion: `${version.version} (${version.package})`,
    packId: pack.id,
    packVersion: pack.version,
    packSha256: pack.sha256,
    caseSetSha256: caseSetHash(dataset.cases),
    testSetSha256: testHash,
    resultsSha256: sha256(canonicalJson(evaluation.artifact.results)),
    detail,
  });
  await writeJson(logPath, next);
  await writeJson(join(EVALUATION_ROOT, 'runs', 'test-latest.json'), evaluation.artifact);
  const record = next.runs[next.runs.length - 1];
  if (!record) throw new Error('the record of the run was not appended');
  return { ...evaluation, record };
}
