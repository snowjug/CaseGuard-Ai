import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalJson, sha256, caseSetHash, REPOSITORY_ROOT, type Dataset, type LoadedCase } from './dataset';
import { enginePackIdentity } from './engine';
import type { CaseDetail, InvarianceResult, MetricsResult } from './metrics';
import { EVAL_RUN_SCHEMA } from './schema';

/** What a run writes: who and what produced it (`meta`), the numbers (`results`) and a hash of the numbers. */
export interface RunMeta {
  readonly split: string;
  readonly generatedAt: string;
  readonly gitCommit: string | null;
  readonly engine: { readonly version: string; readonly package: string };
  readonly pack: { readonly id: string; readonly version: string; readonly sha256: string };
  readonly dataset: {
    readonly datasetVersion: string | null;
    readonly annotationVersion: number | null;
    readonly caseSetSha256: string;
  };
  readonly selection: { readonly splits: readonly string[]; readonly annotator: string | null };
  readonly options: {
    readonly recommendations: boolean;
    readonly counterfactual: boolean;
    readonly detail: boolean;
  };
  readonly annotators: readonly { readonly id: string; readonly kind: string }[];
}

export interface RunResults {
  readonly metrics: MetricsResult;
  readonly invariance: readonly InvarianceResult[];
  /** Per-case lines; null unless asked for. */
  readonly details: readonly CaseDetail[] | null;
}

export interface RunArtifact {
  readonly schema: typeof EVAL_RUN_SCHEMA;
  readonly meta: RunMeta;
  readonly results: RunResults;
  readonly resultsSha256: string;
}

/**
 * The version of the analysis engine: `ENGINE_VERSION` of the API, which is part of the hash of every stored analysis, read
 * as text (the domain package does not depend on the API), next to the version of the package that holds the engine code.
 */
export function engineVersion(): { version: string; package: string } {
  const manifest = JSON.parse(
    readFileSync(resolve(REPOSITORY_ROOT, 'packages/domain/package.json'), 'utf8'),
  ) as { name: string; version: string };
  let version = manifest.version;
  try {
    const source = readFileSync(resolve(REPOSITORY_ROOT, 'apps/api/src/services/analysis/inputs.ts'), 'utf8');
    version = /export const ENGINE_VERSION = '([^']+)'/.exec(source)?.[1] ?? version;
  } catch {
    // Without the API source (a partial checkout) the package version stands in.
  }
  return { version, package: `${manifest.name}@${manifest.version}` };
}

/** Per-signal and per-action tables of a metrics result, emptied: what a locked run may show are aggregates. */
export function withoutPerId(metrics: MetricsResult): MetricsResult {
  return {
    ...metrics,
    signals: { ...metrics.signals, byId: {} },
    actions: { ...metrics.actions, byId: {} },
  };
}

export function buildArtifact(input: {
  readonly split: string;
  readonly generatedAt: string;
  readonly gitCommit: string | null;
  readonly dataset: Dataset;
  readonly selected: readonly LoadedCase[];
  readonly selection: RunMeta['selection'];
  readonly options: RunMeta['options'];
  readonly results: RunResults;
}): RunArtifact {
  const manifest = input.dataset.manifest;
  const annotatorIds = new Set(input.results.metrics.cases.annotators);
  const registry = input.dataset.annotators?.annotators ?? [];
  return {
    schema: EVAL_RUN_SCHEMA,
    meta: {
      split: input.split,
      generatedAt: input.generatedAt,
      gitCommit: input.gitCommit,
      engine: engineVersion(),
      pack: enginePackIdentity(),
      dataset: {
        datasetVersion: manifest?.datasetVersion ?? null,
        annotationVersion: manifest?.annotationVersion ?? null,
        caseSetSha256: caseSetHash(input.selected),
      },
      selection: input.selection,
      options: input.options,
      annotators: [...annotatorIds].sort().map((id) => ({
        id,
        kind: registry.find((entry) => entry.id === id)?.kind ?? 'unregistered',
      })),
    },
    results: input.results,
    resultsSha256: sha256(canonicalJson(input.results)),
  };
}
