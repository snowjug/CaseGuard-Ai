import { cpus, freemem, platform, release, totalmem, arch } from 'node:os';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { loadConfig } from '../packages/config/src/index';
import { buildApp } from '../apps/api/src/app';
import { createInfrastructure } from '../apps/api/src/container';
import { createHandlers } from '../apps/api/src/routes';
import { autoSeedDemo } from '../apps/api/src/services/demo/auto-seed';
import packageJson from '../apps/api/package.json';

/**
 * `pnpm bench:api [--iterations N] [--warmup N] [--out docs/PERFORMANCE.md] [--no-write]`
 *
 * A micro-benchmark of ONE local API process, not a load test: the API is built in this process (`buildApp`, requests
 * are injected, no network), on an in-memory PGlite database seeded with the synthetic demo story, with the
 * deterministic AI provider (no external call). For each operation it runs a few warm-up requests and then N timed
 * ones, and reports p50, p95 and the maximum in milliseconds. It writes `docs/PERFORMANCE.md` with the numbers it just
 * measured and the environment they were measured in. Nothing here is a service-level objective.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PERSONAS = {
  engineer: 'user_ava_engineer',
  manager: 'user_morgan_manager',
  admin: 'user_alex_admin',
} as const;

interface Options {
  readonly iterations: number;
  readonly warmup: number;
  readonly out: string;
  readonly write: boolean;
}

function parseArguments(argv: readonly string[]): Options {
  let iterations = 20;
  let warmup = 3;
  let out = resolve(ROOT, 'docs', 'PERFORMANCE.md');
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
    if (argument.startsWith('--iterations')) iterations = Number.parseInt(value(), 10);
    else if (argument.startsWith('--warmup')) warmup = Number.parseInt(value(), 10);
    else if (argument.startsWith('--out')) out = resolve(process.cwd(), value());
    else if (argument === '--no-write') write = false;
    else
      throw new Error(
        `Unknown argument ${argument}. Usage: bench:api [--iterations N] [--warmup N] [--out file] [--no-write]`,
      );
  }
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 1_000)
    throw new Error('--iterations must be 1 to 1000');
  if (!Number.isInteger(warmup) || warmup < 0 || warmup > 100)
    throw new Error('--warmup must be 0 to 100');
  return { iterations, warmup, out, write };
}

interface Stats {
  readonly n: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

/** Nearest-rank percentiles of the samples. No smoothing and no rounding. */
function summarize(samples: readonly number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = (percent: number): number =>
    sorted[Math.max(0, Math.ceil((percent / 100) * sorted.length) - 1)] ?? Number.NaN;
  return { n: sorted.length, p50: rank(50), p95: rank(95), max: sorted.at(-1) ?? Number.NaN };
}

interface Result {
  readonly label: string;
  readonly request: string;
  readonly stats: Stats;
  readonly note?: string;
}

/** Share of all logical CPUs that was busy during `windowMs` (0 to 1), counting every process on the machine. */
async function cpuBusyShare(windowMs: number): Promise<number> {
  const read = () =>
    cpus().reduce(
      (sum, cpu) => ({
        idle: sum.idle + cpu.times.idle,
        total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0),
      }),
      { idle: 0, total: 0 },
    );
  const before = read();
  await new Promise((done) => setTimeout(done, windowMs));
  const after = read();
  const total = after.total - before.total;
  return total <= 0 ? 0 : 1 - (after.idle - before.idle) / total;
}

