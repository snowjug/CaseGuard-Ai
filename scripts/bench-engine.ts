import { cpus, freemem, loadavg, platform, release, totalmem, arch } from 'node:os';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import {
  CaseBundleSchema,
  DEFAULT_ACTION_VALUE_CONFIG,
  DEFAULT_QUALITY_CONFIG,
  type BundleEvent,
  type CaseBundle,
} from '../packages/schemas/src/index';
import { getCompiledPack, normalizeBundle, type EngineContext } from '../packages/domain/src/index';
import { computeAnalysis } from '../apps/api/src/services/analysis/compute';
import type { AnalysisInputs } from '../apps/api/src/services/analysis/inputs';

/**
 * `pnpm bench:engine [--sizes 15,31,100,300,1000,2000] [--repeat 5] [--out docs/PERFORMANCE_ENGINE.md] [--no-write]`
 *
 * How the cost of the deterministic analysis grows with the number of events of a case. It runs the same function the API runs
 * for an analysis (`computeAnalysis`: evidence, hypotheses, forks, counterfactuals, quality score, metrics, warnings, coaching,
 * skill matching) on the synthetic Case One stretched to each size, in this process, with no database and no network, and
 * reports CPU time and wall time per stage, events per second and peak memory. A stage that runs without yielding blocks the
 * API's event loop for as long as it takes, and a cancelled job stops at the next stage boundary, so the longest stage is
 * both the longest pause of other requests and the longest wait for a cancellation.
 *
 * It is a micro-benchmark of one process, not a load test, and nothing in it is a service-level objective.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CASE_FILE = resolve(ROOT, 'synthetic-data', 'cases', 'case-one-teams-signin-dns.json');

interface Options {
  readonly sizes: readonly number[];
  readonly repeat: number;
  readonly out: string;
  readonly write: boolean;
}

function parseArguments(argv: readonly string[]): Options {
  let sizes: number[] = [15, 31, 100, 300, 1000, 2000];
  let repeat = 5;
  let out = resolve(ROOT, 'docs', 'PERFORMANCE_ENGINE.md');
  let write = true;
  const args = argv.filter((argument) => argument !== '--');
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? '';
    const value = (): string => {
      const raw = argument.includes('=')
        ? argument.slice(argument.indexOf('=') + 1)
        : args[(index += 1)];
      if (raw === undefined) throw new Error(`${argument.split('=')[0]} needs a value`);
      return raw;
    };
    if (argument.startsWith('--sizes'))
      sizes = value()
        .split(',')
        .map((s) => Number.parseInt(s, 10));
    else if (argument.startsWith('--repeat')) repeat = Number.parseInt(value(), 10);
    else if (argument.startsWith('--out')) out = resolve(process.cwd(), value());
    else if (argument === '--no-write') write = false;
    else
      throw new Error(
        `Unknown argument ${argument}. Usage: bench:engine [--sizes a,b,c] [--repeat N] [--out file] [--no-write]`,
      );
  }
  if (sizes.some((size) => !Number.isInteger(size) || size < 1 || size > 2000))
    throw new Error('--sizes takes whole numbers from 1 to 2000 (the bundle limit)');
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 100)
    throw new Error('--repeat takes a whole number from 1 to 100');
  return { sizes, repeat, out, write };
}

/** An instant in the whole-second form the samples use (`…:00Z`), which is also how the bundle validator orders them. */
const wholeSeconds = (ms: number): string => new Date(ms).toISOString().replace('.000Z', 'Z');

