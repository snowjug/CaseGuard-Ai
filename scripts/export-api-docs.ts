import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { ROUTES, type RouteSpec } from '../packages/schemas/src/api';

/**
 * Regenerates the route reference of `docs/API.md` from the `ROUTES` registry in
 * `packages/schemas/src/api.ts`, the only authority on the HTTP contract.
 *
 *   pnpm docs:api            rewrite the generated block
 *   pnpm docs:api -- --check fail (exit 1) when docs/API.md is out of date
 *
 * Only the text between the two marker comments is generated; everything else in the file is
 * written by hand. The whole file is formatted with the repository's Prettier configuration so
 * `prettier --check` stays green, and the generation is deterministic (a test compares it with the
 * committed file, and `pnpm verify` runs `--check` in its `generated:check` step).
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const API_DOC_PATH = 'docs/API.md';
export const BEGIN_MARKER =
  '<!-- BEGIN GENERATED ROUTE REFERENCE: written by scripts/export-api-docs.ts, do not edit by hand -->';
export const END_MARKER = '<!-- END GENERATED ROUTE REFERENCE -->';

/**
 * Routes whose `permission` is null, and what that means. A new null-permission route makes the
 * generator throw, so nobody can add one without deciding how the reference describes it.
 */
export const PERMISSION_NOTES: Readonly<Record<string, string>> = {
  'session.me': 'any signed-in user',
  'jobs.cancel':
    'any signed-in user; the job service then requires the permission that starts that kind of job',
  'dev.personas': 'none (public); lists personas only when development identity is enabled',
};

export interface RouteEntry {
  readonly id: string;
  readonly spec: RouteSpec;
}

/** The registry in declaration order. */
export function routeEntries(routes: Readonly<Record<string, RouteSpec>> = ROUTES): RouteEntry[] {
  return Object.entries(routes).map(([id, spec]) => ({ id, spec }));
}

interface FieldLike {
  /** Zod 4 keeps whether a key may be left out in `optin` ("optional" or "defaulted"). */
  _zod?: { optin?: string };
  safeParse(value: unknown): { success: boolean };
}
interface ObjectLike {
  shape: Record<string, FieldLike>;
}

function isObjectLike(value: unknown): value is ObjectLike {
  if (typeof value !== 'object' || value === null || !('shape' in value)) return false;
  const { shape } = value;
  return typeof shape === 'object' && shape !== null;
}

/** True when the key may be left out of the object (a `z.unknown()` field is still required). */
function mayBeLeftOut(field: FieldLike): boolean {
  if (field._zod !== undefined) {
    return field._zod.optin === 'optional' || field._zod.optin === 'defaulted';
  }
  return field.safeParse(undefined).success;
}

/**
 * The top-level fields of an object schema, `name?` when the field may be left out (optional or
 * defaulted). Null for a schema that is not a plain object (the OpenAPI document has the detail).
 */
export function fieldNames(schema: unknown): string[] | null {
  if (!isObjectLike(schema)) return null;
  return Object.entries(schema.shape).map(([name, field]) =>
    mayBeLeftOut(field) ? `${name}?` : name,
  );
}

const cell = (text: string): string => text.replace(/\|/g, '\\|');
const code = (text: string): string => `\`${text}\``;
const codeList = (names: readonly string[]): string => names.map(code).join(', ');

function inputCell(spec: RouteSpec): string {
  const lines: string[] = [];
  if (spec.query !== undefined) {
    const names = fieldNames(spec.query);
    lines.push(`query: ${names === null ? 'see the schema' : codeList(names)}`);
  }
  if (spec.multipart === true) {
    lines.push('multipart: `file`');
  } else if (spec.body !== undefined) {
    const names = fieldNames(spec.body);
    lines.push(`body: ${names === null ? 'see the schema' : codeList(names)}`);
  }
  return lines.length === 0 ? 'none' : lines.join('<br>');
}

function successCell(spec: RouteSpec): string {
  const status = spec.status ?? 200;
  const parts: string[] = [String(status)];
  const response = fieldNames(spec.response);
  if (status === 202 && response?.some((name) => name === 'job' || name === 'job?') === true) {
    parts.push('job');
  }
  if (spec.idempotent === true) parts.push('idempotent');
  return parts.join(', ');
}

function permissionCell(entry: RouteEntry): string {
  if (entry.spec.permission !== null) return code(entry.spec.permission);
  const note = PERMISSION_NOTES[entry.id];
  if (note === undefined) {
    throw new Error(
      `Route ${entry.id} has no permission and no entry in PERMISSION_NOTES (scripts/export-api-docs.ts): describe how it is protected.`,
    );
  }
  return note;
}

function rowOf(entry: RouteEntry): string {
  const { id, spec } = entry;
  return `| ${[
    code(id),
    code(`${spec.method} ${spec.path}`),
    cell(permissionCell(entry)),
    successCell(spec),
    cell(inputCell(spec)),
    cell(spec.summary),
  ].join(' | ')} |`;
}

