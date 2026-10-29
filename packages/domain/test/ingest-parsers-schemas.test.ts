import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { format, resolveConfig } from 'prettier';
import { describe, expect, it } from 'vitest';
import {
  CASE_BUNDLE_SCHEMA_VERSION,
  CaseBundleSchema,
  KnowledgePackSchema,
} from '@caseguard/schemas';
import { buildJsonSchemaDocuments } from '../src/ingest/parsers';
import { TEAMS_AUTH_PACK } from '../src';
import {
  exportSchemas,
  planSchemaFiles,
  SCHEMA_OUTPUT_DIRS,
} from '../../../scripts/export-json-schemas';
import { readExample } from './ingest-parsers.helpers';

const repoRoot = resolve(import.meta.dirname, '../../..');
const docs = buildJsonSchemaDocuments();
interface BundleSchemaView {
  required: string[];
  properties: {
    schemaVersion: { const: string };
    events: { items: { required: string[] } };
  };
}

function schemaOf(id: string): Record<string, unknown> {
  const found = docs.find((d) => d.id === id);
  if (!found) throw new Error(`missing document ${id}`);
  return found.schema;
}

const requiredOf = (id: string): string[] => (schemaOf(id) as { required: string[] }).required;

describe('JSON schema documents (FR-ING-09)', () => {
  it('[FR-ING-09] covers the case bundle, the knowledge pack and SkillDNA content', () => {
    expect(docs.map((d) => [d.id, d.fileName])).toEqual([
      ['case-bundle', 'case-bundle.schema.json'],
      ['knowledge-pack', 'knowledge-pack.schema.json'],
      ['skill', 'skill.schema.json'],
    ]);
  });

  it('[FR-ING-09] every document is a draft 2020-12 object schema with a stable id', () => {
    for (const doc of docs) {
      expect(doc.schema).toMatchObject({
        type: 'object',
        title: expect.any(String),
        description: expect.any(String),
      });
      expect(doc.schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(doc.schema.$id).toBe(`https://caseguard.example/schemas/${doc.fileName}`);
    }
  });

  it('[FR-ING-09] describes the structure authors must write', () => {
    const bundle = schemaOf('case-bundle') as unknown as BundleSchemaView;
    expect(bundle.required).toEqual(
      expect.arrayContaining(['schemaVersion', 'synthetic', 'case', 'participants', 'events']),
    );
    expect(bundle.properties.schemaVersion.const).toBe(CASE_BUNDLE_SCHEMA_VERSION);
    expect(bundle.properties.events.items.required).toEqual(
      expect.arrayContaining(['id', 'timestamp', 'participantId', 'type', 'body']),
    );
    expect(requiredOf('knowledge-pack')).toEqual(
      expect.arrayContaining(['hypotheses', 'signals', 'actions', 'policies']),
    );
    expect(requiredOf('skill')).toEqual(
      expect.arrayContaining(['triggerConditions', 'decisionSequence', 'safetyConstraints']),
    );
  });

  it('[FR-ING-09] is deterministic: two builds are byte-identical', () => {
    const a = JSON.stringify(buildJsonSchemaDocuments());
    const b = JSON.stringify(buildJsonSchemaDocuments());
    expect(a).toBe(b);
  });

  it('[FR-ING-09] the schema accepts what the parsers produce and the example documents', () => {
    expect(
      CaseBundleSchema.safeParse(JSON.parse(readExample('minimal-case-bundle.json'))).success,
    ).toBe(true);
    expect(KnowledgePackSchema.safeParse(TEAMS_AUTH_PACK).success).toBe(true);
  });
});

describe('scripts/export-json-schemas.ts', () => {
  it('[FR-ING-09] plans one file per document in both output directories', async () => {
    const planned = await planSchemaFiles();
    expect(planned.map((f) => f.path)).toEqual(
      docs.flatMap((d) => SCHEMA_OUTPUT_DIRS.map((dir) => `${dir}/${d.fileName}`)),
    );
    expect(SCHEMA_OUTPUT_DIRS).toEqual(['synthetic-data/knowledge', 'docs/schemas']);
  });

  it('[FR-ING-09] generated files are valid JSON, end with a newline and are stable across runs', async () => {
    const first = await planSchemaFiles();
    const second = await planSchemaFiles();
    expect(second).toEqual(first);
    for (const file of first) {
      expect(file.content.endsWith('\n')).toBe(true);
      expect(() => {
        JSON.parse(file.content);
      }).not.toThrow();
      const doc = docs.find((d) => file.path.endsWith(d.fileName));
      expect(JSON.parse(file.content)).toEqual(JSON.parse(JSON.stringify(doc?.schema)) as unknown);
    }
  });

  it('[FR-ING-09] the synthetic-data and docs copies are identical', async () => {
    const planned = await planSchemaFiles();
    for (const doc of docs) {
      const copies = planned.filter((f) => f.path.endsWith(doc.fileName));
      expect(copies).toHaveLength(2);
      expect(copies[0]?.content).toBe(copies[1]?.content);
    }
  });

  it('[FR-ING-09] output is already formatted the way Prettier formats it', async () => {
    for (const file of await planSchemaFiles()) {
      const config = await resolveConfig(resolve(repoRoot, file.path));
      expect(await format(file.content, { ...config, parser: 'json' })).toBe(file.content);
    }
  });

  it('[FR-ING-09] committed files are in sync with the schemas (run "pnpm schemas:export" if this fails)', async () => {
    for (const file of await planSchemaFiles()) {
      const onDisk = readFileSync(resolve(repoRoot, file.path), 'utf8').replace(/\r\n/g, '\n');
      expect(onDisk, `${file.path} is out of date`).toBe(file.content);
    }
    const result = await exportSchemas({ check: true });
    expect(result.stale).toEqual([]);
    expect(result.written).toEqual([]);
    expect(result.unchanged).toHaveLength(6);
  });

  it('[FR-ING-09] check mode reports a missing directory as stale without writing anything', async () => {
    const result = await exportSchemas({ root: resolve(repoRoot, 'does-not-exist'), check: true });
    expect(result.stale).toHaveLength(6);
    expect(result.written).toEqual([]);
  });

  it('[FR-ING-09] the CLI runs and its --check mode passes on the committed files', () => {
    const output = execFileSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/export-json-schemas.ts', '--check'],
      { cwd: repoRoot, encoding: 'utf8', timeout: 60_000 },
    );
    expect(output).toContain('JSON schemas are up to date (6 files).');
  }, 90_000);
});
