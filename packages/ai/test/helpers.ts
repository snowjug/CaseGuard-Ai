import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CaseBundleSchema, DEFAULT_ACTION_VALUE_CONFIG, type CaseBundle } from '@caseguard/schemas';
import {
  createFullView,
  getCompiledPack,
  normalizeBundle,
  runDeterministicAnalysis,
  type CompiledPack,
  type DeterministicAnalysis,
  type EngineContext,
  type NormalizedCase,
  type TemporalView,
} from '@caseguard/domain';
import type { EvalCase } from '../src';

export const CASE_ONE = 'case-one-teams-signin-dns.json';
export const CASE_TWO = 'case-two-teams-signin-proxy.json';
export const NOW = '2026-10-29T00:00:00.000Z';
export const CONFIG = DEFAULT_ACTION_VALUE_CONFIG;
export const TENANT = 'tenant_test';

const casesDir = resolve(import.meta.dirname, '../../../synthetic-data/cases');

/** Loads and validates one of the two synthetic case bundles. */
export function loadBundle(file: string): CaseBundle {
  return CaseBundleSchema.parse(JSON.parse(readFileSync(resolve(casesDir, file), 'utf8')));
}

export interface Prepared {
  bundle: CaseBundle;
  normalized: NormalizedCase;
  pack: CompiledPack;
  ctx: EngineContext;
  view: TemporalView;
  analysis: DeterministicAnalysis;
}

export function contextFor(caseId = 'case_test'): EngineContext {
  return {
    tenantId: TENANT,
    caseId,
    runId: 'run_test',
    now: NOW,
    createdBy: 'test',
    seed: 'test-seed',
  };
}

/** Normalizes a bundle and runs the full deterministic analysis exactly as the API will. */
export function prepareBundle(bundle: CaseBundle, caseId = 'case_test'): Prepared {
  const normalized = normalizeBundle(bundle, {
    tenantId: TENANT,
    caseId,
    sourceId: 'src_test',
    createdBy: 'test',
    now: NOW,
    sourceKind: 'builtin_sample',
    storedPayload: JSON.stringify(bundle),
    redactionReplacements: 0,
  });
  const pack = getCompiledPack(bundle.case.workload);
  if (!pack) throw new Error(`No knowledge pack for workload ${bundle.case.workload}`);
  const ctx = contextFor(caseId);
  const view = createFullView(normalized.events, normalized.resolution);
  const analysis = runDeterministicAnalysis({ view, pack, config: CONFIG, ctx });
  return { bundle, normalized, pack, ctx, view, analysis };
}

const cache = new Map<string, Prepared>();

export function prepareCase(file: string): Prepared {
  const hit = cache.get(file);
  if (hit) return hit;
  const prepared = prepareBundle(loadBundle(file));
  cache.set(file, prepared);
  return prepared;
}

/** Event ids in the synthetic cases end with e03 / g05 etc.; tests refer to them by suffix. */
export function eventBySuffix(p: Prepared, suffix: string) {
  const found = p.normalized.events.find((e) => e.id.endsWith(suffix));
  if (!found) throw new Error(`No event ending with ${suffix}`);
  return found;
}

/** Adapts a prepared case to the evaluation harness input. */
export function toEvalCase(p: Prepared, id: string): EvalCase {
  return {
    id,
    label: p.bundle.case.title,
    events: p.normalized.events,
    resolution: p.normalized.resolution,
    pack: p.pack,
    config: CONFIG,
    ctx: p.ctx,
    view: p.view,
    analysis: p.analysis,
    tenantId: TENANT,
  };
}
