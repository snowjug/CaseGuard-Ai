import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import {
  AnnotationFileSchema,
  AnnotatorRegistrySchema,
  EvalCaseSchema,
  LockedRunsSchema,
  ManifestSchema,
  SPLITS,
  type AnnotationFile,
  type AnnotatorRegistry,
  type EvalCase,
  type LockedRuns,
  type Manifest,
  type Split,
} from './schema';

/** `evaluation/` at the repository root, and the repository root itself. */
export const EVALUATION_ROOT = resolve(import.meta.dirname, '../../../../evaluation');
export const REPOSITORY_ROOT = resolve(EVALUATION_ROOT, '..');

export const sha256 = (data: string | Uint8Array): string =>
  createHash('sha256').update(data).digest('hex');

export interface DigestEvent {
  readonly key: string;
  readonly at: number;
  readonly who: string;
  readonly type: string;
  readonly channel: string;
  readonly title?: string | undefined;
  readonly text: string;
}

/** A hash of what the events of a case say: used to show that a migration kept every word, time and author. */
export function eventsDigest(events: readonly DigestEvent[]): string {
  return sha256(
    canonicalJson(
      events.map((event) => ({
        key: event.key,
        at: event.at,
        who: event.who,
        type: event.type,
        channel: event.channel,
        title: event.title ?? null,
        text: event.text,
      })),
    ),
  );
}

/**
 * Writes JSON the way the repository's formatter would, so that a file the tools write is never reformatted (and so
 * re-hashed) by the next `prettier --write`.
 */
export async function writeJson(path: string, value: unknown): Promise<void> {
  const { format, resolveConfig } = await import('prettier');
  const config = (await resolveConfig(path)) ?? {};
  writeFileSync(path, await format(JSON.stringify(value, null, 2), { ...config, filepath: path }));
}

/** JSON with sorted keys and no whitespace, so that equal values always hash alike. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, inner]) => inner !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonicalJson(inner)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export interface LoadedCase {
  readonly case: EvalCase;
  /** Path of the case file relative to the evaluation root. */
  readonly caseFile: string;
  readonly eventsSha256: string;
  readonly annotations: AnnotationFile | null;
  readonly annotationsFile: string | null;
  readonly annotationsSha256: string | null;
}

export interface Dataset {
  readonly root: string;
  readonly cases: readonly LoadedCase[];
  readonly annotators: AnnotatorRegistry | null;
  readonly manifest: Manifest | null;
  /** Files that could not be read or did not match their schema. A well-formed dataset has none. */
  readonly problems: readonly string[];
}

const MAX_ISSUES_PER_FILE = 6;

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, MAX_ISSUES_PER_FILE)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

interface ParsedFile<T> {
  readonly value: T | null;
  readonly sha256: string | null;
  readonly problem: string | null;
}

export function readParsed<T>(path: string, label: string, schema: z.ZodType<T>): ParsedFile<T> {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    return { value: null, sha256: null, problem: `${label}: cannot read (${String(error)})` };
  }
  const hash = sha256(bytes);
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    return { value: null, sha256: hash, problem: `${label}: not valid JSON (${String(error)})` };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return { value: null, sha256: hash, problem: `${label}: ${describeIssues(parsed.error)}` };
  }
  return { value: parsed.data, sha256: hash, problem: null };
}

const jsonFiles = (directory: string): string[] =>
  existsSync(directory)
    ? readdirSync(directory)
        .filter((name) => name.endsWith('.json'))
        .sort()
    : [];

export interface LoadOptions {
  readonly root?: string;
  /** Only these splits are read: a run on the dev split never opens the files of another one. */
  readonly splits?: readonly Split[];
}

