import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRecord } from './check';
import { EVALUATION_ROOT, loadDataset, loadVocabulary, writeJson, type Dataset } from './dataset';
import {
  ANNOTATOR_KINDS,
  AnnotationDraftSchema,
  EVAL_ANNOTATIONS_SCHEMA,
  EVAL_ANNOTATORS_SCHEMA,
  EVAL_DRAFT_SCHEMA,
  type AnnotationDraft,
  type AnnotationFile,
  type AnnotationRecord,
  type AnnotatorKind,
  type AnnotatorRegistry,
  type EvalCase,
} from './schema';

/**
 * The workflow for a second annotator, who must be blind to the first one's labels:
 *
 *   1. `eval:annotate -- --case <id> --annotator <annotator id> [--kind ai_draft|human]` writes an empty draft to
 *      `evaluation/pending/<annotator id>/<case id>.json`. It holds no label of any other annotator.
 *   2. The annotator reads the case file, `ANNOTATION_GUIDE.md` and `vocabulary.json`, and fills the draft. They never open
 *      `evaluation/annotations/` or a draft of another annotator.
 *   3. Someone else (not the annotator) runs `eval:annotate -- --merge <draft>...`. The draft is checked like any record
 *      and appended to the case's annotation file; the case is then `unadjudicated` until a decision is recorded.
 *   4. `eval:agreement` compares the two annotators and lists what to adjudicate.
 */

export const PLACEHOLDER = 'FILL IN';

export const DRAFT_INSTRUCTIONS: readonly string[] = [
  'Read only the case file, evaluation/ANNOTATION_GUIDE.md and evaluation/vocabulary.json. Do not open evaluation/annotations/ or any other annotator draft, and do not run the engine.',
  'Write the rationale first, in your own words (2 to 6 sentences), before you label. Label what the text means, never from detector patterns or engine output.',
  'signals is exhaustive per event; actions is exhaustive on the events an engineer wrote; absent lists the words of a signal or action that appear without the fact being stated.',
  'An empty list or null is an answer ("none"). A label kind you delete is "not annotated" and is skipped by the measures.',
  'Replace every FILL IN. A draft that still holds one is refused.',
];

export function makeDraft(
  source: Pick<EvalCase, 'id'>,
  annotatorId: string,
  kind: AnnotatorKind,
  now: string,
): AnnotationDraft {
  return {
    schema: EVAL_DRAFT_SCHEMA,
    caseId: source.id,
    instructions: [...DRAFT_INSTRUCTIONS],
    record: {
      annotatorId,
      kind,
      version: 1,
      annotatedAt: now,
      excluded: false,
      exclusionReason: null,
      signals: [],
      actions: [],
      absent: [],
      forks: [],
      earliestMissed: null,
      counterfactualDirection: 'unclear',
      conflicts: [],
      qualityBand: null,
      causes: [],
      rationale: `${PLACEHOLDER}: why these labels, two to six sentences.`,
      uncertainty: 'none',
    },
  };
}

/** Appends a record to a case's annotation file (a new file when the case has none). The adjudication is kept as it is. */
export function mergeRecord(
  file: AnnotationFile | null,
  caseId: string,
  record: AnnotationRecord,
): AnnotationFile {
  const base: AnnotationFile = file ?? {
    schema: EVAL_ANNOTATIONS_SCHEMA,
    caseId,
    annotations: [],
    adjudication: null,
  };
  if (
    base.annotations.some(
      (entry) => entry.annotatorId === record.annotatorId && entry.version === record.version,
    )
  ) {
    throw new Error(
      `${caseId}: ${record.annotatorId} already has a record of version ${record.version}; use a higher version`,
    );
  }
  return { ...base, annotations: [...base.annotations, record] };
}

export function registerAnnotator(
  registry: AnnotatorRegistry | null,
  id: string,
  kind: AnnotatorKind,
  description: string,
  now: string,
): AnnotatorRegistry {
  const base: AnnotatorRegistry = registry ?? { schema: EVAL_ANNOTATORS_SCHEMA, annotators: [] };
  if (base.annotators.some((entry) => entry.id === id)) return base;
  return { ...base, annotators: [...base.annotators, { id, kind, description, addedAt: now }] };
}

