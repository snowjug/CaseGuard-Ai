/* eslint-disable no-console -- CLI that reports measured timings */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CaseBundleSchema, DEFAULT_ACTION_VALUE_CONFIG, type CaseBundle } from '@caseguard/schemas';

/**
 * Stress benchmark for the hostile-input hot spots fixed in the engine hardening pass: a long reply
 * chain (responder closure), hostile token runs (leak check), a multi-megabyte wall of hedged
 * sentences (claim extraction) and the two synthetic cases for a before/after comparison on the same
 * machine state. Usage: `tsx bench/hardening-bench.ts [--only=chain,claims,tokens,cases]
 * [--sizes=200,400,800] [--src=../src] [--iterations=15]`. Every number printed is measured here.
 */
const here = dirname(fileURLToPath(import.meta.url));
const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const only = (arg('only') ?? 'chain,claims,tokens,cases').split(',');
const sizes = (arg('sizes') ?? '200,400,800,2000').split(',').map(Number);
const iterations = Number(arg('iterations') ?? 15);
const srcRoot = resolve(here, arg('src') ?? '../src');
const load = async (path: string): Promise<Record<string, unknown>> =>
  (await import(pathToFileURL(resolve(srcRoot, path)).href)) as Record<string, unknown>;

// The engine is imported by path so the same script can measure a pristine copy of the sources.
const normalizeMod = await load('ingest/normalize.ts');
const knowledgeMod = await load('knowledge/index.ts');
const temporalMod = await load('engine/temporal.ts');
const pipelineMod = await load('engine/pipeline.ts');
const graphMod = await load('engine/graph.ts');
const timelineMod = await load('engine/timeline.ts');
const counterfactualMod = await load('engine/counterfactual.ts');

type Fn = (...args: never[]) => unknown;
const fn = (mod: Record<string, unknown>, name: string): Fn => {
  const value = mod[name];
  if (typeof value !== 'function') throw new Error(`Missing export ${name} in ${srcRoot}`);
  return value as Fn;
};
const call = (mod: Record<string, unknown>, name: string, ...args: unknown[]): unknown =>
  (fn(mod, name) as (...a: unknown[]) => unknown)(...args);

const NOW = '2026-10-29T00:00:00.000Z';
const ctx = {
  tenantId: 'tenant_bench',
  caseId: 'case_bench',
  runId: 'run_bench',
  now: NOW,
  createdBy: 'bench',
  seed: 'bench',
};

const timed = <T>(run: () => T): { ms: number; value: T } => {
  const start = performance.now();
  const value = run();
  return { ms: performance.now() - start, value };
};

function bundleOf(events: CaseBundle['events']): CaseBundle {
  return CaseBundleSchema.parse({
    schemaVersion: 'caseguard.case-bundle/1',
    synthetic: true,
    case: {
      reference: 'CG-SYN-9001',
      title: 'Synthetic stress case',
      product: 'Microsoft Teams',
      workload: 'teams-authentication',
      severity: 'C',
      status: 'open',
      openedAt: '2026-03-09T09:00:00Z',
      customerAlias: 'Contoso Synthetic Ltd',
    },
    participants: [
      { id: 'p-cust', role: 'customer_admin', alias: 'Customer IT Admin 1' },
      { id: 'p-eng', role: 'support_engineer', alias: 'Support Engineer 1' },
    ],
    events,
  });
}

