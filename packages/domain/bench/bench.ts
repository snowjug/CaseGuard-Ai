/* eslint-disable no-console -- CLI that reports measured timings */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { cpus, platform, release } from 'node:os';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { CaseBundleSchema, DEFAULT_ACTION_VALUE_CONFIG } from '@caseguard/schemas';
import {
  buildDigitalTwin,
  buildInvestigationGraph,
  buildTimelineResponse,
  createFullView,
  generateCounterfactuals,
  getCompiledPack,
  normalizeBundle,
  runDeterministicAnalysis,
} from '../src';

/**
 * Measures the real cost of the deterministic engine on the synthetic cases. Numbers are printed (and
 * optionally written to docs/benchmarks/latest.md with --write); nothing here is estimated or invented.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const iterations = Number(
  process.argv.find((a) => a.startsWith('--iterations='))?.split('=')[1] ?? 15,
);
const write = process.argv.includes('--write');
const CASES = ['case-one-teams-signin-dns.json', 'case-two-teams-signin-proxy.json'];
const NOW = '2026-10-29T00:00:00.000Z';

interface Stat {
  mean: number;
  p50: number;
  p95: number;
  max: number;
}

function stats(samples: number[]): Stat {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return {
    mean: samples.reduce((s, x) => s + x, 0) / Math.max(1, samples.length),
    p50: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function time<T>(fn: () => T): { ms: number; value: T } {
  const start = performance.now();
  const value = fn();
  return { ms: performance.now() - start, value };
}

const rows: string[] = [];
for (const file of CASES) {
  const raw = readFileSync(resolve(root, 'synthetic-data/cases', file), 'utf8');
  const bundle = CaseBundleSchema.parse(JSON.parse(raw));
  const pack = getCompiledPack(bundle.case.workload);
  if (!pack) throw new Error(`No knowledge pack for ${bundle.case.workload}`);
  const ctx = {
    tenantId: 'tenant_bench',
    caseId: 'case_bench',
    runId: 'run_bench',
    now: NOW,
    createdBy: 'bench',
    seed: 'bench',
  };
  const normalize = () =>
    normalizeBundle(bundle, {
      tenantId: ctx.tenantId,
      caseId: ctx.caseId,
      sourceId: 'src_bench',
      createdBy: 'bench',
      now: NOW,
      sourceKind: 'builtin_sample',
      storedPayload: raw,
      redactionReplacements: 0,
    });

  const samples: Record<string, number[]> = {
    normalize: [],
    analysis: [],
    counterfactual: [],
    views: [],
  };
  let events = 0;
  let forks = 0;
  for (let i = -3; i < iterations; i++) {
    const n = time(normalize);
    const normalized = n.value;
    const view = createFullView(normalized.events, normalized.resolution);
    const a = time(() =>
      runDeterministicAnalysis({ view, pack, config: DEFAULT_ACTION_VALUE_CONFIG, ctx }),
    );
    const analysis = a.value;
    const fork = analysis.forks[Math.floor(analysis.forks.length / 2)];
    const c = fork
      ? time(() =>
          generateCounterfactuals({
            analysis,
            fork,
            strategies: ['balanced', 'lowest_customer_effort', 'fastest_diagnosis'],
            events: normalized.events,
            resolution: normalized.resolution,
            pack,
            config: DEFAULT_ACTION_VALUE_CONFIG,
            ctx,
          }),
        )
      : { ms: 0, value: null };
    const v = time(() => {
      buildDigitalTwin({
        caseRecord: normalized.case,
        events: normalized.events,
        resolution: normalized.resolution,
        analysis,
        pack,
        ctx,
        asOf: null,
      });
      buildTimelineResponse({
        caseRecord: normalized.case,
        events: normalized.events,
        analysis,
        asOf: null,
      });
      buildInvestigationGraph({
        caseTitle: normalized.case.title,
        caseId: ctx.caseId,
        events: normalized.events,
        analysis,
        asOf: null,
        now: NOW,
      });
    });
    if (i >= 0) {
      samples.normalize?.push(n.ms);
      samples.analysis?.push(a.ms);
      if (fork) samples.counterfactual?.push(c.ms);
      samples.views?.push(v.ms);
    }
    events = normalized.events.length;
    forks = analysis.forks.length;
  }
  for (const [name, values] of Object.entries(samples)) {
    if (values.length === 0) continue;
    const s = stats(values);
    rows.push(
      `| ${file.replace('.json', '')} | ${events} events / ${forks} forks | ${name} | ${s.mean.toFixed(1)} | ${s.p50.toFixed(1)} | ${s.p95.toFixed(1)} | ${s.max.toFixed(1)} |`,
    );
  }
}

const header = [
  '# Engine benchmarks (measured)',
  '',
  `Measured on ${cpus()[0]?.model ?? 'unknown CPU'} (${cpus().length} logical cores), ${platform()} ${release()}, Node ${process.version}, ${iterations} iterations after 3 warm-ups.`,
  'Single-threaded, in-process, no database or network. The counterfactual row generates three strategies at 200 rollouts each for one fork. These numbers describe this machine only.',
  '',
  '| Case | Size | Stage | mean ms | p50 ms | p95 ms | max ms |',
  '| --- | --- | --- | ---: | ---: | ---: | ---: |',
  ...rows,
  '',
].join('\n');

console.log(header);
if (write) {
  const out = resolve(root, 'docs/benchmarks/latest.md');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, header, 'utf8');
  console.log(`Wrote ${out}`);
}
