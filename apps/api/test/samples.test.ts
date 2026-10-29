import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CaseBundleSchema, ExampleInfoSchema, SampleBundleInfoSchema } from '@caseguard/schemas';
import {
  findExample,
  findSample,
  listExampleInfos,
  listSampleInfos,
  sampleByRole,
} from '../src/samples';
import { GENERATED_EXAMPLE_FILES, GENERATED_SAMPLE_BUNDLES } from '../src/samples/generated';
import { loadSchemaDocuments } from '../src/samples/schemas';

const repoRoot = resolve(import.meta.dirname, '../../..');
const readRepoFile = (path: string): string =>
  readFileSync(resolve(repoRoot, path), 'utf8').replace(/\r\n/g, '\n');

describe('built-in sample cases', () => {
  it('[FR-ING-01] embeds exactly one primary and one follow-up case, both valid synthetic bundles', () => {
    expect(GENERATED_SAMPLE_BUNDLES.map((sample) => sample.role).sort()).toEqual([
      'followup',
      'primary',
    ]);
    expect(new Set(GENERATED_SAMPLE_BUNDLES.map((sample) => sample.id)).size).toBe(2);
    for (const sample of GENERATED_SAMPLE_BUNDLES) {
      const parsed = CaseBundleSchema.safeParse(JSON.parse(sample.json));
      expect(parsed.success, sample.id).toBe(true);
      expect(parsed.success && parsed.data.synthetic).toBe(true);
    }
    expect(sampleByRole('primary').fileName).toBe('case-one-teams-signin-dns.json');
    expect(sampleByRole('followup').fileName).toBe('case-two-teams-signin-proxy.json');
    expect(findSample('case-one-teams-signin-dns')?.role).toBe('primary');
    expect(findSample('nope')).toBeNull();
  });

  it('[FR-ING-01] the embedded text is the synthetic-data file, byte for byte', () => {
    for (const sample of GENERATED_SAMPLE_BUNDLES) {
      expect(sample.json).toBe(readRepoFile(`synthetic-data/cases/${sample.fileName}`));
    }
  });

  it('[FR-ING-01] describes the samples with the event count computed from the bundle', () => {
    const infos = listSampleInfos();
    expect(infos.map((info) => SampleBundleInfoSchema.safeParse(info).success)).toEqual([
      true,
      true,
    ]);
    expect(infos).toEqual([
      expect.objectContaining({
        id: 'case-one-teams-signin-dns',
        role: 'primary',
        reference: 'CG-SYN-1001',
        workload: 'teams-authentication',
        eventCount: 31,
        synthetic: true,
      }),
      expect.objectContaining({
        id: 'case-two-teams-signin-proxy',
        role: 'followup',
        reference: 'CG-SYN-1002',
        eventCount: 15,
      }),
    ]);
    expect(infos[0]?.description).toContain('Conditional Access');
    expect(infos[1]?.description).toContain('not real-world effectiveness');
  });
});

describe('example downloads', () => {
  it('[FR-ING-09] lists a transcript, a CSV and a minimal bundle, all synthetic', () => {
    const infos = listExampleInfos();
    expect(infos.map((info) => [info.id, info.kind, info.fileName])).toEqual([
      ['transcript-teams-signin-proxy', 'transcript', 'transcript-teams-signin-proxy.txt'],
      ['events-teams-signin-proxy', 'csv', 'events-teams-signin-proxy.csv'],
      ['minimal-case-bundle', 'case_bundle', 'minimal-case-bundle.json'],
    ]);
    for (const info of infos) {
      expect(ExampleInfoSchema.safeParse(info).success, info.id).toBe(true);
      expect(info.synthetic).toBe(true);
    }
  });

  it('[FR-ING-09] offers paste text for the transcript only, and sizes match the file', () => {
    for (const info of listExampleInfos()) {
      const example = findExample(info.id);
      expect(example).not.toBeNull();
      expect(info.sizeBytes).toBe(Buffer.byteLength(example?.text ?? '', 'utf8'));
      expect(info.pasteText).toBe(info.kind === 'transcript' ? example?.text : undefined);
    }
  });

  it('[FR-ING-09] the embedded text is the synthetic-data file, byte for byte', () => {
    for (const example of GENERATED_EXAMPLE_FILES) {
      expect(example.text).toBe(readRepoFile(`synthetic-data/examples/${example.fileName}`));
    }
    expect(findExample('missing')).toBeNull();
  });
});

describe('downloadable JSON Schemas', () => {
  it('[FR-ING-09] serves the same documents as the committed schema files', () => {
    const documents = loadSchemaDocuments();
    expect(documents.caseBundle).toEqual(
      JSON.parse(readRepoFile('synthetic-data/knowledge/case-bundle.schema.json')),
    );
    expect(documents.knowledgePack).toEqual(
      JSON.parse(readRepoFile('synthetic-data/knowledge/knowledge-pack.schema.json')),
    );
  });
});