/** Schema-valid chain: every event answers the previous one (worst case for the responder closure). */
function chainBundle(n: number): CaseBundle {
  const start = Date.parse('2026-03-09T09:00:00Z');
  const events = Array.from({ length: n }, (_, i) => {
    const customer = i % 2 === 0;
    return {
      id: `c${String(i).padStart(4, '0')}`,
      timestamp: new Date(start + i * 600_000).toISOString().replace('.000Z', 'Z'),
      participantId: customer ? 'p-cust' : 'p-eng',
      type: customer ? 'customer_email' : 'engineer_action',
      body: customer
        ? `Users still cannot sign in, error ERR_NAME_NOT_RESOLVED again (round ${i}).`
        : `Compared the DNS resolvers again (round ${i}).`,
      ...(customer
        ? {}
        : {
            action: {
              actionKey: 'act.dns-resolver-comparison',
              label: `Compare resolvers ${i}`,
              customerEffort: 'low',
            },
          }),
      ...(i > 0 ? { inResponseTo: `c${String(i - 1).padStart(4, '0')}` } : {}),
    };
  });
  return bundleOf(events as CaseBundle['events']);
}

function wallOfHedges(events: number): CaseBundle {
  const start = Date.parse('2026-03-09T09:00:00Z');
  return bundleOf(
    Array.from({ length: events }, (_, i) => ({
      id: `h${String(i).padStart(3, '0')}`,
      timestamp: new Date(start + i * 60_000).toISOString().replace('.000Z', 'Z'),
      participantId: 'p-eng',
      type: 'case_note',
      body: 'Likely. '.repeat(2500),
    })) as CaseBundle['events'],
  );
}

function prepare(bundle: CaseBundle) {
  const raw = JSON.stringify(bundle);
  const normalized = call(normalizeMod, 'normalizeBundle', bundle, {
    tenantId: ctx.tenantId,
    caseId: ctx.caseId,
    sourceId: 'src_bench',
    createdBy: 'bench',
    now: NOW,
    sourceKind: 'builtin_sample',
    storedPayload: raw,
    redactionReplacements: 0,
  }) as { events: unknown[]; resolution: unknown; case: { title: string } };
  const pack = call(knowledgeMod, 'getCompiledPack', bundle.case.workload);
  const view = call(temporalMod, 'createFullView', normalized.events, normalized.resolution);
  return { raw, normalized, pack, view, bytes: Buffer.byteLength(raw, 'utf8') };
}

const analyse = (p: ReturnType<typeof prepare>) =>
  call(pipelineMod, 'runDeterministicAnalysis', {
    view: p.view,
    pack: p.pack,
    config: DEFAULT_ACTION_VALUE_CONFIG,
    ctx,
  }) as {
    claims: unknown[];
    actions: unknown[];
    forks: unknown[];
    evidence: unknown[];
  };

console.log(`# Hardening benchmark (source: ${srcRoot})`);
console.log(`Node ${process.version}; times in ms; one run per row (no warm-up).`);

if (only.includes('chain')) {
  console.log('\n## Reply chain (event i answers event i-1)');
  console.log('| events | normalize | analysis | graph | timeline | actions | forks |');
  console.log('| ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const n of sizes) {
    const bundle = chainBundle(n);
    const norm = timed(() => prepare(bundle));
    const a = timed(() => analyse(norm.value));
    const analysis = a.value;
    const g = timed(() =>
      call(graphMod, 'buildInvestigationGraph', {
        caseTitle: norm.value.normalized.case.title,
        caseId: ctx.caseId,
        events: norm.value.normalized.events,
        analysis,
        asOf: null,
        now: NOW,
      }),
    );
    const t = timed(() =>
      call(timelineMod, 'buildTimelineResponse', {
        caseRecord: { id: ctx.caseId, openedAt: '2026-03-09T09:00:00Z' },
        events: norm.value.normalized.events,
        analysis,
        asOf: null,
        limit: 200,
      }),
    );
    console.log(
      `| ${n} | ${norm.ms.toFixed(0)} | ${a.ms.toFixed(0)} | ${g.ms.toFixed(0)} | ${t.ms.toFixed(0)} | ${analysis.actions.length} | ${analysis.forks.length} |`,
    );
  }
}

