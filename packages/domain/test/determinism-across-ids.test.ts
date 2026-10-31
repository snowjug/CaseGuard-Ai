import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  COUNTERFACTUAL_STRATEGIES,
  DEFAULT_QUALITY_CONFIG,
  type CounterfactualScenario,
  type HindsightCheck,
} from '@caseguard/schemas';
import {
  buildCoachingReport,
  buildDigitalTwin,
  buildMetricEstimates,
  computeAvoidableEffort,
  computeEfficiency,
  computeQualityReview,
  createFullView,
  estimateSkillImpact,
  generateCounterfactuals,
  getCompiledPack,
  normalizeBundle,
  replayWarnings,
  runDeterministicAnalysis,
  type DeterministicAnalysis,
  type EngineContext,
} from '../src';
import { CASE_ONE, CASE_TWO, CONFIG, NOW, loadBundle } from './helpers';
import { TWO } from './skills-fixtures';
import { planAt, version } from './skills-story-fixtures';

/*
 * The product promise is "same content + same configuration => same numbers, in any database". The
 * ids of a case (tenant, case, run, source, and the ids derived from them by `stableId`) and the id of
 * a skill are generated per database, so no number may depend on them: not through a seed, not through
 * a tie-break between equal scores, not through the order of anything that is sorted by id.
 */

interface IdSet {
  tenantId: string;
  caseId: string;
  runId: string;
  sourceId: string;
  skillId: string;
}

const digest = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Four id sets that look like generated ids and sort differently from each other. */
const ID_SETS: IdSet[] = ['alpha', 'bravo', 'charlie', 'delta'].map((tag) => ({
  tenantId: `tenant_${digest(`${tag}|tenant`).slice(0, 26)}`,
  caseId: `case_${digest(`${tag}|case`).slice(0, 26)}`,
  runId: `run_${digest(`${tag}|run`).slice(0, 26)}`,
  sourceId: `src_${digest(`${tag}|source`).slice(0, 26)}`,
  skillId: `skl_${digest(`${tag}|skill`).slice(0, 26)}`,
}));

const STRATEGIES = [...COUNTERFACTUAL_STRATEGIES];
const ROLLOUTS = 60;
const SEED = 'determinism-seed';

interface Run {
  ids: IdSet;
  ctx: EngineContext;
  analysis: DeterministicAnalysis;
  scenarios: CounterfactualScenario[];
  hindsight: HindsightCheck[];
  sections: Record<string, unknown>;
}

