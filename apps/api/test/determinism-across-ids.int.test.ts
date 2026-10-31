import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFullView, createTemporalView, getCompiledPack } from '@caseguard/domain';
import {
  DEFAULT_ACTION_VALUE_CONFIG,
  DEFAULT_QUALITY_CONFIG,
  type AnalysisRun,
} from '@caseguard/schemas';
import { createIdGenerator, type IdGenerator } from '../src/db/ids';
import {
  engineContextForRun,
  simulationSeed,
  type AnalysisInputs,
} from '../src/services/analysis/inputs';
import { passContext } from '../src/services/views/passes';
import { buildAnalysisRun, buildSkill, buildSkillVersion } from './builders';
import { CONTOSO, PERSONAS, createHarness, type Harness } from './support/app-harness';
import { SAMPLE_FILES, normalizeSample } from './support/samples';
import { STORY_TIMEOUT_MS } from './insights-support';
import { apiOf, ingestAndAnalyse, type TestApi } from './skills-support';

/*
 * The product promise is "same content + same configuration => same numbers, in any database". Every
 * id of a case, run, tenant, source or skill is generated per database, so none of them may reach a
 * seed or an ordering. Two fresh databases with ids from two different id spaces analyse the same two
 * synthetic cases and must show the same figures; a skill added to the library must re-run the
 * analysis (the input hash still covers it) and redraw nothing.
 */

/** A production-shaped (ULID-like) id source whose entropy is fixed by a tag: another tag, another id space. */
function idSpace(tag: string, startMs: number): IdGenerator {
  let draws = 0;
  return createIdGenerator({
    now: () => startMs,
    random: (size) => {
      const digest = createHash('sha256').update(`${tag}|${draws++}`).digest();
      return Uint8Array.from(digest.subarray(0, size));
    },
  });
}

const GENERATED = /^[a-z][a-z0-9]{1,15}_(?=[0-9A-Za-z_]*\d)[0-9A-Za-z_]{20,80}$/;
const EMBEDDED = /\b[a-z][a-z0-9]{1,15}_(?:[0-9A-Z]{26}|[0-9a-f]{20,64})\b/g;
// Ids, instants and the optimistic-lock counter describe a record's bookkeeping, not what it says.
const BOOKKEEPING_KEY = /(^id$|Ids?$|At$|^version$)/;

/** What is left of a stored record once every generated id and every instant is taken out of it. */
function withoutIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutIds);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !BOOKKEEPING_KEY.test(key))
        .map(([key, item]) => [key, withoutIds(item)]),
    );
  }
  if (typeof value !== 'string') return value;
  return GENERATED.test(value) ? '<id>' : value.replace(EMBEDDED, '<id>');
}

/** Paths at which two projections differ (the first few), so that a failure names the number that moved. */
function differences(a: unknown, b: unknown, path = '', out: string[] = []): string[] {
  if (out.length >= 12) return out;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path}.length: ${a.length} != ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      differences(a[i], b[i], `${path}[${i}]`, out);
    }
  } else if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const next = path ? `${path}.${key}` : key;
      differences(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
        next,
        out,
      );
    }
  } else if (a !== b) {
    out.push(`${path}: ${JSON.stringify(a)?.slice(0, 90)} != ${JSON.stringify(b)?.slice(0, 90)}`);
  }
  return out;
}

function expectSame(a: unknown, b: unknown, label: string): void {
  const moved = differences(a, b);
  expect(moved.length, `${label}:\n${moved.join('\n')}`).toBe(0);
}

interface Figures {
  readonly ids: { readonly one: string; readonly two: string };
  readonly cases: readonly {
    readonly forks: unknown;
    readonly metrics: unknown;
    readonly quality: unknown;
    readonly scenarios: unknown;
    readonly commandCenter: unknown;
    readonly efficiency: unknown;
    readonly runId: string;
  }[];
}

async function figuresOf(h: Harness, api: TestApi, ids: Figures['ids']): Promise<Figures> {
  const repos = h.repos(CONTOSO);
  const cases = [];
  for (const caseId of [ids.one, ids.two]) {
    const run = await repos.analysis.getLatestRun(caseId);
    if (run === null) throw new Error(`Case ${caseId} was not analysed`);
    const center = await api.get(PERSONAS.manager, `/command-center?caseId=${caseId}`);
    const efficiency = await api.get(PERSONAS.manager, `/efficiency/overview?caseId=${caseId}`);
    if (center.statusCode !== 200 || efficiency.statusCode !== 200) {
      throw new Error(`dashboard reads failed: ${center.statusCode} ${efficiency.statusCode}`);
    }
    cases.push({
      forks: withoutIds(await repos.analysis.listForks(caseId)),
      metrics: withoutIds(await repos.analysis.listMetrics(caseId)),
      quality: withoutIds(await repos.analysis.getQuality(caseId)),
      scenarios: withoutIds(await repos.counterfactuals.list(caseId)),
      commandCenter: withoutIds(center.data),
      efficiency: withoutIds(efficiency.data),
      runId: run.id,
    });
  }
  return { ids, cases };
}