/** The synthetic Case One with its events repeated, in order, until it has `size` events. Every id and instant is new. */
function stretch(bundle: CaseBundle, size: number): CaseBundle {
  const base = bundle.events;
  const first = Date.parse(base[0]?.timestamp ?? bundle.case.openedAt);
  const last = Date.parse(base[base.length - 1]?.timestamp ?? bundle.case.openedAt);
  const span = last - first + 3_600_000;
  const baseIds = new Set(base.map((event) => event.id));
  const events: BundleEvent[] = Array.from({ length: size }, (_, i) => {
    const round = Math.floor(i / base.length);
    const source = base[i % base.length] as BundleEvent;
    const suffix = round === 0 ? '' : `-r${round}`;
    const rename = (id: string): string => (baseIds.has(id) ? `${id}${suffix}` : id);
    return {
      ...source,
      id: rename(source.id),
      timestamp: wholeSeconds(Date.parse(source.timestamp) + round * span),
      ...(source.inResponseTo ? { inResponseTo: rename(source.inResponseTo) } : {}),
      ...(source.action?.repeatOf
        ? { action: { ...source.action, repeatOf: rename(source.action.repeatOf) } }
        : {}),
    };
  });
  const end = Date.parse(events[events.length - 1]?.timestamp ?? bundle.case.openedAt);
  const resolvedAt = wholeSeconds(end + 600_000);
  const resolution = bundle.resolution
    ? {
        ...bundle.resolution,
        resolvedAt,
        ...(bundle.resolution.validation
          ? {
              validation: {
                ...bundle.resolution.validation,
                validatedAt: resolvedAt,
                evidenceEventIds: events
                  .slice(
                    -Math.min(bundle.resolution.validation.evidenceEventIds.length, events.length),
                  )
                  .map((event) => event.id),
              },
            }
          : {}),
      }
    : undefined;
  return CaseBundleSchema.parse({
    ...bundle,
    case: { ...bundle.case, ...(bundle.case.closedAt ? { closedAt: resolvedAt } : {}) },
    events,
    ...(resolution ? { resolution } : {}),
  });
}

function inputsFor(bundle: CaseBundle): { inputs: AnalysisInputs; ctx: EngineContext } {
  const normalized = normalizeBundle(bundle, {
    tenantId: 'tenant_bench',
    caseId: 'case_bench',
    sourceId: 'src_bench',
    createdBy: 'system:bench',
    now: '2026-01-01T00:00:00.000Z',
    sourceKind: 'builtin_sample',
    storedPayload: '{}',
    redactionReplacements: 0,
  });
  const pack = getCompiledPack(bundle.case.workload);
  if (pack === null) throw new Error('the teams-authentication pack is missing');
  return {
    inputs: {
      caseRecord: normalized.case,
      source: normalized.source,
      events: normalized.events,
      resolution: normalized.resolution,
      pack,
      actionConfig: DEFAULT_ACTION_VALUE_CONFIG,
      qualityConfig: DEFAULT_QUALITY_CONFIG,
      skills: [],
      unitPrices: { inputPer1kUsd: null, outputPer1kUsd: null, cachedInputPer1kUsd: null },
    },
    ctx: {
      tenantId: 'tenant_bench',
      caseId: 'case_bench',
      runId: 'run_bench',
      now: '2026-01-01T00:00:00.000Z',
      createdBy: 'system:bench',
      seed: 'bench-seed',
    },
  };
}

interface Run {
  readonly wallMs: number;
  readonly cpuMs: number;
  readonly stages: ReadonlyMap<string, number>;
  readonly heapMb: number;
}

async function runOnce(inputs: AnalysisInputs, ctx: EngineContext): Promise<Run> {
  const stages = new Map<string, number>();
  let current: { id: string; at: number } | null = null;
  const close = (now: number): void => {
    if (current) stages.set(current.id, (stages.get(current.id) ?? 0) + (now - current.at));
  };
  const cpuBefore = process.cpuUsage();
  const start = performance.now();
  await computeAnalysis(inputs, ctx, (id) => {
    const now = performance.now();
    close(now);
    current = { id, at: now };
    return Promise.resolve();
  });
  const end = performance.now();
  close(end);
  const cpu = process.cpuUsage(cpuBefore);
  return {
    wallMs: end - start,
    cpuMs: (cpu.user + cpu.system) / 1000,
    stages,
    heapMb: process.memoryUsage().heapUsed / 1_048_576,
  };
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
};
const fixed = (value: number, digits = 0): string => value.toFixed(digits);