const HEADER = [
  '| Route id | Request | Permission | Success | Input | Summary |',
  '| --- | --- | --- | --- | --- | --- |',
];

const METHOD_ORDER: readonly string[] = ['GET', 'POST', 'PUT', 'DELETE'];

/**
 * The generated block: a count line and one table per group (the first tag of a route), in
 * declaration order. Pure and deterministic.
 */
export function renderRouteReference(routes: Readonly<Record<string, RouteSpec>> = ROUTES): string {
  const entries = routeEntries(routes);
  // Plain arrays and records: the script runs without a tsconfig of its own, so iterating a Map would be untyped there.
  const groupOrder: string[] = [];
  const groups: Record<string, RouteEntry[]> = {};
  for (const entry of entries) {
    const tag = entry.spec.tags[0] ?? 'Other';
    const group = groups[tag];
    if (group === undefined) {
      groups[tag] = [entry];
      groupOrder.push(tag);
    } else {
      group.push(entry);
    }
  }
  const methods = new Map<string, number>();
  for (const { spec } of entries) methods.set(spec.method, (methods.get(spec.method) ?? 0) + 1);
  const byMethod = METHOD_ORDER.filter((method) => methods.has(method))
    .map((method) => `${methods.get(method) ?? 0} ${method}`)
    .join(', ');

  const out: string[] = [
    `${entries.length} routes (${byMethod}) in ${groupOrder.length} groups, generated from \`ROUTES\` in \`packages/schemas/src/api.ts\`.`,
    'A trailing `?` marks a field that may be left out; path parameters are the `:name` segments of the request. Every path starts with `/api/v1`.',
  ];
  for (const tag of groupOrder) {
    out.push('', `### ${tag}`, '', ...HEADER, ...(groups[tag] ?? []).map(rowOf));
  }
  return `${out.join('\n')}\n`;
}

export class MarkerError extends Error {}

/** Replaces the text between the markers (the markers stay). Throws when they are missing or misplaced. */
export function insertRouteReference(markdown: string, reference: string): string {
  const begin = markdown.indexOf(BEGIN_MARKER);
  const end = markdown.indexOf(END_MARKER);
  if (begin === -1 || end === -1 || markdown.indexOf(BEGIN_MARKER, begin + 1) !== -1) {
    throw new MarkerError(
      `${API_DOC_PATH} needs exactly one BEGIN and one END marker around the generated route reference.`,
    );
  }
  if (end < begin) {
    throw new MarkerError(`${API_DOC_PATH}: the END marker comes before the BEGIN marker.`);
  }
  return `${markdown.slice(0, begin)}${BEGIN_MARKER}\n\n${reference}\n${markdown.slice(end)}`;
}

export interface PlannedFile {
  /** Path relative to the repository root, with forward slashes. */
  path: string;
  content: string;
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return (await readFile(path, 'utf8')).replace(/\r\n/g, '\n');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** What `docs/API.md` should contain: the current text with a fresh generated block, formatted. */
export async function planApiDocs(root: string = REPO_ROOT): Promise<PlannedFile> {
  const target = resolve(root, API_DOC_PATH);
  const current = await readIfExists(target);
  if (current === null) throw new MarkerError(`${API_DOC_PATH} does not exist.`);
  // The formatting rules belong to this repository, wherever the page lives (the tests plan a copy in
  // the temp directory, which has no Prettier configuration of its own).
  const config = await resolveConfig(resolve(REPO_ROOT, API_DOC_PATH));
  const content = await format(insertRouteReference(current, renderRouteReference()), {
    ...config,
    parser: 'markdown',
  });
  return { path: API_DOC_PATH, content };
}

export interface ExportResult {
  written: string[];
  unchanged: string[];
  /** Files whose content differs from the plan (only populated in check mode). */
  stale: string[];
}

/** Writes the plan, or, with `check`, only reports whether the committed file differs. */
export async function exportApiDocs(
  options: { root?: string; check?: boolean } = {},
): Promise<ExportResult> {
  const root = options.root ?? REPO_ROOT;
  const result: ExportResult = { written: [], unchanged: [], stale: [] };
  const file = await planApiDocs(root);
  const current = await readIfExists(resolve(root, file.path));
  if (current === file.content) {
    result.unchanged.push(file.path);
  } else if (options.check) {
    result.stale.push(file.path);
  } else {
    await writeFile(resolve(root, file.path), file.content, 'utf8');
    result.written.push(file.path);
  }
  return result;
}

async function main(argv: readonly string[]): Promise<number> {
  const check = argv.includes('--check');
  let result: ExportResult;
  try {
    result = await exportApiDocs({ check });
  } catch (error) {
    if (error instanceof MarkerError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
  if (check) {
    if (result.stale.length > 0) {
      console.error(
        `The API reference is out of date. Run "pnpm docs:api" and commit:\n${result.stale
          .map((path) => `  - ${path}`)
          .join('\n')}`,
      );
      return 1;
    }
    console.log(
      `The API reference is up to date (${routeEntries().length} routes in ${API_DOC_PATH}).`,
    );
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
