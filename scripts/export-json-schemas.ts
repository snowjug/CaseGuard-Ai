import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { buildJsonSchemaDocuments } from '../packages/domain/src/ingest/parsers/schema-export';

/**
 * Writes the JSON Schemas for case bundles, knowledge packs and SkillDNA content (FR-ING-09).
 *
 *   pnpm schemas:export            write the files
 *   pnpm schemas:export -- --check fail (exit 1) when committed files are out of date
 *
 * Output goes to `synthetic-data/knowledge/` (next to the knowledge packs) and `docs/schemas/`
 * (documentation). Files are formatted with the repository's Prettier configuration so
 * `prettier --check` stays green; the generation itself is deterministic.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SCHEMA_OUTPUT_DIRS = ['synthetic-data/knowledge', 'docs/schemas'] as const;

export interface PlannedFile {
  /** Path relative to the repository root, with forward slashes. */
  path: string;
  content: string;
}

/** Computes every file the export produces without touching the file system. */
export async function planSchemaFiles(root: string = REPO_ROOT): Promise<PlannedFile[]> {
  const planned: PlannedFile[] = [];
  for (const document of buildJsonSchemaDocuments()) {
    const raw = `${JSON.stringify(document.schema, null, 2)}\n`;
    for (const dir of SCHEMA_OUTPUT_DIRS) {
      const path = `${dir}/${document.fileName}`;
      const config = await resolveConfig(resolve(root, path));
      planned.push({ path, content: await format(raw, { ...config, parser: 'json' }) });
    }
  }
  return planned;
}

export interface ExportResult {
  written: string[];
  unchanged: string[];
  /** Files whose content differs from the plan (only populated in check mode). */
  stale: string[];
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Writes the planned files, or, with `check`, only reports which ones differ. */
export async function exportSchemas(
  options: { root?: string; check?: boolean } = {},
): Promise<ExportResult> {
  const root = options.root ?? REPO_ROOT;
  const result: ExportResult = { written: [], unchanged: [], stale: [] };
  for (const file of await planSchemaFiles(root)) {
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
  }
  return result;
}

async function main(argv: readonly string[]): Promise<number> {
  const check = argv.includes('--check');
  const result = await exportSchemas({ check });
  if (check) {
    if (result.stale.length > 0) {
      console.error(
        `JSON schemas are out of date. Run "pnpm schemas:export" and commit:\n${result.stale
          .map((p) => `  - ${p}`)
          .join('\n')}`,
      );
      return 1;
    }
    console.log(`JSON schemas are up to date (${result.unchanged.length} files).`);
    return 0;
  }
  for (const path of result.written)
    console.log(`wrote     ${relative(REPO_ROOT, resolve(REPO_ROOT, path))}`);
  for (const path of result.unchanged) console.log(`unchanged ${path}`);
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