function validateDraft(dataset: Dataset, draft: AnnotationDraft, source: string): string[] {
  const loaded = dataset.cases.find((entry) => entry.case.id === draft.caseId);
  if (!loaded) return [`${source}: there is no case ${draft.caseId}`];
  if (loaded.case.derivedFrom !== null)
    return [`${source}: ${draft.caseId} is a reordered copy and has no labels of its own`];
  const errors: string[] = [];
  if (JSON.stringify(draft).includes(PLACEHOLDER))
    errors.push(`${source}: the draft still holds "${PLACEHOLDER}"`);
  const registry = new Map(
    (dataset.annotators?.annotators ?? []).map((entry) => [entry.id, entry.kind as string]),
  );
  checkRecord(loaded, draft.record, loadVocabulary(dataset.root), registry, errors);
  return errors;
}

const now = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const fail = (message: string): void => {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
};

async function main(args: readonly string[]): Promise<void> {
  const option = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const dataset = loadDataset({ root: EVALUATION_ROOT });
  if (dataset.problems.length > 0) return fail(dataset.problems.join('\n'));

  if (args.includes('--merge')) {
    const files = args.slice(args.indexOf('--merge') + 1).filter((arg) => !arg.startsWith('--'));
    if (files.length === 0) return fail('usage: annotate.ts --merge <draft.json>...');
    const problems: string[] = [];
    const drafts = files.map((file) => {
      const parsed = AnnotationDraftSchema.safeParse(
        JSON.parse(readFileSync(resolve(file), 'utf8')),
      );
      if (!parsed.success) {
        problems.push(
          `${file}: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
        );
        return null;
      }
      problems.push(...validateDraft(dataset, parsed.data, file));
      return parsed.data;
    });
    if (problems.length > 0) return fail(problems.join('\n'));
    for (const draft of drafts) {
      if (!draft) continue;
      const loaded = dataset.cases.find((entry) => entry.case.id === draft.caseId);
      const target = join(EVALUATION_ROOT, 'annotations', `${draft.caseId}.json`);
      await writeJson(target, mergeRecord(loaded?.annotations ?? null, draft.caseId, draft.record));
      process.stdout.write(
        `merged ${draft.record.annotatorId} v${draft.record.version} into annotations/${draft.caseId}.json\n`,
      );
    }
    process.stdout.write('Now run eval:manifest, then eval:agreement.\n');
    return;
  }

  const caseId = option('--case');
  const annotatorId = option('--annotator');
  const kind = (option('--kind') ?? 'ai_draft') as AnnotatorKind;
  if (!caseId || !annotatorId)
    return fail(
      'usage: annotate.ts --case <case id> --annotator <annotator id> [--kind ai_draft|human] [--register "<description>"]',
    );
  if (!ANNOTATOR_KINDS.includes(kind))
    return fail(`--kind must be one of ${ANNOTATOR_KINDS.join(', ')}`);
  const source = dataset.cases.find((entry) => entry.case.id === caseId);
  if (!source) return fail(`there is no case ${caseId}`);
  if (source.case.derivedFrom !== null)
    return fail(`${caseId} is a reordered copy and has no labels of its own`);

  const description = option('--register');
  if (description !== undefined) {
    await writeJson(
      join(EVALUATION_ROOT, 'annotators.json'),
      registerAnnotator(dataset.annotators, annotatorId, kind, description, now()),
    );
    process.stdout.write(`registered ${annotatorId} (${kind}) in annotators.json\n`);
  }
  const target = option('--out') ?? join(EVALUATION_ROOT, 'pending', annotatorId, `${caseId}.json`);
  if (existsSync(target)) return fail(`${target} already exists; fill it in, or delete it first`);
  mkdirSync(dirname(target), { recursive: true });
  await writeJson(target, makeDraft(source.case, annotatorId, kind, now()));
  process.stdout.write(
    `wrote ${target}\nFill it in (the case file is cases/${source.case.split}/${caseId}.json), then ask for it to be merged.\n`,
  );
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main(process.argv.slice(2));