/** Everything the product computes for one case, under one set of generated ids. */
function runPipeline(file: string, ids: IdSet, seed = SEED): Run {
  const bundle = loadBundle(file);
  const normalized = normalizeBundle(bundle, {
    tenantId: ids.tenantId,
    caseId: ids.caseId,
    sourceId: ids.sourceId,
    createdBy: 'test',
    now: NOW,
    sourceKind: 'builtin_sample',
    storedPayload: JSON.stringify(bundle),
    redactionReplacements: 0,
  });
  const pack = getCompiledPack(bundle.case.workload);
  if (!pack) throw new Error(`No knowledge pack for workload ${bundle.case.workload}`);
  const ctx: EngineContext = {
    tenantId: ids.tenantId,
    caseId: ids.caseId,
    runId: ids.runId,
    now: NOW,
    createdBy: 'system:analysis',
    seed,
  };
  const { events, resolution } = normalized;
  const analysis = runDeterministicAnalysis({
    view: createFullView(events, resolution),
    pack,
    config: CONFIG,
    ctx,
  });
  const twin = buildDigitalTwin({
    caseRecord: normalized.case,
    events,
    resolution,
    analysis,
    pack,
    ctx,
    asOf: null,
  });

  const scenarios: CounterfactualScenario[] = [];
  const hindsight: HindsightCheck[] = [];
  for (const fork of analysis.forks) {
    const result = generateCounterfactuals({
      analysis,
      fork,
      strategies: STRATEGIES,
      events,
      resolution,
      pack,
      config: CONFIG,
      ctx,
      rolloutCount: ROLLOUTS,
    });
    scenarios.push(...result.scenarios);
    hindsight.push(...result.hindsight);
  }

  const review = computeQualityReview({
    analysis,
    pack,
    ctx,
    config: DEFAULT_QUALITY_CONFIG,
    actionConfig: CONFIG,
  });
  const avoidable = computeAvoidableEffort({ analysis, pack, scenarios });
  const efficiency = computeEfficiency({
    analysis,
    pack,
    caseId: ids.caseId,
    synthetic: true,
    unitPrices: { inputPer1kUsd: 0.003, outputPer1kUsd: 0.015, cachedInputPer1kUsd: null },
    avoidable,
  });
  const metrics = buildMetricEstimates({
    analysis,
    pack,
    ctx,
    review,
    avoidable,
    efficiency,
    synthetic: true,
    actionConfig: CONFIG,
  });
  const replay = replayWarnings({ events, resolution, pack, ctx, config: CONFIG, analysis });
  const coaching = buildCoachingReport({
    analysis,
    pack,
    ctx,
    review,
    warnings: replay.warnings,
    skills: [],
    config: CONFIG,
    synthetic: true,
  });

  return {
    ids,
    ctx,
    analysis,
    scenarios,
    hindsight,
    sections: {
      timeline: analysis.timeline,
      observations: analysis.observations,
      evidence: analysis.evidence,
      claims: analysis.claims,
      hypotheses: analysis.hypotheses,
      links: analysis.links,
      missing: analysis.missing,
      actions: analysis.actions,
      forks: analysis.forks,
      requirementStates: analysis.requirementStates,
      notes: analysis.notes,
      scenarios,
      hindsight,
      avoidableSupportEffort: avoidable,
      efficiency,
      quality: review,
      metrics,
      warnings: replay.warnings,
      coaching,
      twin,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Projection: generated ids are replaced by what they stand for, so that a different ORDER of the
// same things (a tie broken by id) is visible and only the ids themselves are ignored.

const GENERATED = /^[a-z]{2,8}_[0-9a-f]{20,32}$/;

function labelsOf(analysis: DeterministicAnalysis): Map<string, string> {
  const labels = new Map<string, string>();
  for (const e of analysis.evidence) labels.set(e.id, `evidence:${e.signalId}@${e.eventId}`);
  for (const c of analysis.claims) {
    labels.set(c.id, `claim:${c.ruleId}@${c.eventId ?? '-'}@${c.timestamp}:${c.text.slice(0, 48)}`);
  }
  for (const f of analysis.forks) labels.set(f.id, `fork@${f.eventId}`);
  for (const a of analysis.actions) labels.set(a.id, `action@${a.eventId}`);
  for (const h of analysis.hypotheses) labels.set(h.id, `hypothesis:${h.key}`);
  for (const m of analysis.missing) labels.set(m.id, `missing:${m.requirementId}`);
  return labels;
}

function project(value: unknown, run: Run, labels: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') {
    const known = labels.get(value);
    if (known !== undefined) return known;
    if (GENERATED.test(value)) return '<id>';
    let text = value;
    for (const id of Object.values(run.ids)) text = text.split(id).join('<id>');
    return text;
  }
  if (Array.isArray(value)) return value.map((item) => project(item, run, labels));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = project(item, run, labels);
    return out;
  }
  return value;
}

/** Paths at which two projections differ (first few), so a failure names the number that moved. */
function differences(a: unknown, b: unknown, path = '', out: string[] = []): string[] {
  if (out.length >= 12) return out;
  if (typeof a === 'number' && typeof b === 'number') {
    if (a !== b) out.push(`${path}: ${a} != ${b}`);
  } else if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path}.length: ${a.length} != ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++)
      differences(a[i], b[i], `${path}[${i}]`, out);
  } else if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      differences(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
        path ? `${path}.${key}` : key,
        out,
      );
    }
  } else if (a !== b) {
    out.push(`${path}: ${JSON.stringify(a)?.slice(0, 80)} != ${JSON.stringify(b)?.slice(0, 80)}`);
  }
  return out;
}

const projectionOf = (run: Run): Record<string, unknown> => {
  const labels = labelsOf(run.analysis);
  return Object.fromEntries(
    Object.entries(run.sections).map(([name, value]) => [name, project(value, run, labels)]),
  );
};

const CASES = [
  { name: 'Case One', file: CASE_ONE },
  { name: 'Case Two', file: CASE_TWO },
] as const;

