import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { TEAMS_AUTH_PACK } from '../../src/knowledge';
import { REPOSITORY_ROOT, type Dataset } from './dataset';
import type { EvalCase } from './schema';

/**
 * Leakage and drift guards. They answer one question: does the corpus still measure the engine, or has it started to
 * echo something? None of them runs the engine.
 *
 *  - overlap: no six-word run of any case text may appear in the two shipped samples, in the vocabulary descriptions, in
 *    the string literals of the knowledge pack, in the unit-test fixtures of the detectors, or in a case of another split;
 *  - reach: nothing under `packages/*` or `apps/*` source, and no test of a detector, may import or read the validation or
 *    the test cases (the evaluation tooling and the guard are the only readers).
 *
 * What a finding shows depends on where the text came from: a phrase of a shipped sample or of the vocabulary is shown;
 * a phrase of the knowledge pack, of a detector test or of another split is withheld, so that reading a finding never
 * teaches an author what a detector reads or what the other splits say. The place in the author's own text is always given.
 */

export const SHINGLE_WORDS = 6;

/** Lower-cased words; digits and dots inside a word stay (`a.kowal`, `10.20.1.10`), dots around a word do not. */
export function wordsOf(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}.]+/gu) ?? [])
    .map((word) => word.replace(/^\.+|\.+$/g, ''))
    .filter((word) => word !== '');
}

export function shingles(words: readonly string[], size = SHINGLE_WORDS): Set<string> {
  const out = new Set<string>();
  for (let index = 0; index + size <= words.length; index += 1) out.add(words.slice(index, index + size).join(' '));
  return out;
}

export type OverlapSourceKind = 'shipped-sample' | 'vocabulary' | 'knowledge-pack' | 'detector-test' | 'other-split';
const SHOWN: ReadonlySet<OverlapSourceKind> = new Set(['shipped-sample', 'vocabulary']);

export interface OverlapSource {
  readonly kind: OverlapSourceKind;
  readonly name: string;
  readonly shingles: ReadonlySet<string>;
}

export interface Overlap {
  readonly caseId: string;
  /** `title`, `scenario`, or the key of the event. */
  readonly where: string;
  readonly source: OverlapSourceKind;
  readonly sourceName: string;
  /** Word positions (1-based, inclusive) of the first run in the author's own text. */
  readonly firstWords: readonly [number, number];
  /** How many six-word windows matched in that text. */
  readonly windows: number;
  /** Only for sources that may be shown. */
  readonly phrase: string | null;
}

export const describeOverlap = (overlap: Overlap): string =>
  `${overlap.caseId} ${overlap.where}: words ${overlap.firstWords[0]}-${overlap.firstWords[1]} (${overlap.windows} window${overlap.windows === 1 ? '' : 's'}) also in ${overlap.sourceName}` +
  (overlap.phrase === null ? ' (phrase withheld)' : `: "${overlap.phrase}"`);

/** The text units of a case that an overlap is looked for in. */
export function textUnits(source: EvalCase): { where: string; text: string }[] {
  return [
    { where: 'title', text: source.title },
    { where: 'scenario', text: source.scenario },
    ...source.events.map((event) => ({ where: event.key, text: `${event.title ?? ''}\n${event.text}` })),
  ];
}

export function findOverlaps(cases: readonly EvalCase[], sources: readonly OverlapSource[]): Overlap[] {
  const found: Overlap[] = [];
  for (const source of cases) {
    for (const unit of textUnits(source)) {
      const words = wordsOf(unit.text);
      for (const known of sources) {
        // A reordered copy repeats its source on purpose, and a family is one scenario told more than once.
        if (known.kind === 'other-split' && known.name.startsWith(`${source.split}:`)) continue;
        let first: [number, number] | null = null;
        let windows = 0;
        for (let index = 0; index + SHINGLE_WORDS <= words.length; index += 1) {
          if (known.shingles.has(words.slice(index, index + SHINGLE_WORDS).join(' '))) {
            windows += 1;
            first ??= [index + 1, index + SHINGLE_WORDS];
          }
        }
        if (first !== null) {
          found.push({
            caseId: source.id,
            where: unit.where,
            source: known.kind,
            sourceName: known.kind === 'other-split' ? `a case of another split (${known.name.split(':')[0] ?? ''})` : known.name,
            firstWords: first,
            windows,
            phrase: SHOWN.has(known.kind) ? words.slice(first[0] - 1, first[1]).join(' ') : null,
          });
        }
      }
    }
  }
  return found;
}

// ---------------------------------------------------------------- the sources of text a case must not echo

function collectStrings(value: unknown, into: string[]): void {
  if (typeof value === 'string') into.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, into);
  else if (value !== null && typeof value === 'object') {
    for (const inner of Object.values(value as Record<string, unknown>)) collectStrings(inner, into);
  }
}

function shinglesOfStrings(strings: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const text of strings) for (const item of shingles(wordsOf(text))) out.add(item);
  return out;
}

function walk(directory: string, accept: (path: string) => boolean, skip: (path: string) => boolean): string[] {
  if (!existsSync(directory)) return [];
  const out: string[] = [];
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    if (name === 'node_modules' || name === 'dist' || name === '.next' || name.startsWith('.')) continue;
    if (skip(path)) continue;
    if (statSync(path).isDirectory()) out.push(...walk(path, accept, skip));
    else if (accept(path)) out.push(path);
  }
  return out;
}

