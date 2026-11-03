import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TOOL_EVENT_TYPES } from './bundle';
import { EVALUATION_ROOT, REPOSITORY_ROOT, writeJson } from './dataset';
import {
  EVAL_ANNOTATIONS_SCHEMA,
  EVAL_CASE_SCHEMA,
  type AnnotationFile,
  type EvalCase,
} from './schema';
import { WAVE1_ANNOTATOR, WAVE1_COMMIT, WAVE1_PLAN, wave1IdOf, type MigrationPlan } from './wave1-plan';

/**
 * One-off: turns the 16 cases of the Wave 1 corpus (`corpus-*.ts` as of commit c5f5d96, deleted afterwards) into the JSON
 * case and annotation files of framework v2, in the dev split. Run with `pnpm --filter @caseguard/domain run eval:migrate`.
 *
 * Nothing is added to what Wave 1 labelled: the signals of each event, the earliest missed moment and the accepted
 * causes (an empty list for a story that is not a sign-in failure). Actions, absences, forks, conflicts, the
 * counterfactual direction and the quality band were never annotated, so they are left out, and the measures skip them.
 * The labels keep their author: annotator `copilot-wave1`, an AI assistant (kind `ai_draft`), not a human.
 * The legacy sources are read from git into a scratch directory next to this file and removed afterwards.
 */

const LEGACY_DIRECTORY = 'packages/domain/test/evaluation';
const LEGACY_FILES = ['types.ts', 'corpus-paraphrase.ts', 'corpus-other.ts'] as const;
/** The commit that added the Wave 1 corpus: when its labels were written. */
const LEGACY_ANNOTATED_AT = '2026-11-02T19:59:46Z';
const OPENED_AT = '2026-06-02T08:00:00Z';

interface LegacyEvent {
  key: string;
  at: number;
  who: 'customer' | 'network' | 'enduser' | 'engineer' | 'system';
  type: EvalCase['events'][number]['type'];
  channel?: EvalCase['events'][number]['channel'];
  title?: string;
  text: string;
  signals?: readonly string[];
}

interface LegacyCase {
  id: string;
  group: 'paraphrase' | 'noisy' | 'negative' | 'reordered';
  about: string;
  events: readonly LegacyEvent[];
  earliestMissed: string | null;
  causes?: readonly string[];
  basedOn?: string;
  order?: readonly string[];
}

const PLAN = WAVE1_PLAN;
const newId = wave1IdOf;

function readLegacyCases(scratch: string): Promise<readonly LegacyCase[]> {
  mkdirSync(scratch, { recursive: true });
  for (const name of LEGACY_FILES) {
    const source = execFileSync('git', ['show', `${WAVE1_COMMIT}:${LEGACY_DIRECTORY}/${name}`], {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    writeFileSync(join(scratch, name), source);
  }
  return Promise.all([
    import(pathToFileURL(join(scratch, 'corpus-paraphrase.ts')).href) as Promise<{
      PARAPHRASE_CASES: readonly LegacyCase[];
    }>,
    import(pathToFileURL(join(scratch, 'corpus-other.ts')).href) as Promise<{
      NOISY_CASES: readonly LegacyCase[];
      NEGATIVE_CASES: readonly LegacyCase[];
      REORDERED_CASES: readonly LegacyCase[];
    }>,
  ]).then(([paraphrase, other]) => [
    ...paraphrase.PARAPHRASE_CASES,
    ...other.NOISY_CASES,
    ...other.NEGATIVE_CASES,
    ...other.REORDERED_CASES,
  ]);
}

function convertCase(legacy: LegacyCase, plan: MigrationPlan, idOf: Map<string, string>): EvalCase {
  const derivedFrom = legacy.basedOn === undefined ? null : (idOf.get(legacy.basedOn) ?? null);
  if (legacy.basedOn !== undefined && derivedFrom === null) {
    throw new Error(`${legacy.id}: its source ${legacy.basedOn} is not in the plan`);
  }
  return {
    schema: EVAL_CASE_SCHEMA,
    id: newId(plan),
    split: 'dev',
    family: plan.family,
    // Wave 1 gave the bundle this exact title; keeping it keeps what the engine reads unchanged.
    title: `Evaluation case ${legacy.id}: ${legacy.about}`.slice(0, 200),
    scenario: `${legacy.about.charAt(0).toUpperCase()}${legacy.about.slice(1)}.`,
    categories: [...plan.categories],
    workload: 'teams-authentication',
    openedAt: OPENED_AT,
    derivedFrom,
    handedOverOrder: legacy.order ? [...legacy.order] : null,
    events: legacy.events.map((event) => ({
      key: event.key,
      at: event.at,
      who: event.who,
      type: event.type,
      channel: event.channel ?? (TOOL_EVENT_TYPES.has(event.type) ? 'tool' : 'email'),
      ...(event.title ? { title: event.title } : {}),
      text: event.text,
    })),
  };
}

function convertAnnotations(legacy: LegacyCase, id: string): AnnotationFile {
  return {
    schema: EVAL_ANNOTATIONS_SCHEMA,
    caseId: id,
    annotations: [
      {
        annotatorId: WAVE1_ANNOTATOR,
        kind: 'ai_draft',
        version: 1,
        annotatedAt: LEGACY_ANNOTATED_AT,
        excluded: false,
        exclusionReason: null,
        signals: legacy.events.flatMap((event) =>
          (event.signals ?? []).map((signal) => ({ event: event.key, id: signal })),
        ),
        earliestMissed: legacy.earliestMissed,
        causes: [...(legacy.causes ?? [])],
        rationale:
          'Migrated without change from the Wave 1 corpus. Every event lists the signals a reader of that event would say ' +
          'it states, judged against the signal descriptions and not against the detector patterns; the story names the ' +
          'cause or causes a reader of the whole story accepts and the earliest missed moment where there is one. ' +
          'An AI assistant wrote these labels, no human checked them, and Wave 1 recorded no uncertainty per label.',
        uncertainty: 'low',
      },
    ],
    adjudication: null,
  };
}

async function main(): Promise<void> {
  const scratch = join(import.meta.dirname, '.legacy-wave1');
  try {
    const legacyCases = await readLegacyCases(scratch);
    const idOf = new Map(PLAN.map((plan) => [plan.legacyId, newId(plan)]));
    mkdirSync(join(EVALUATION_ROOT, 'cases', 'dev'), { recursive: true });
    mkdirSync(join(EVALUATION_ROOT, 'annotations'), { recursive: true });
    let events = 0;
    let signals = 0;
    for (const plan of PLAN) {
      const legacy = legacyCases.find((candidate) => candidate.id === plan.legacyId);
      if (!legacy) throw new Error(`the Wave 1 corpus has no case ${plan.legacyId}`);
      const converted = convertCase(legacy, plan, idOf);
      await writeJson(join(EVALUATION_ROOT, 'cases', 'dev', `${converted.id}.json`), converted);
      events += converted.events.length;
      if (converted.derivedFrom === null) {
        const annotations = convertAnnotations(legacy, converted.id);
        await writeJson(join(EVALUATION_ROOT, 'annotations', `${converted.id}.json`), annotations);
        signals += annotations.annotations[0]?.signals.length ?? 0;
      }
    }
    process.stdout.write(
      `migrated ${PLAN.length} cases (${events} events, ${signals} labelled signal occurrences in the independent ones)\n`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

await main();