interface AseMetric {
  readonly key: string;
  readonly value: number | null;
  readonly ase: { readonly components: readonly unknown[] } | null;
}

const aseOf = (metrics: unknown): AseMetric | undefined =>
  (metrics as readonly AseMetric[]).find((metric) => metric.key === 'avoidable_support_effort');

describe('two fresh databases with different generated ids', () => {
  const spaces = [
    { tag: 'alpha', startMs: Date.parse('2026-02-01T08:00:00Z') },
    { tag: 'bravo', startMs: Date.parse('2026-09-20T17:30:00Z') },
  ] as const;
  const harnesses: Harness[] = [];
  const results: Figures[] = [];

  beforeAll(async () => {
    for (const { tag, startMs } of spaces) {
      const newId = idSpace(tag, startMs);
      const h = await createHarness({ newId });
      harnesses.push(h);
      const ids = { one: newId('case'), two: newId('case') };
      await ingestAndAnalyse(h, ids);
      results.push(await figuresOf(h, apiOf(h), ids));
    }
  }, STORY_TIMEOUT_MS);

  afterAll(async () => {
    for (const h of harnesses) await h.close();
  });

  it('really use different ids for the cases and the runs', () => {
    const [a, b] = results;
    expect(a?.ids.one).not.toBe(b?.ids.one);
    expect(a?.ids.two).not.toBe(b?.ids.two);
    expect(a?.cases[0]?.runId).not.toBe(b?.cases[0]?.runId);
    expect(a?.cases[1]?.runId).not.toBe(b?.cases[1]?.runId);
  });

  it('show the same Avoidable Support Effort, with its components and range', () => {
    const [a, b] = results.map((result) => aseOf(result.cases[0]?.metrics));
    expect(a?.value).toEqual(expect.any(Number));
    expect(a?.ase?.components.length).toBeGreaterThan(0);
    expectSame(a, b, 'Case One Avoidable Support Effort');
    const [c, d] = results.map((result) => aseOf(result.cases[1]?.metrics));
    expectSame(c, d, 'Case Two Avoidable Support Effort');
  });

  it('store the same decision forks, scenarios, quality and metrics for Case One', () => {
    const [a, b] = results.map((result) => result.cases[0]);
    expectSame(a?.forks, b?.forks, 'forks');
    expectSame(a?.scenarios, b?.scenarios, 'scenarios');
    expectSame(a?.quality, b?.quality, 'quality');
    expectSame(a?.metrics, b?.metrics, 'metrics');
    expect((a?.scenarios as unknown[]).length).toBeGreaterThan(0);
  });

  it('store the same quality and metrics for Case Two', () => {
    const [a, b] = results.map((result) => result.cases[1]);
    expectSame(a?.forks, b?.forks, 'forks');
    expectSame(a?.quality, b?.quality, 'quality');
    expectSame(a?.metrics, b?.metrics, 'metrics');
  });

  it('show the same dashboard and the same efficiency numbers', () => {
    for (const index of [0, 1]) {
      const [a, b] = results.map((result) => result.cases[index]);
      expectSame(a?.commandCenter, b?.commandCenter, `command center, case ${index + 1}`);
      expectSame(a?.efficiency, b?.efficiency, `efficiency, case ${index + 1}`);
    }
  });
});

describe('a change of the skill library', () => {
  let h: Harness;
  let api: TestApi;
  const newId = idSpace('library', Date.parse('2026-05-05T05:05:00Z'));
  const ids = { one: newId('case'), two: newId('case') };

  beforeAll(async () => {
    h = await createHarness({ newId });
    api = apiOf(h);
    await ingestAndAnalyse(h, ids, 'one');
  }, STORY_TIMEOUT_MS);

  afterAll(async () => {
    await h.close();
  });

  it(
    're-runs the analysis (its identity covers the library) but redraws no simulated number',
    async () => {
      const repos = h.repos(CONTOSO);
      const before = await repos.analysis.getLatestRun(ids.one);
      const figuresBefore = {
        metrics: withoutIds(await repos.analysis.listMetrics(ids.one)),
        scenarios: withoutIds(await repos.counterfactuals.list(ids.one)),
        quality: withoutIds(await repos.analysis.getQuality(ids.one)),
      };

      const skillId = newId('skill');
      const versionId = newId('skillv');
      await repos.skills.create({
        skill: buildSkill({
          tenantId: CONTOSO,
          id: skillId,
          key: 'library-change',
          lifecycle: 'published',
          currentVersionId: versionId,
        }),
        version: buildSkillVersion({ tenantId: CONTOSO, id: versionId, skillId }),
      });

      const started = await api.post(PERSONAS.engineer, `/cases/${ids.one}/analysis`, {});
      expect(started.statusCode).toBe(202);
      expect(started.data.reused).toBe(false);
      await h.infra.services.jobs.idle();

      const after = await repos.analysis.getLatestRun(ids.one);
      expect(after?.id).not.toBe(before?.id);
      expect(after?.inputHash).not.toBe(before?.inputHash);
      expect(await repos.skills.listMatchable('teams-authentication')).toHaveLength(1);

      expectSame(
        withoutIds(await repos.analysis.listMetrics(ids.one)),
        figuresBefore.metrics,
        'metrics after the library changed',
      );
      expectSame(
        withoutIds(await repos.counterfactuals.list(ids.one)),
        figuresBefore.scenarios,
        'scenarios after the library changed',
      );
      expectSame(
        withoutIds(await repos.analysis.getQuality(ids.one)),
        figuresBefore.quality,
        'quality after the library changed',
      );
    },
    STORY_TIMEOUT_MS,
  );
});