const posix = (path: string): string => relative(REPOSITORY_ROOT, path).split(sep).join('/');

/** The two shipped samples (every string of the bundle). */
export function sampleSource(root = REPOSITORY_ROOT): OverlapSource {
  const strings: string[] = [];
  for (const file of walk(join(root, 'synthetic-data', 'cases'), (path) => path.endsWith('.json'), () => false)) {
    collectStrings(JSON.parse(readFileSync(file, 'utf8')) as unknown, strings);
  }
  return { kind: 'shipped-sample', name: 'a shipped sample', shingles: shinglesOfStrings(strings) };
}

/** The labels and descriptions of `evaluation/vocabulary.json`. */
export function vocabularySource(evaluationRoot: string): OverlapSource {
  const strings: string[] = [];
  collectStrings(JSON.parse(readFileSync(join(evaluationRoot, 'vocabulary.json'), 'utf8')) as unknown, strings);
  return { kind: 'vocabulary', name: 'the vocabulary', shingles: shinglesOfStrings(strings) };
}

/** Every string of the knowledge pack: labels, descriptions, ask texts and patterns. Read here, never by an author. */
export function packSource(): OverlapSource {
  const strings: string[] = [];
  collectStrings(TEAMS_AUTH_PACK, strings);
  return { kind: 'knowledge-pack', name: 'the knowledge pack', shingles: shinglesOfStrings(strings) };
}

const isEvaluationTooling = (path: string): boolean => {
  const name = posix(path);
  return name.startsWith('packages/domain/test/evaluation/') || /^packages\/domain\/test\/evaluation[^/]*\.test\.ts$/.test(name);
};

/** The unit tests and fixtures of the detectors: everything under `packages/domain/test` except the evaluation tooling. */
export function detectorTestSource(root = REPOSITORY_ROOT): OverlapSource {
  const files = walk(
    join(root, 'packages', 'domain', 'test'),
    (path) => /\.(ts|json|txt|md|csv)$/.test(path),
    isEvaluationTooling,
  );
  const words: string[] = [];
  for (const file of files) {
    // A string escape such as \n would otherwise glue the words around it together.
    const text = readFileSync(file, 'utf8').replace(/\\[nrt]/g, ' ');
    words.push(...wordsOf(text), '\u0000');
  }
  return { kind: 'detector-test', name: 'a detector test fixture', shingles: shingles(words) };
}

/** The case texts of one split, as a source for the cases of the others. */
export function splitSource(dataset: Dataset, split: string): OverlapSource {
  const words: string[] = [];
  for (const loaded of dataset.cases) {
    if (loaded.case.split !== split) continue;
    for (const unit of textUnits(loaded.case)) words.push(...wordsOf(unit.text), '\u0000');
  }
  return { kind: 'other-split', name: `${split}:`, shingles: shingles(words) };
}

// ---------------------------------------------------------------- who may read which split

const SOURCE_ROOTS = ['packages', 'apps'];
const READER_EXTENSIONS = /\.(ts|tsx|mjs|cjs|js)$/;

/** What the engine's own source may not mention at all: the evaluation data, its runs or its tooling. */
const ANY_EVALUATION_DATA = /evaluation\/(cases|annotations|runs)|eval-case\/2|eval-annotations\/2|test\/evaluation\//;
/** What no other source may reach: the validation and test cases, any annotation, or the tooling that loads them. */
const HIDDEN_EVALUATION_DATA =
  /(^|[^\w-])evaluation\/cases\/(test|validation)\b|evaluation\/annotations|evaluation\/(dataset|runner|run|labels|artifact|manifest|guard|engine|check|coverage|agreement|annotate)['"]/;

/** Why a source file may not contain this text, or null when it may. `name` is repository-relative with `/`. */
export function readerViolation(name: string, text: string): string | null {
  if (name.startsWith('packages/domain/src/')) {
    return ANY_EVALUATION_DATA.test(text) ? 'the engine source names the evaluation data' : null;
  }
  return HIDDEN_EVALUATION_DATA.test(text)
    ? 'reads the validation or test cases, the annotations or the evaluation loaders'
    : null;
}

/**
 * Files that read evaluation data without being the evaluation tooling or the guard: the engine's source may not know the
 * evaluation exists, and no other source or detector test may reach the validation or test cases, the annotations, or the
 * modules that load them (a detector may be tuned on the dev cases through `eval:dev`, which is a command, not an import).
 */
export function findForbiddenReaders(root = REPOSITORY_ROOT): { file: string; reason: string }[] {
  const offenders: { file: string; reason: string }[] = [];
  const files: string[] = [];
  for (const name of SOURCE_ROOTS) {
    files.push(...walk(join(root, name), (path) => READER_EXTENSIONS.test(path), isEvaluationTooling));
  }
  for (const file of files) {
    const reason = readerViolation(posix(file), readFileSync(file, 'utf8'));
    if (reason !== null) offenders.push({ file: posix(file), reason });
  }
  return offenders;
}
