import { CaseBundleSchema, type ExampleInfo, type SampleBundleInfo } from '@caseguard/schemas';
import { GENERATED_EXAMPLE_FILES, GENERATED_SAMPLE_BUNDLES } from './generated';
import type { GeneratedExampleFile, GeneratedSampleBundle } from './types';

export type { ExampleKind, GeneratedExampleFile, GeneratedSampleBundle } from './types';

/*
 * The built-in synthetic sample cases and the downloadable example inputs. The data is generated
 * from `synthetic-data/` into `generated.ts` (see `scripts/export-samples.ts`), so no file-system
 * access is needed at run time. Everything here is stateless: lookups walk two short constant lists.
 */

/** The sample with the given id, or null. */
export function findSample(id: string): GeneratedSampleBundle | null {
  return GENERATED_SAMPLE_BUNDLES.find((sample) => sample.id === id) ?? null;
}

/** The sample playing `role` (Case One is `primary`, Case Two is `followup`). */
export function sampleByRole(role: GeneratedSampleBundle['role']): GeneratedSampleBundle {
  const sample = GENERATED_SAMPLE_BUNDLES.find((candidate) => candidate.role === role);
  if (sample === undefined) throw new Error(`The generated samples have no "${role}" case`);
  return sample;
}

export function sampleInfo(sample: GeneratedSampleBundle): SampleBundleInfo {
  const bundle = CaseBundleSchema.parse(JSON.parse(sample.json));
  return {
    id: sample.id,
    title: bundle.case.title,
    description: sample.description,
    reference: bundle.case.reference,
    workload: bundle.case.workload,
    eventCount: bundle.events.length,
    synthetic: true,
    role: sample.role,
  };
}

/** Descriptions of the built-in samples; the event count is computed from the bundle itself. */
export function listSampleInfos(): SampleBundleInfo[] {
  return GENERATED_SAMPLE_BUNDLES.map(sampleInfo);
}

export function findExample(id: string): GeneratedExampleFile | null {
  return GENERATED_EXAMPLE_FILES.find((example) => example.id === id) ?? null;
}

export function exampleInfo(example: GeneratedExampleFile): ExampleInfo {
  return {
    id: example.id,
    title: example.title,
    description: example.description,
    fileName: example.fileName,
    kind: example.kind,
    sizeBytes: Buffer.byteLength(example.text, 'utf8'),
    synthetic: true,
    // Only transcripts can be pasted; a CSV or JSON file is uploaded instead.
    ...(example.kind === 'transcript' ? { pasteText: example.text } : {}),
  };
}

export function listExampleInfos(): ExampleInfo[] {
  return GENERATED_EXAMPLE_FILES.map(exampleInfo);
}