export function loadDataset(options: LoadOptions = {}): Dataset {
  const root = options.root ?? EVALUATION_ROOT;
  const problems: string[] = [];
  const cases: LoadedCase[] = [];
  for (const split of options.splits ?? SPLITS) {
    for (const name of jsonFiles(join(root, 'cases', split))) {
      const caseFile = `cases/${split}/${name}`;
      const parsed = readParsed(join(root, caseFile), caseFile, EvalCaseSchema);
      if (parsed.problem !== null || parsed.value === null || parsed.sha256 === null) {
        problems.push(parsed.problem ?? `${caseFile}: unreadable`);
        continue;
      }
      const annotationsFile = `annotations/${parsed.value.id}.json`;
      const annotationPath = join(root, annotationsFile);
      let annotations: AnnotationFile | null = null;
      let annotationsSha256: string | null = null;
      if (existsSync(annotationPath)) {
        const annotation = readParsed(annotationPath, annotationsFile, AnnotationFileSchema);
        annotationsSha256 = annotation.sha256;
        if (annotation.problem !== null) problems.push(annotation.problem);
        else annotations = annotation.value;
      }
      cases.push({
        case: parsed.value,
        caseFile,
        eventsSha256: parsed.sha256,
        annotations,
        annotationsFile: existsSync(annotationPath) ? annotationsFile : null,
        annotationsSha256,
      });
    }
  }
  return {
    root,
    cases,
    annotators: readOptional(join(root, 'annotators.json'), 'annotators.json', AnnotatorRegistrySchema, problems),
    manifest: readOptional(join(root, 'manifest.json'), 'manifest.json', ManifestSchema, problems),
    problems,
  };
}

function readOptional<T>(path: string, label: string, schema: z.ZodType<T>, problems: string[]): T | null {
  if (!existsSync(path)) return null;
  const parsed = readParsed(path, label, schema);
  if (parsed.problem !== null) problems.push(parsed.problem);
  return parsed.value;
}

export const readManifest = (root = EVALUATION_ROOT): Manifest | null => {
  const problems: string[] = [];
  const manifest = readOptional(join(root, 'manifest.json'), 'manifest.json', ManifestSchema, problems);
  if (problems.length > 0) throw new Error(problems.join('\n'));
  return manifest;
};

export function readLockedRuns(root = EVALUATION_ROOT): LockedRuns | null {
  const problems: string[] = [];
  const runs = readOptional(
    join(root, 'runs', 'locked-runs.json'),
    'runs/locked-runs.json',
    LockedRunsSchema,
    problems,
  );
  if (problems.length > 0) throw new Error(problems.join('\n'));
  return runs;
}

// ---------------------------------------------------------------- vocabulary

const VocabularySchema = z.object({
  workload: z.string(),
  packId: z.string(),
  packVersion: z.string(),
  dimensions: z.array(z.object({ id: z.string(), description: z.string() })),
  signals: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      description: z.string(),
      dimension: z.string(),
      kind: z.enum(['presence', 'absence']),
    }),
  ),
  actions: z.array(
    z.object({ id: z.string(), label: z.string(), description: z.string(), executor: z.string() }),
  ),
  hypotheses: z.array(z.object({ id: z.string(), name: z.string(), description: z.string() })),
  forkCategories: z.array(z.object({ id: z.string(), label: z.string() })),
  conflictClasses: z.array(z.object({ id: z.string(), label: z.string() })),
});
export type VocabularyData = z.infer<typeof VocabularySchema>;

/** The words an annotator may use, read from `evaluation/vocabulary.json` (identifiers, labels, plain descriptions). */
export function loadVocabulary(root = EVALUATION_ROOT): VocabularyData {
  const parsed = readParsed(join(root, 'vocabulary.json'), 'vocabulary.json', VocabularySchema);
  if (parsed.problem !== null || parsed.value === null) {
    throw new Error(parsed.problem ?? 'vocabulary.json is unreadable');
  }
  return parsed.value;
}

export const signalDimensionsOf = (vocabulary: VocabularyData): ReadonlyMap<string, string> =>
  new Map(vocabulary.signals.map((signal) => [signal.id, signal.dimension]));

// ---------------------------------------------------------------- set hashes

/** The hash that locks the test split: every case file hash and every annotation file hash, by case id. */
export function testSetHash(
  cases: readonly Pick<LoadedCase, 'case' | 'eventsSha256' | 'annotationsSha256'>[],
): string {
  const lines = cases
    .map((entry) => `${entry.case.id}:${entry.eventsSha256}:${entry.annotationsSha256 ?? '-'}`)
    .sort();
  return sha256(lines.join('\n'));
}

/** The hash of the case files alone (events), by case id. */
export function caseSetHash(cases: readonly Pick<LoadedCase, 'case' | 'eventsSha256'>[]): string {
  return sha256(
    cases
      .map((entry) => `${entry.case.id}:${entry.eventsSha256}`)
      .sort()
      .join('\n'),
  );
}