if (only.includes('claims')) {
  console.log('\n## Wall of hedged sentences (100 case notes x 20,000 chars of "Likely. ")');
  const bundle = wallOfHedges(100);
  const p = prepare(bundle);
  const heapBefore = process.memoryUsage().heapUsed;
  const a = timed(() => analyse(p));
  const heapMb = Math.round((process.memoryUsage().heapUsed - heapBefore) / 1_048_576);
  console.log(
    `payload ${p.bytes} bytes; analysis ${a.ms.toFixed(0)} ms; claims ${a.value.claims.length}; heap delta ~${heapMb} MB`,
  );
}

if (only.includes('tokens')) {
  console.log('\n## Leak-check token scan on `a-` repeated 10,000 times per later event');
  console.log('| later events | futureOnlyTokens ms |');
  console.log('| ---: | ---: |');
  for (const count of [5, 10, 20]) {
    const start = Date.parse('2026-03-09T09:00:00Z');
    const bundle = bundleOf(
      Array.from({ length: count + 1 }, (_, i) => ({
        id: `t${String(i).padStart(3, '0')}`,
        timestamp: new Date(start + i * 60_000).toISOString().replace('.000Z', 'Z'),
        participantId: i === 0 ? 'p-cust' : 'p-eng',
        type: i === 0 ? 'customer_email' : 'case_note',
        body: i === 0 ? 'Users cannot sign in.' : 'a-'.repeat(10_000),
      })) as CaseBundle['events'],
    );
    const p = prepare(bundle);
    const events = p.normalized.events as { id: string }[];
    const pre = call(temporalMod, 'createTemporalViewBeforeEvent', events, events[1]?.id);
    const r = timed(() => call(counterfactualMod, 'futureOnlyTokens', events, pre, ''));
    console.log(`| ${count} | ${r.ms.toFixed(1)} |`);
  }
}

if (only.includes('cases')) {
  console.log(
    `\n## Synthetic cases (${iterations} iterations after 3 warm-ups; counterfactual = 3 strategies x 200 rollouts for the middle fork)`,
  );
  console.log('| case | events | stage | mean ms | p50 ms | min ms |');
  console.log('| --- | ---: | --- | ---: | ---: | ---: |');
  const casesDir = resolve(here, '../../../synthetic-data/cases');
  const row = (label: string, events: number, stage: string, samples: number[]): void => {
    const sorted = [...samples].sort((a, b) => a - b);
    const mean = samples.reduce((s, x) => s + x, 0) / Math.max(1, samples.length);
    console.log(
      `| ${label} | ${events} | ${stage} | ${mean.toFixed(1)} | ${(sorted[Math.floor(sorted.length / 2)] ?? 0).toFixed(1)} | ${(sorted[0] ?? 0).toFixed(1)} |`,
    );
  };
  for (const file of ['case-one-teams-signin-dns.json', 'case-two-teams-signin-proxy.json']) {
    const bundle = CaseBundleSchema.parse(
      JSON.parse(readFileSync(resolve(casesDir, file), 'utf8')),
    );
    const p = prepare(bundle);
    const analysisSamples: number[] = [];
    const counterfactualSamples: number[] = [];
    for (let i = -3; i < iterations; i++) {
      const r = timed(() => analyse(p));
      const fork = r.value.forks[Math.floor(r.value.forks.length / 2)];
      const cf = fork
        ? timed(() =>
            call(pipelineMod, 'generateCounterfactuals', {
              analysis: r.value,
              fork,
              strategies: ['balanced', 'lowest_customer_effort', 'fastest_diagnosis'],
              events: p.normalized.events,
              resolution: p.normalized.resolution,
              pack: p.pack,
              config: DEFAULT_ACTION_VALUE_CONFIG,
              ctx,
            }),
          )
        : null;
      if (i >= 0) {
        analysisSamples.push(r.ms);
        if (cf) counterfactualSamples.push(cf.ms);
      }
    }
    const label = file.replace('.json', '');
    row(label, p.normalized.events.length, 'analysis', analysisSamples);
    if (counterfactualSamples.length > 0)
      row(label, p.normalized.events.length, 'counterfactual', counterfactualSamples);
  }
}
