import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { CaseBundleSchema } from '../packages/schemas/src/bundle';

/**
 * Generates `apps/api/src/samples/generated.ts`: the built-in synthetic sample cases
 * (`synthetic-data/cases/*.json`) and the downloadable example inputs (`synthetic-data/examples/`)
 * embedded as constants, because the API container ships only the bundle and has no access to the
 * repository's data files at run time.
 *
 *   pnpm samples:export            write the file
 *   pnpm samples:export -- --check fail (exit 1) when the committed file is out of date
 *
 * The output is formatted with the repository's Prettier configuration so `prettier --check` stays
 * green, and the generation is deterministic (a test compares it with the committed file).
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SAMPLES_OUTPUT = 'apps/api/src/samples/generated.ts';

interface SampleSpec {
  id: string;
  role: 'primary' | 'followup';
  source: string;
  description: string;
}

interface ExampleSpec {
  id: string;
  kind: 'case_bundle' | 'transcript' | 'csv';
  source: string;
  title: string;
  description: string;
  mediaType: string;
}

/** Case One is the primary worked example; Case Two is the related follow-up case. */
const SAMPLES: readonly SampleSpec[] = [
  {
    id: 'case-one-teams-signin-dns',
    role: 'primary',
    source: 'synthetic-data/cases/case-one-teams-signin-dns.json',
    description:
      'Synthetic multi-site incident: about 140 branch users cannot sign in to Teams reliably. Triage starts from a Conditional Access hypothesis; the documented root cause is a DNS policy change on one of two branch resolvers.',
  },
  {
    id: 'case-two-teams-signin-proxy',
    role: 'followup',
    source: 'synthetic-data/cases/case-two-teams-signin-proxy.json',
    description:
      'A related but different synthetic case: about 60 users at one site; the documented root cause is one saturated proxy node after a TLS inspection change. It illustrates the measurement pipeline on a second case, not real-world effectiveness.',
  },
];

const EXAMPLES: readonly ExampleSpec[] = [
  {
    id: 'transcript-teams-signin-proxy',
    kind: 'transcript',
    source: 'synthetic-data/examples/transcript-teams-signin-proxy.txt',
    title: 'Pasted transcript (e-mail thread)',
    description:
      'A synthetic transcript for the Paste tab: e-mails with From:, Sent: and Subject: lines, a quoted reply, chat-style case notes and a KQL result.',
    mediaType: 'text/plain; charset=utf-8',
  },
  {
    id: 'events-teams-signin-proxy',
    kind: 'csv',
    source: 'synthetic-data/examples/events-teams-signin-proxy.csv',
    title: 'CSV event export',
    description:
      'A shorter variant of the same story as a spreadsheet export: quoted commas, escaped quotes, an embedded line break, action columns and reply links.',
    mediaType: 'text/csv; charset=utf-8',
  },
  {
    id: 'minimal-case-bundle',
    kind: 'case_bundle',
    source: 'synthetic-data/examples/minimal-case-bundle.json',
    title: 'Minimal case bundle (JSON)',
    description:
      'The smallest valid caseguard.case-bundle/1 document: two participants, three events and no resolution.',
    mediaType: 'application/json; charset=utf-8',
  },
];

export interface PlannedFile {
  /** Path relative to the repository root, with forward slashes. */
  path: string;
  content: string;
}

export interface ExportResult {
  written: string[];
  unchanged: string[];
  /** Files whose content differs from the plan (only populated in check mode). */
  stale: string[];
}

const literal = (value: string): string => JSON.stringify(value);

/** The file as an array of line literals joined at run time: readable diffs, exact content. */
function textExpression(text: string): string {
  return `[${text.split('\n').map(literal).join(',')}].join('\\n')`;
}

async function readSource(root: string, path: string): Promise<string> {
  return (await readFile(resolve(root, path), 'utf8')).replace(/\r\n/g, '\n');
}

async function sampleLiteral(root: string, spec: SampleSpec): Promise<string> {
  const json = await readSource(root, spec.source);
  const parsed = CaseBundleSchema.safeParse(JSON.parse(json));
  if (!parsed.success || !parsed.data.synthetic) {
    throw new Error(`${spec.source} is not a valid synthetic case bundle`);
  }
  return `{
    id: ${literal(spec.id)},
    role: ${literal(spec.role)},
    fileName: ${literal(basename(spec.source))},
    description: ${literal(spec.description)},
    json: ${textExpression(json)},
  }`;
}

async function exampleLiteral(root: string, spec: ExampleSpec): Promise<string> {
  const text = await readSource(root, spec.source);
  if (spec.kind === 'case_bundle' && !CaseBundleSchema.safeParse(JSON.parse(text)).success) {
    throw new Error(`${spec.source} is not a valid case bundle`);
  }
  return `{
    id: ${literal(spec.id)},
    kind: ${literal(spec.kind)},
    title: ${literal(spec.title)},
    description: ${literal(spec.description)},
    fileName: ${literal(basename(spec.source))},
    mediaType: ${literal(spec.mediaType)},
    text: ${textExpression(text)},
  }`;
}

/** Computes the generated module without touching the file system (apart from reading the sources). */
export async function planSamplesFile(root: string = REPO_ROOT): Promise<PlannedFile> {
  const samples = await Promise.all(SAMPLES.map((spec) => sampleLiteral(root, spec)));
  const examples = await Promise.all(EXAMPLES.map((spec) => exampleLiteral(root, spec)));
  const raw = `/*
 * GENERATED FILE. Do not edit by hand.
 * Source: synthetic-data/cases/*.json and synthetic-data/examples/ (all data is synthetic).
 * Regenerate with "pnpm samples:export"; "pnpm samples:export -- --check" fails when it is stale.
 */
import type { GeneratedExampleFile, GeneratedSampleBundle } from './types';

export const GENERATED_SAMPLE_BUNDLES: readonly GeneratedSampleBundle[] = [${samples.join(',')}];

export const GENERATED_EXAMPLE_FILES: readonly GeneratedExampleFile[] = [${examples.join(',')}];
`;
  const config = await resolveConfig(resolve(root, SAMPLES_OUTPUT));
  return { path: SAMPLES_OUTPUT, content: await format(raw, { ...config, parser: 'typescript' }) };
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Writes the generated module, or, with `check`, only reports whether it differs. */
export async function exportSamples(
  options: { root?: string; check?: boolean } = {},
): Promise<ExportResult> {
  const root = options.root ?? REPO_ROOT;
  const result: ExportResult = { written: [], unchanged: [], stale: [] };
  const file = await planSamplesFile(root);
  const target = resolve(root, file.path);
  const current = await readIfExists(target);
  if (current?.replace(/\r\n/g, '\n') === file.content) {
    result.unchanged.push(file.path);
  } else if (options.check) {
    result.stale.push(file.path);
  } else {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, 'utf8');
    result.written.push(file.path);
  }
  return result;
}

async function main(argv: readonly string[]): Promise<number> {
  const check = argv.includes('--check');
  const result = await exportSamples({ check });
  if (check) {
    if (result.stale.length > 0) {
      console.error(
        `The embedded sample data is out of date. Run "pnpm samples:export" and commit:\n${result.stale
          .map((path) => `  - ${path}`)
          .join('\n')}`,
      );
      return 1;
    }
    console.log('The embedded sample data is up to date.');
    return 0;
  }
  for (const path of result.written) console.log(`wrote     ${path}`);
  for (const path of result.unchanged) console.log(`unchanged ${path}`);
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