async function main(): Promise<number> {
  const options = parseArguments(process.argv.slice(2));
  const busyBefore = await cpuBusyShare(1_000);
  const storageDir = resolve(ROOT, '.data', `bench-objects-${process.pid}`);
  mkdirSync(storageDir, { recursive: true });

  const config = loadConfig(
    {
      APP_ENV: 'local',
      DATABASE_URL: 'pglite://memory',
      STORAGE_PROVIDER: 'local',
      STORAGE_LOCAL_DIR: storageDir,
      SEARCH_PROVIDER: 'lexical',
      AI_PROVIDER: 'deterministic',
      DEMO_MODE: 'true',
      DEMO_AUTO_SEED: 'false',
      LOG_LEVEL: 'error',
      RATE_LIMIT_MAX: '1000000',
      RATE_LIMIT_AI_MAX: '1000000',
    },
    { defaultVersion: packageJson.version },
  );
  console.log(
    '[bench] starting the API in this process (in-memory PGlite, deterministic AI provider)...',
  );
  const infra = await createInfrastructure(config);
  const app = await buildApp({ infra, handlers: createHandlers(infra) });
  try {
    const seedStarted = performance.now();
    await autoSeedDemo(infra);
    console.log(
      `[bench] demo story seeded in ${((performance.now() - seedStarted) / 1000).toFixed(1)} s (not part of the results)`,
    );

    interface Reply {
      readonly status: number;
      readonly body: Record<string, unknown>;
    }
    const call = async (
      persona: keyof typeof PERSONAS,
      method: 'GET' | 'POST' | 'DELETE',
      url: string,
      payload?: unknown,
      headers: Record<string, string> = {},
    ): Promise<Reply> => {
      const response = await app.inject({
        method,
        url: `/api/v1${url}`,
        headers: {
          'x-cg-persona': PERSONAS[persona],
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
      });
      const text = response.body;
      return {
        status: response.statusCode,
        body:
          text.length > 0 && String(response.headers['content-type']).includes('json')
            ? (JSON.parse(text) as Record<string, unknown>)
            : {},
      };
    };
    const ok = (reply: Reply, what: string, expected: readonly number[] = [200]): Reply => {
      if (!expected.includes(reply.status))
        throw new Error(
          `${what} answered ${reply.status}: ${JSON.stringify(reply.body).slice(0, 300)}`,
        );
      return reply;
    };

    const state = ok(await call('admin', 'GET', '/demo/state'), 'demo.state').body as {
      caseOneId: string;
      caseTwoId: string;
    };
    const caseOne = state.caseOneId;
    const results: Result[] = [];

    /** Runs `warmup` untimed and `iterations` timed repetitions of `run(i)`; the sample is the time of each. */
    const measure = async (
      run: (index: number) => Promise<void>,
      warmupRuns = options.warmup,
      runs = options.iterations,
    ): Promise<number[]> => {
      for (let index = 0; index < warmupRuns; index += 1) await run(-1 - index);
      const samples: number[] = [];
      for (let index = 0; index < runs; index += 1) {
        const started = performance.now();
        await run(index);
        samples.push(performance.now() - started);
      }
      return samples;
    };

    // (2) timeline retrieval, whole record
    results.push({
      label: 'Timeline retrieval, whole record',
      request: 'GET /cases/:id/timeline?limit=200 (Case One, 31 events)',
      stats: summarize(
        await measure(
          async () =>
            void ok(await call('engineer', 'GET', `/cases/${caseOne}/timeline`), 'timeline.get'),
        ),
      ),
    });

    // (2) timeline retrieval as of an earlier instant: cold (the engine recomputes the view) and warm (cached window)
    const timeline = ok(await call('engineer', 'GET', `/cases/${caseOne}/timeline`), 'timeline.get')
      .body as { events: { timestamp: string }[] };
    const instants = [...new Set(timeline.events.map((event) => event.timestamp))];
    // The API allows 30 cold earlier views per user per minute, so a run never asks for more distinct windows than that.
    const coldRuns = Math.min(options.iterations, 25, instants.length - 2);
    const coldSamples: number[] = [];
    for (let index = 0; index < coldRuns; index += 1) {
      const instant = instants[index + 1]!;
      const started = performance.now();
      ok(
        await call(
          'engineer',
          'GET',
          `/cases/${caseOne}/timeline?asOf=${encodeURIComponent(instant)}&limit=200`,
        ),
        'timeline.get asOf (cold)',
      );
      coldSamples.push(performance.now() - started);
    }
    results.push({
      label: 'Timeline retrieval as of an earlier instant, cold',
      request: 'GET /cases/:id/timeline?asOf=<event instant> (first time that window is asked for)',
      stats: summarize(coldSamples),
      note: `${coldSamples.length} distinct windows, no warm-up: the per-user budget of cold earlier views is 30 per minute`,
    });
    const warmWindows = instants.slice(1, coldRuns + 1);
    results.push({
      label: 'Timeline retrieval as of an earlier instant, warm',
      request: 'the same requests again (window already computed and cached)',
      stats: summarize(
        await measure(async (index) => {
          const instant = warmWindows[Math.abs(index) % warmWindows.length]!;
          ok(
            await call(
              'engineer',
              'GET',
              `/cases/${caseOne}/timeline?asOf=${encodeURIComponent(instant)}&limit=200`,
            ),
            'timeline.get asOf (warm)',
          );
        }),
      ),
    });

    // (3) evidence retrieval
    results.push({
      label: 'Evidence retrieval',
      request: 'GET /cases/:id/evidence?limit=200 (Case One, 59 claims)',
      stats: summarize(
        await measure(
          async () =>
            void ok(
              await call('engineer', 'GET', `/cases/${caseOne}/evidence?limit=200`),
              'evidence.list',
            ),
        ),
      ),
    });

    // (5) quality-score retrieval
    results.push({
      label: 'Quality-score retrieval',
      request: 'GET /cases/:id/quality (whole record)',
      stats: summarize(
        await measure(
          async () =>
            void ok(await call('manager', 'GET', `/cases/${caseOne}/quality`), 'quality.get'),
        ),
      ),
    });

    // (4) counterfactual job initiation: the time to the 202, and separately how long the job takes to finish
    const forks = (
      ok(await call('engineer', 'GET', `/cases/${caseOne}/forks`), 'forks.list').body as {
        items: { id: string }[];
      }
    ).items;
    const initiation: number[] = [];
    const jobDurations: number[] = [];
    for (let index = 0; index < options.warmup + options.iterations; index += 1) {
      const fork = forks[index % forks.length]!;
      const started = performance.now();
      const reply = ok(
        await call(
          'engineer',
          'POST',
          `/cases/${caseOne}/forks/${fork.id}/counterfactuals`,
          { strategies: ['balanced', 'lowest_customer_effort', 'fastest_diagnosis'] },
          { 'idempotency-key': `bench-${process.pid}-${index}` },
        ),
        'counterfactuals.run',
        [202],
      );
      const initiated = performance.now();
      // Wait for the job before the next iteration, so one iteration never overlaps another one's CPU work.
      const job = reply.body.job as { id: string };
      for (;;) {
        const current = ok(await call('engineer', 'GET', `/jobs/${job.id}`), 'jobs.get').body as {
          status: string;
        };
        if (['succeeded', 'failed', 'cancelled'].includes(current.status)) break;
        await new Promise((done) => setTimeout(done, 20));
      }
      if (index >= options.warmup) {
        initiation.push(initiated - started);
        jobDurations.push(performance.now() - started);
      }
    }
    results.push({
      label: 'Counterfactual job initiation',
      request:
        'POST /cases/:id/forks/:forkId/counterfactuals, time to the 202 response (not the job)',
      stats: summarize(initiation),
    });
    results.push({
      label: 'Counterfactual job duration (for reference)',
      request: 'request start until jobs.get reports a terminal state, polled every 20 ms',
      stats: summarize(jobDurations),
      note: 'includes up to 20 ms of polling resolution',
    });

    // (1) case ingestion, into a fresh case reference per iteration (cleaned up afterwards, outside the measurement)
    const sample = JSON.parse(
      readFileSync(
        resolve(ROOT, 'synthetic-data', 'cases', 'case-two-teams-signin-proxy.json'),
        'utf8',
      ),
    ) as { case: { reference: string } };
    const createdIds: string[] = [];
    const ingestion = await measure(async (index) => {
      const bundle = {
        ...sample,
        case: {
          ...sample.case,
          reference: `CG-BENCH-${process.pid}-${index < 0 ? `W${-index}` : index}`,
        },
      };
      const reply = ok(
        await call('engineer', 'POST', '/cases', {
          source: { type: 'bundle', bundle },
          options: { analyze: false },
        }),
        'cases.create',
        [201],
      );
      createdIds.push((reply.body.case as { id: string }).id);
    });
    results.push({
      label: 'Case ingestion',
      request:
        'POST /cases with a 15-event bundle under a new reference each time, analysis not started',
      stats: summarize(ingestion),
    });
    for (const id of createdIds) await call('admin', 'DELETE', `/cases/${id}`);

    const busyAfter = await cpuBusyShare(1_000);
    const report = await tidy(
      render({ options, results, busyBefore, busyAfter, browser: readBrowserReport() }),
      options.out,
    );
    console.log(`\n${report}`);
    if (options.write) {
      mkdirSync(dirname(options.out), { recursive: true });
      writeFileSync(options.out, report, 'utf8');
      console.log(`[bench] wrote ${options.out}`);
    }
    return 0;
  } finally {
    await app.close();
    await infra.services.jobs.idle();
    await infra.close();
    rmSync(storageDir, { recursive: true, force: true });
  }
}

/** Formats the Markdown the way the repository's Prettier configuration does, so `format:check` accepts the file as written. */
async function tidy(markdown: string, file: string): Promise<string> {
  const options = await resolveConfig(file);
  return format(markdown, { ...options, parser: 'markdown' });
}

interface BrowserSummary {
  n: number;
  p50: number;
  p95: number;
  max: number;
}

interface BrowserReport {
  page: string;
  mode: string;
  browser: string;
  iterations: number;
  date: string;
  firstTimelineRow: BrowserSummary;
  largestContentfulPaint: BrowserSummary | null;
}

/** The numbers of `e2e/perf/timeline-render.spec.ts`, when it has been run on this checkout (`test-results/`). */
function readBrowserReport(): BrowserReport | null {
  try {
    return JSON.parse(
      readFileSync(resolve(ROOT, 'test-results', 'perf-timeline-render.json'), 'utf8'),
    ) as BrowserReport;
  } catch {
    return null;
  }
}

function render(input: {
  options: Options;
  results: readonly Result[];
  busyBefore: number;
  busyAfter: number;
  browser: BrowserReport | null;
}): string {
  const { options, results, busyBefore, busyAfter, browser } = input;
  const cpu = cpus();
  const ms = (value: number): string => value.toFixed(2);
  const percent = (share: number): string => `${(share * 100).toFixed(0)} %`;
  const loaded = Math.max(busyBefore, busyAfter) > 0.25;
  const lines: string[] = [
    '# Performance benchmark',
    '',
    '> Generated by `pnpm bench:api` (`scripts/bench-api.ts`). Do not edit by hand: re-run the command. The numbers below are exactly what that run measured.',
    '',
    '**What this is.** A micro-benchmark of one local API process: the API is built in the benchmark process (`buildApp`), requests are injected without a network, the database is an in-memory PGlite seeded with the synthetic demo story, and the AI provider is the deterministic offline engine (no model call). Every request goes through the real pipeline (authentication, permission check, validation, handler, response validation, audit). **What this is not.** It is not a load test (one request at a time), not a capacity plan and not a comparison with any other system, and no service-level objective is claimed. Case ingestion is measured without starting its analysis. The page-render timing of the Timeline page in a browser is measured separately by the on-demand Playwright spec `e2e/perf/timeline-render.spec.ts`.',
    '',
    '## Results',
    '',
    `Timed iterations per row: ${options.iterations} (after ${options.warmup} warm-up requests that are not counted), unless a note says otherwise. Times are milliseconds of the whole injected request, measured with \`performance.now()\`; p50 and p95 are nearest-rank percentiles, so with few samples p95 equals the maximum.`,
    '',
    '| Operation | Request | n | p50 (ms) | p95 (ms) | max (ms) |',
    '| --- | --- | ---: | ---: | ---: | ---: |',
    ...results.map(
      (result) =>
        `| ${result.label}${result.note ? ` (${result.note})` : ''} | ${result.request} | ${result.stats.n} | ${ms(result.stats.p50)} | ${ms(result.stats.p95)} | ${ms(result.stats.max)} |`,
    ),
    '',
    '## Environment',
    '',
    '| | |',
    '| --- | --- |',
    `| Date of the run (UTC) | ${new Date().toISOString()} |`,
    `| Operating system | ${platform()} ${release()} (${arch()}) |`,
    `| CPU | ${cpu[0]?.model.trim() ?? 'unknown'}, ${cpu.length} logical cores |`,
    `| Memory | ${(totalmem() / 1024 ** 3).toFixed(1)} GiB total, ${(freemem() / 1024 ** 3).toFixed(1)} GiB free at the end of the run |`,
    `| Node.js | ${process.version} |`,
    '| Database | PGlite (embedded PostgreSQL), in memory |',
    '| AI provider | deterministic (offline, simulated); no external service is called |',
    '| Data | the synthetic demo story (Case One: 31 events; Case Two: 15 events) |',
    `| Machine busy before / after the run | ${percent(busyBefore)} / ${percent(busyAfter)} of all logical CPUs, measured over one second each (includes this process) |`,
    '',
  ];
  if (loaded) {
    lines.push(
      '> **Other processes were running while this was measured, so the numbers are noisy.** The machine was already busy before the benchmark started. Treat the figures as an order of magnitude and re-run on a quiet machine before quoting them.',
      '',
    );
  }
  lines.push('## Browser: the Timeline page', '');
  if (browser) {
    const lcp = browser.largestContentfulPaint;
    lines.push(
      `Measured by \`e2e/perf/timeline-render.spec.ts\` on ${browser.date.slice(0, 10)} (${browser.iterations} timed navigations after 2 warm-up ones; ${browser.mode}; browser: ${browser.browser}). Milliseconds from the start of the navigation. Re-running the spec updates \`test-results/perf-timeline-render.json\`; the next \`pnpm bench:api\` copies it here.`,
      '',
      '| Measure | n | p50 (ms) | p95 (ms) | max (ms) |',
      '| --- | ---: | ---: | ---: | ---: |',
      `| First timeline row of ${browser.page} on screen | ${browser.firstTimelineRow.n} | ${ms(browser.firstTimelineRow.p50)} | ${ms(browser.firstTimelineRow.p95)} | ${ms(browser.firstTimelineRow.max)} |`,
      ...(lcp
        ? [
            `| Largest contentful paint | ${lcp.n} | ${ms(lcp.p50)} | ${ms(lcp.p95)} | ${ms(lcp.max)} |`,
          ]
        : []),
      '',
    );
  } else {
    lines.push(
      'Not measured by this run: the page-render timing comes from the on-demand Playwright spec (`$env:PW_PERF = "1"; pnpm.cmd exec playwright test --project=perf`), which needs the web app and the API running. Run it, then run `pnpm bench:api` again to include its figures here.',
      '',
    );
  }
  lines.push(
    '## Reading the table',
    '',
    '- **Timeline, whole record** serves the stored analysis. **Earlier instants** are recomputed by the engine on a temporal view that holds only what was recorded by then (never a filtered copy of the final analysis); the first request for a window is *cold*, a repeat is *warm* and comes from the cache.',
    '- **Counterfactual job initiation** is the time until the API answers `202` with a job; the job itself runs afterwards on the same process, and its duration is listed separately for reference. Each iteration runs the next key decision (a decision fork in the engine) of Case One in turn, so after the first round a key decision is asked for again; the engine keeps its recent replays in a cache, so a repeat can be cheaper than the first request for a fork, and the job durations are not one population.',
    '- Each run measures its own process from a cold start, so the first requests of a row may include one-time costs; that is what the warm-up requests are for.',
    '',
    '## Reproduce',
    '',
    '```powershell',
    'pnpm.cmd bench:api                       # 20 iterations, writes this file',
    'pnpm.cmd bench:api --iterations 3        # a quick smoke run',
    'pnpm.cmd bench:api --no-write            # print only',
    '```',
    '',
  );
  return lines.join('\n');
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`[bench] failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