interface Row {
  readonly size: number;
  readonly wall: number;
  readonly cpu: number;
  readonly max: number;
  readonly stages: Map<string, number>;
  readonly eventsPerSecond: number;
  readonly heapMb: number;
  readonly maxRssMb: number;
}

async function measure(options: Options): Promise<Row[]> {
  const bundle = CaseBundleSchema.parse(JSON.parse(readFileSync(CASE_FILE, 'utf8')));
  const rows: Row[] = [];
  for (const size of options.sizes) {
    const { inputs, ctx } = inputsFor(stretch(bundle, size));
    await runOnce(inputs, ctx); // warm-up: compiles regular expressions and warms the JIT, not counted
    const runs: Run[] = [];
    for (let i = 0; i < options.repeat; i += 1) runs.push(await runOnce(inputs, ctx));
    const stageIds = [...new Set(runs.flatMap((run) => [...run.stages.keys()]))];
    const stages = new Map(
      stageIds.map((id) => [id, median(runs.map((run) => run.stages.get(id) ?? 0))] as const),
    );
    const wall = median(runs.map((run) => run.wallMs));
    rows.push({
      size,
      wall,
      cpu: median(runs.map((run) => run.cpuMs)),
      max: Math.max(...runs.map((run) => run.wallMs)),
      stages,
      eventsPerSecond: size / (wall / 1000),
      heapMb: median(runs.map((run) => run.heapMb)),
      maxRssMb: process.resourceUsage().maxRSS / 1024,
    });
    console.log(
      `[bench] ${size} events: median ${fixed(wall)} ms wall, ${fixed(rows[rows.length - 1]?.cpu ?? 0)} ms CPU`,
    );
  }
  return rows;
}

function loadNow(): string {
  return loadavg()
    .map((value) => value.toFixed(2))
    .join(' / ');
}