describe('the simulation seed', () => {
  const pack = getCompiledPack('teams-authentication');

  function inputsOf(tenantId: string, caseId: string): AnalysisInputs {
    const normalized = normalizeSample(SAMPLE_FILES.caseOne, { tenantId, caseId });
    if (pack === null) throw new Error('The sample workload has no knowledge pack');
    return {
      caseRecord: normalized.case,
      source: normalized.source,
      events: normalized.events,
      resolution: normalized.resolution,
      pack,
      actionConfig: DEFAULT_ACTION_VALUE_CONFIG,
      qualityConfig: DEFAULT_QUALITY_CONFIG,
      skills: [],
      unitPrices: { inputPer1kUsd: null, outputPer1kUsd: null, cachedInputPer1kUsd: null },
    };
  }

  const runOf = (inputs: AnalysisInputs, id: string, inputHash: string): AnalysisRun =>
    buildAnalysisRun({
      tenantId: inputs.caseRecord.tenantId,
      caseId: inputs.caseRecord.id,
      id,
      inputHash,
      startedAt: '2026-10-29T00:00:00.000Z',
    });

  it('names the content: the same under other tenants, cases, sources and runs', () => {
    const a = inputsOf('tenant_alpha', 'case_alpha');
    const b = inputsOf('tenant_bravo', 'case_bravo');
    expect(a.caseRecord.id).not.toBe(b.caseRecord.id);
    expect(a.source.id).not.toBe(b.source.id);
    expect(simulationSeed(a)).toBe(simulationSeed(b));

    const runA = runOf(a, 'run_alpha', 'hash-with-skill-ids-1');
    const runB = runOf(b, 'run_bravo', 'hash-with-skill-ids-2');
    expect(engineContextForRun(runA, a).seed).toBe(engineContextForRun(runB, b).seed);
    expect(engineContextForRun(runA, a).seed).toBe(simulationSeed(a));
    expect(engineContextForRun(runA, a).seed).not.toBe(runA.inputHash);
    expect(engineContextForRun(runA, a).runId).toBe('run_alpha');
  });

  it('changes with the content it simulates and nothing else', () => {
    const base = inputsOf('tenant_alpha', 'case_alpha');
    const withoutLast: AnalysisInputs = { ...base, events: base.events.slice(0, -1) };
    const open: AnalysisInputs = { ...base, resolution: null };
    const edited: AnalysisInputs = {
      ...base,
      source: { ...base.source, receivedSha256: 'f'.repeat(64) },
    };
    const seeds = [base, withoutLast, open, edited].map((inputs) => simulationSeed(inputs));
    expect(new Set(seeds).size).toBe(4);
    // The skill library (its ids are random), the configurations and the provider are not content.
    const withSkill: AnalysisInputs = {
      ...base,
      skills: [{ skill: buildSkill(), version: buildSkillVersion() }],
    };
    expect(simulationSeed(withSkill)).toBe(seeds[0]);
  });

  it('seeds a window by the visible events and the pack alone, never by a generated id', () => {
    const a = inputsOf('tenant_alpha', 'case_alpha');
    const b = inputsOf('tenant_bravo', 'case_bravo');
    const instant = a.events[6]?.timestamp ?? '';
    const windowOf = (inputs: AnalysisInputs) =>
      createTemporalView(inputs.events, instant, { resolution: inputs.resolution });
    const whole = (inputs: AnalysisInputs) => createFullView(inputs.events, inputs.resolution);
    const runA = runOf(a, 'run_alpha', 'hash-1');
    const runB = runOf(b, 'run_bravo', 'hash-2');

    expect(passContext(runA, a, windowOf(a)).seed).toBe(passContext(runB, b, windowOf(b)).seed);
    expect(passContext(runA, a, windowOf(a)).seed).not.toBe(simulationSeed(a));
    // The whole record is what the stored run analysed, so it keeps the case's simulation seed.
    expect(passContext(runA, a, whole(a)).seed).toBe(simulationSeed(a));
    expect(passContext(runA, a, whole(a)).seed).toBe(passContext(runB, b, whole(b)).seed);
  });
});