const SECTIONS = [
  'timeline',
  'observations',
  'evidence',
  'claims',
  'hypotheses',
  'links',
  'missing',
  'actions',
  'forks',
  'requirementStates',
  'notes',
  'scenarios',
  'hindsight',
  'avoidableSupportEffort',
  'efficiency',
  'quality',
  'metrics',
  'warnings',
  'coaching',
  'twin',
] as const;

describe.each(CASES)('$name: no generated id changes a number', ({ file }) => {
  let runs: Run[] = [];
  let projections: Record<string, unknown>[] = [];
  beforeAll(() => {
    runs = ID_SETS.map((ids) => runPipeline(file, ids));
    projections = runs.map(projectionOf);
  }, 300_000);

  it('uses four really different sets of ids, and the ids derived from them differ too', () => {
    expect(new Set(runs.map((r) => r.ids.caseId)).size).toBe(4);
    expect(new Set(runs.map((r) => r.ids.runId)).size).toBe(4);
    const forkIds = runs.flatMap((r) => r.analysis.forks.map((f) => f.id));
    expect(new Set(forkIds).size).toBe(forkIds.length);
    expect(Object.keys(runs[0]?.sections ?? {}).sort()).toEqual([...SECTIONS].sort());
  });

  for (const section of SECTIONS) {
    it(`${section} is identical under every id set`, () => {
      const [first, ...others] = projections;
      others.forEach((other, i) => {
        const moved = differences(first?.[section], other[section]);
        expect(moved.length, `id set ${i + 2} against id set 1:\n${moved.join('\n')}`).toBe(0);
      });
    });
  }

  it('shows the figures a presenter quotes, from a real simulation', () => {
    const percentOf = (run: Run) =>
      (run.sections.avoidableSupportEffort as { percent: unknown }).percent;
    const [reference] = runs;
    if (!reference) throw new Error('runs exist');
    for (const run of runs) expect(percentOf(run)).toEqual(percentOf(reference));
    if (file === CASE_ONE) {
      expect(reference.analysis.forks.length).toBeGreaterThan(0);
      expect(reference.scenarios.length).toBeGreaterThan(0);
      expect(percentOf(reference)).not.toBeNull();
    }
  });
});

describe('the simulation really is stochastic in its seed (the equalities above are not vacuous)', () => {
  it('draws different samples from a different seed', () => {
    const a = runPipeline(CASE_ONE, ID_SETS[0] as IdSet, 'seed-a');
    const b = runPipeline(CASE_ONE, ID_SETS[0] as IdSet, 'seed-b');
    const percent = (r: Run) =>
      (r.sections.avoidableSupportEffort as { percent: { mid: number } | null }).percent?.mid;
    expect(percent(a)).not.toBe(percent(b));
    const bands = (r: Run) => JSON.stringify(r.analysis.timeline.steps.map((s) => [s.low, s.high]));
    expect(bands(a)).not.toBe(bands(b));
  }, 120_000);
});

describe('the skill-impact baseline does not depend on the skill id', () => {
  const impactUnder = (skillId: string, tenantId = 'tenant_x') => {
    const plan = { ...planAt(TWO, 'g01'), skillId };
    return estimateSkillImpact({
      plan,
      version,
      analysis: TWO.analysis,
      pack: TWO.pack,
      config: CONFIG,
      ctx: { ...TWO.ctx, tenantId },
      synthetic: true,
    });
  };

  it('gives the same baseline range, seed text and statements for four different skill ids', () => {
    const [first, ...others] = ID_SETS.map((ids) => impactUnder(ids.skillId, ids.tenantId));
    expect(first?.baseline.metrics.timeToDiagnosisMinutes.mid).toBeGreaterThan(0);
    for (const other of others) {
      expect(other.baseline).toEqual(first?.baseline);
      expect(other.headline).toBe(first?.headline);
      expect(other.statements).toEqual(first?.statements);
      expect(other.caveats).toEqual(first?.caveats);
      expect(other.difference).toEqual(first?.difference);
    }
  });

  it('still draws different samples for a different moment in the case', () => {
    const early = impactUnder(ID_SETS[0]?.skillId ?? '');
    const later = estimateSkillImpact({
      plan: { ...planAt(TWO, 'g05'), skillId: ID_SETS[0]?.skillId ?? '' },
      version,
      analysis: TWO.analysis,
      pack: TWO.pack,
      config: CONFIG,
      ctx: TWO.ctx,
      synthetic: true,
    });
    expect(later.baseline.seed).not.toBe(early.baseline.seed);
  });
});