async function render(rows: readonly Row[], options: Options, loadBefore: string): Promise<string> {
  const stageIds = [...new Set(rows.flatMap((row) => [...row.stages.keys()]))];
  const stageLabel: Record<string, string> = {
    analyse: 'Evidence, hypotheses, forks',
    counterfactuals: 'Counterfactual paths',
    assess: 'Quality score and metrics',
    warnings: 'Warning replay',
    skills: 'Skill matching and coaching',
  };
  const longest = (row: Row): [string, number] =>
    [...row.stages].reduce<[string, number]>(
      (best, entry) => (entry[1] > best[1] ? entry : best),
      ['', 0],
    );
  const lines: string[] = [
    '# Engine performance',
    '',
    '> Generated by `pnpm bench:engine` (`scripts/bench-engine.ts`). Do not edit by hand: re-run the command. The numbers below are exactly what that run measured.',
    '',
    `**What this is.** How the cost of one deterministic analysis grows with the size of the case, stage by stage. It runs \`computeAnalysis\`, the whole of what the API runs for an analysis, on the synthetic Case One stretched to each size by repeating its events in order with new ids and instants. It runs in this process with no database and no network. Each size has 1 warm-up run (not counted) and ${options.repeat} timed runs; the figures are medians unless the column says maximum. \`pnpm bench\` ([EVALUATION.md](EVALUATION.md#6-performance)) measures the parts of the engine and hostile inputs; this one measures the whole and splits it by stage, which is what decides how long other requests can be delayed and how long a cancellation can wait. The model path is not part of it: with the deterministic provider the model tasks run in the same process after the analysis and add no measurable time of their own.`,
    '',
    '## Results',
    '',
    '| Events | Wall time (ms) | CPU time (ms) | Slowest run (ms) | Events per second | Heap after (MB) | Peak resident memory so far (MB) | Longest stage |',
    '| -----: | -------------: | ------------: | ---------------: | ----------------: | --------------: | -------------------------------: | ------------- |',
    ...rows.map((row) => {
      const [id, ms] = longest(row);
      return `| ${row.size} | ${fixed(row.wall)} | ${fixed(row.cpu)} | ${fixed(row.max)} | ${fixed(row.eventsPerSecond, 1)} | ${fixed(row.heapMb)} | ${fixed(row.maxRssMb)} | ${stageLabel[id] ?? id} (${fixed(ms)} ms) |`;
    }),
    '',
    '### Wall time by stage (ms, median)',
    '',
    `| Events | ${stageIds.map((id) => stageLabel[id] ?? id).join(' | ')} |`,
    `| -----: | ${stageIds.map(() => '---: ').join('| ')}|`,
    ...rows.map(
      (row) =>
        `| ${row.size} | ${stageIds.map((id) => fixed(row.stages.get(id) ?? 0)).join(' | ')} |`,
    ),
    '',
    '### How the cost grows',
    '',
    '| Events | Wall time per event (ms) | Growth against the previous size (time) | Growth against the previous size (events) |',
    '| -----: | -----------------------: | --------------------------------------: | ----------------------------------------: |',
    ...rows.map((row, i) => {
      const previous = rows[i - 1];
      return `| ${row.size} | ${fixed(row.wall / row.size, 2)} | ${previous ? `x${fixed(row.wall / previous.wall, 1)}` : '-'} | ${previous ? `x${fixed(row.size / previous.size, 1)}` : '-'} |`;
    }),
    '',
    '## Environment',
    '',
    '| | |',
    '| --- | --- |',
    `| Date of the run (UTC) | ${new Date().toISOString()} |`,
    `| Operating system | ${platform()} ${release()} (${arch()}) |`,
    `| CPU | ${cpus()[0]?.model ?? 'unknown'}, ${cpus().length} logical cores |`,
    `| Memory | ${(totalmem() / 2 ** 30).toFixed(1)} GiB total, ${(freemem() / 2 ** 30).toFixed(1)} GiB free at the end of the run |`,
    `| Node.js | ${process.version} |`,
    '| Database, network, model | none: the analysis only |',
    `| Load average before, after the run (1, 5 and 15 minutes; ${cpus().length} logical CPUs) | ${loadBefore}, then ${loadNow()} |`,
    '',
    '> **Other processes were running while this was measured if the load above is high, so the wall times are noisy.** CPU time is less sensitive to a busy machine than wall time but not immune to it. Treat the figures as an order of magnitude and re-run on a quiet machine before quoting them.',
    '',
    '## Reading the tables',
    '',
    '- **A stage runs without yielding.** The analysis awaits only between stages, so while a stage runs the API process answers nothing else. The longest stage at a given size is the longest pause other requests can see, and the longest time a cancellation can wait: a cancelled job stops at the next stage boundary.',
    '- **The stretched case repeats Case One.** It exercises the cost per event, the per-case limits (claims, matches per detector, scan length) and the superlinear terms. It does not reproduce the variety of a real long case, so a real one can cost more or less.',
    '- **The model path adds nothing here.** A real provider adds its own latency and cost per request, which this benchmark does not measure ([AI_ORCHESTRATION.md](AI_ORCHESTRATION.md)).',
    '- **The pilot target** these figures are read against is in [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md#pilot-performance-target).',
    '',
    '## Reproduce',
    '',
    '```bash',
    'pnpm bench:engine                              # sizes 15, 31, 100, 300, 1000, 2000; 5 timed runs each; writes this file',
    'pnpm bench:engine --sizes 31,100 --repeat 3    # a quick run',
    'pnpm bench:engine --no-write                   # print only',
    '```',
    '',
  ];
  const text = lines.join('\n');
  const config = await resolveConfig(resolve(ROOT, 'docs', 'PERFORMANCE_ENGINE.md'));
  return format(text, { ...config, parser: 'markdown' });
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const loadBefore = loadNow();
  const rows = await measure(options);
  const markdown = await render(rows, options, loadBefore);
  if (options.write) {
    writeFileSync(options.out, markdown);
    console.log(`[bench] wrote ${options.out}`);
  } else {
    console.log(markdown);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
