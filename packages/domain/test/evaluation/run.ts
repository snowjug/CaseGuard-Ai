import { join } from 'node:path';
import { EVALUATION_ROOT, writeJson } from './dataset';
import { evaluateLocked, evaluateSplit } from './evaluate';
import type { Split } from './schema';

/**
 * `pnpm --filter @caseguard/domain run eval:dev | eval:validation | eval:locked`
 *
 *   --annotator <id>         only cases whose accepted labels come from this annotator (not for the locked split)
 *   --detail / --no-detail   per-case lines (dev: on by default; validation and locked: off)
 *   --counterfactual         simulate the better path at the earliest decision point (slow)
 *   --no-recommendations     skip quality improvements, warnings and coaching (faster)
 *   --json                   print the JSON artifact instead of the Markdown report
 *
 * Everything printed here is what `evaluateSplit` and `evaluateLocked` (evaluate.ts) return. `eval:locked` is the only
 * way to run the engine on the locked test split: it refuses to run when the split or its annotations have uncommitted
 * changes or differ from the lock, prints aggregates only (`--detail` is recorded in the log as such), and appends a
 * record to `evaluation/runs/locked-runs.json`. What it prints must never be used to change a detector.
 */

interface Flags {
  readonly mode: string;
  readonly annotator: string | undefined;
  readonly detail: boolean | undefined;
  readonly counterfactual: boolean;
  readonly recommendations: boolean;
  readonly json: boolean;
}

function parseFlags(argv: readonly string[]): Flags {
  const flag = (name: string): boolean => argv.includes(name);
  const annotatorIndex = argv.indexOf('--annotator');
  return {
    mode: argv[0] ?? '',
    annotator: annotatorIndex >= 0 ? argv[annotatorIndex + 1] : undefined,
    detail: flag('--detail') ? true : flag('--no-detail') ? false : undefined,
    counterfactual: flag('--counterfactual'),
    recommendations: !flag('--no-recommendations'),
    json: flag('--json'),
  };
}

const out = (text: string): void => {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
};
const fail = (text: string): void => {
  process.stderr.write(`${text}\n`);
  process.exitCode = 1;
};

async function runSplit(split: Split, flags: Flags): Promise<void> {
  const evaluation = evaluateSplit(split, {
    annotator: flags.annotator,
    recommendations: flags.recommendations,
    counterfactual: flags.counterfactual,
    detail: flags.detail,
  });
  await writeJson(join(EVALUATION_ROOT, 'runs', `${split}-latest.json`), evaluation.artifact);
  out(flags.json ? JSON.stringify(evaluation.artifact, null, 2) : evaluation.markdown);
}

async function runLocked(flags: Flags): Promise<void> {
  if (flags.annotator !== undefined) {
    return fail('eval:locked runs the whole locked split: --annotator is not allowed.');
  }
  try {
    const evaluation = await evaluateLocked({
      detail: flags.detail === true,
      recommendations: flags.recommendations,
      counterfactual: flags.counterfactual,
    });
    out(flags.json ? JSON.stringify(evaluation.artifact, null, 2) : evaluation.markdown);
    out(
      `Appended record ${evaluation.record.index} to evaluation/runs/locked-runs.json. Commit it. Do not use these numbers to change a detector.`,
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  switch (flags.mode) {
    case 'dev':
      return runSplit('dev', flags);
    case 'validation':
      return runSplit('validation', flags);
    case 'locked':
      return runLocked(flags);
    default:
      return fail(
        'usage: run.ts <dev|validation|locked> [--annotator id] [--detail] [--counterfactual] [--no-recommendations] [--json]',
      );
  }
}

await main();
