import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizeBundle, type NormalizedCase } from '@caseguard/domain';
import { CaseBundleSchema, type CaseBundle } from '@caseguard/schemas';
import type { IngestCaseInput, TenantRepositories } from '../../src/db';

/** The two synthetic cases of the demo story: a costly investigation and an efficient follow-up. */
export const SAMPLE_FILES = {
  caseOne: 'case-one-teams-signin-dns.json',
  caseTwo: 'case-two-teams-signin-proxy.json',
} as const;

export type SampleFile = (typeof SAMPLE_FILES)[keyof typeof SAMPLE_FILES];

const casesDir = resolve(import.meta.dirname, '../../../../synthetic-data/cases');

export function loadSampleBundle(file: SampleFile): CaseBundle {
  return CaseBundleSchema.parse(JSON.parse(readFileSync(resolve(casesDir, file), 'utf8')));
}

export interface SampleOptions {
  readonly tenantId: string;
  readonly caseId: string;
  readonly now?: string;
  readonly createdBy?: string;
}

/** Normalises a sample exactly the way ingestion does, so tests exercise the real shapes. */
export function normalizeSample(file: SampleFile, options: SampleOptions): NormalizedCase {
  const bundle = loadSampleBundle(file);
  return normalizeBundle(bundle, {
    tenantId: options.tenantId,
    caseId: options.caseId,
    sourceId: `src_${options.caseId}`,
    createdBy: options.createdBy ?? 'system:test',
    now: options.now ?? '2026-10-29T00:00:00.000Z',
    sourceKind: 'builtin_sample',
    storedPayload: JSON.stringify(bundle),
    redactionReplacements: 0,
  });
}

export function toIngestInput(normalized: NormalizedCase, storedPayload: string): IngestCaseInput {
  return {
    case: normalized.case,
    source: normalized.source,
    participants: normalized.participants,
    events: normalized.events,
    resolution: normalized.resolution,
    storedPayload,
  };
}

/** Persists a sample for the repositories' tenant and returns what was stored. */
export async function ingestSample(
  repos: TenantRepositories,
  file: SampleFile,
  options: SampleOptions,
): Promise<NormalizedCase> {
  const normalized = normalizeSample(file, options);
  await repos.cases.ingest(toIngestInput(normalized, JSON.stringify(loadSampleBundle(file))));
  return normalized;
}
