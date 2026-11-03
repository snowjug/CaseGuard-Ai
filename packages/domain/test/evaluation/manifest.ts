import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EVALUATION_ROOT,
  loadDataset,
  testSetHash,
  writeJson,
  type Dataset,
} from './dataset';
import { gitHead, uncommittedUnder } from './git';
import { EVAL_MANIFEST_SCHEMA, SPLITS, type Manifest } from './schema';

/**
 * The manifest records what the dataset is: which cases are in which split, the family of each, and a hash of every case
 * file and annotation file. `eval:manifest` writes it, `eval:check` and the guard tests verify it. Once the test split is
 * locked, a change to any of its files, or to its annotations, is a change to the locked set and is refused.
 */

export const INITIAL_DATASET_VERSION = '2.0.0';

export function buildManifest(
  dataset: Dataset,
  previous: Manifest | null,
  lock: { at: string; commit: string } | null,
): Manifest {
  const entries = [...dataset.cases].sort((a, b) => (a.case.id < b.case.id ? -1 : 1));
  const cases: Manifest['cases'] = {};
  const splits: Manifest['splits'] = { dev: [], validation: [], test: [] };
  for (const entry of entries) {
    cases[entry.case.id] = {
      split: entry.case.split,
      family: entry.case.family,
      derivedFrom: entry.case.derivedFrom,
      eventsSha256: entry.eventsSha256,
      annotationsSha256: entry.annotationsSha256,
    };
    splits[entry.case.split].push(entry.case.id);
  }
  const annotationsChanged =
    previous === null ||
    Object.keys(previous.cases).some((id) => !(id in cases)) ||
    Object.entries(cases).some(
      ([id, entry]) => previous.cases[id]?.annotationsSha256 !== entry.annotationsSha256,
    );
  const testHash = testSetHash(entries.filter((entry) => entry.case.split === 'test'));
  let locked = previous?.locked ?? null;
  if (locked !== null && locked.testSetSha256 !== testHash) {
    throw new Error(
      'The locked test split has changed since it was locked (a case file or an annotation file differs). ' +
        'Restore it; a locked set is never rewritten.',
    );
  }
  if (lock !== null) {
    if (locked !== null) throw new Error('The test split is already locked.');
    locked = { at: lock.at, commit: lock.commit, testSetSha256: testHash };
  }
  return {
    schema: EVAL_MANIFEST_SCHEMA,
    datasetVersion: previous?.datasetVersion ?? INITIAL_DATASET_VERSION,
    annotationVersion: previous ? previous.annotationVersion + (annotationsChanged ? 1 : 0) : 1,
    splits,
    cases,
    locked,
  };
}

/** What differs between the manifest on disk and the files on disk; empty when they agree. */
export function verifyManifest(dataset: Dataset): string[] {
  const manifest = dataset.manifest;
  if (manifest === null) return ['manifest.json is missing: run `pnpm --filter @caseguard/domain run eval:manifest`'];
  const problems: string[] = [];
  const known = new Set(Object.keys(manifest.cases));
  for (const entry of dataset.cases) {
    const id = entry.case.id;
    const recorded = manifest.cases[id];
    if (!recorded) {
      problems.push(`${id}: not in the manifest`);
      continue;
    }
    known.delete(id);
    if (recorded.split !== entry.case.split) problems.push(`${id}: the manifest says split ${recorded.split}, the case says ${entry.case.split}`);
    if (recorded.family !== entry.case.family) problems.push(`${id}: the manifest says family ${recorded.family}, the case says ${entry.case.family}`);
    if (recorded.derivedFrom !== entry.case.derivedFrom) problems.push(`${id}: derivedFrom differs from the manifest`);
    if (recorded.eventsSha256 !== entry.eventsSha256) problems.push(`${id}: the case file does not match its hash in the manifest`);
    if (recorded.annotationsSha256 !== entry.annotationsSha256) problems.push(`${id}: the annotation file does not match its hash in the manifest`);
  }
  for (const id of known) problems.push(`${id}: in the manifest, but its case file is missing`);
  for (const split of SPLITS) {
    const listed = manifest.splits[split];
    const actual = dataset.cases.filter((entry) => entry.case.split === split).map((entry) => entry.case.id).sort();
    if (JSON.stringify([...listed].sort()) !== JSON.stringify(actual)) problems.push(`the manifest lists other cases for the ${split} split than the ones on disk`);
  }
  if (manifest.locked !== null) {
    const hash = testSetHash(dataset.cases.filter((entry) => entry.case.split === 'test'));
    if (hash !== manifest.locked.testSetSha256) problems.push('the locked test split has changed since it was locked');
  }
  return problems;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

async function main(): Promise<void> {
  const lock = process.argv.includes('--lock');
  const check = process.argv.includes('--check');
  const dataset = loadDataset();
  if (dataset.problems.length > 0) {
    process.stderr.write(`${dataset.problems.join('\n')}\n`);
    process.exitCode = 1;
    return;
  }
  if (check) {
    const problems = verifyManifest(dataset);
    process.stdout.write(problems.length === 0 ? 'manifest.json is current.\n' : `${problems.join('\n')}\n`);
    process.exitCode = problems.length === 0 ? 0 : 1;
    return;
  }
  try {
    if (lock) {
      const dirty = uncommittedUnder(['evaluation/cases/test', 'evaluation/annotations/ev-t-*.json']);
      if (dirty.length > 0) {
        throw new Error(`Commit the test split and the annotations before locking it:\n${dirty.join('\n')}`);
      }
    }
    const manifest = buildManifest(
      dataset,
      dataset.manifest,
      lock ? { at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), commit: gitHead() } : null,
    );
    await writeJson(join(EVALUATION_ROOT, 'manifest.json'), manifest);
    process.stdout.write(
      `wrote evaluation/manifest.json: ${Object.keys(manifest.cases).length} cases, annotation version ${manifest.annotationVersion}${manifest.locked ? ', test split locked' : ''}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (isMain) await main();
