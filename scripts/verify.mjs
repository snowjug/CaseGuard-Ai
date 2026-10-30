#!/usr/bin/env node
// The full local validation loop: every quality gate as its own step, with duration and an honest status.
//
//   node scripts/verify.mjs [--only a,b] [--skip a,b] [--fail-fast] [--allow-not-run] [--list]
//                           [--json-out <file>] [--md-out <file>] [--no-md] [--no-write] [--step-timeout <min>]
//   node scripts/verify.mjs --merge <dir> [--external id=success|failure|cancelled|skipped ...]   (CI)
//
// Status rules (never relaxed): PASSED only when the step's command exited 0. Exit code 3 means the tool or
// service was unavailable (for example no Docker daemon): NOT RUN, which is not a pass. Every other outcome,
// including a timeout or a crash, is FAILED. Steps continue after a failure unless --fail-fast is given.
//
// Writes verification-report.json (override with --json-out) and prints a markdown table; a full run also
// writes docs/assets/VALIDATION_REPORT.md with an environment header (OS, Node, pnpm, date, commit).
// Filtered runs (--only/--skip) do not touch that markdown file unless --md-out is given explicitly.
//
// Exit codes: 0 all selected steps PASSED, 1 a step FAILED, 2 usage error, 3 nothing failed but a step was
// NOT RUN (use --allow-not-run to exit 0 in that case; the report still says NOT RUN).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { arch, release, type } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const EXIT = { PASSED: 0, FAILED: 1, USAGE: 2, NOT_RUN: 3 };
const WINDOWS = process.platform === 'win32';
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g');
const TAIL_LINES = 40;

const pnpm = (...args) => ['pnpm', 'run', ...args];
const STEPS = [
  { id: 'format:check', title: 'Prettier format check', commands: [pnpm('format:check')] },
  { id: 'lint', title: 'ESLint (type-aware)', commands: [pnpm('lint')] },
  {
    id: 'typecheck',
    title: 'TypeScript typecheck (all workspaces)',
    commands: [pnpm('typecheck')],
  },
  {
    id: 'generated:check',
    title: 'Generated files are current (JSON schemas, built-in samples, API reference)',
    commands: [
      pnpm('schemas:export', '--', '--check'),
      pnpm('samples:export', '--', '--check'),
      pnpm('docs:api', '--', '--check'),
    ],
  },
  {
    id: 'docs:check',
    title: 'Documentation links, anchors, diagrams and badges',
    commands: [pnpm('docs:check')],
  },
  { id: 'test:unit', title: 'Unit tests (Vitest)', commands: [pnpm('test:unit')] },
  { id: 'test:int', title: 'Integration tests (Vitest)', commands: [pnpm('test:int')] },
  { id: 'build', title: 'Production build (all workspaces)', commands: [pnpm('build')] },
  {
    id: 'test:e2e',
    title: 'End-to-end and accessibility tests (Playwright, axe)',
    commands: [pnpm('test:e2e')],
  },
  { id: 'secrets:scan', title: 'Secret scan', commands: [pnpm('secrets:scan')] },
  {
    id: 'audit:deps',
    title: 'Dependency audit (lockfile hygiene, vulnerabilities)',
    commands: [pnpm('audit:deps')],
  },
  {
    id: 'infra:validate',
    title: 'Bicep build, lint and parameter scan',
    commands: [pnpm('infra:validate')],
  },
  {
    id: 'docker:build',
    title: 'Container image builds and compose config',
    commands: [pnpm('docker:build')],
  },
  {
    id: 'demo:replay',
    title: 'Demo reset then seed replay',
    commands: [pnpm('demo:reset'), pnpm('demo:seed')],
  },
];
const STEP_IDS = STEPS.map((step) => step.id);

const quote = (arg) => (/[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg);

/** Runs one command, streaming its output; resolves with the exit code and the output tail (never rejects). */
function execCommand([command, ...args], { timeoutMs, cwd = ROOT }) {
  return new Promise((resolveRun) => {
    const line = [WINDOWS && command === 'pnpm' ? 'pnpm.cmd' : command, ...args]
      .map(quote)
      .join(' ');
    const child = WINDOWS
      ? spawn(line, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(command, args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let buffer = '';
    let timedOut = false;
    let spawnError = null;
    const keep = (chunk, sink) => {
      sink.write(chunk);
      buffer = (buffer + chunk.toString('utf8')).slice(-16_384);
    };
    child.stdout.on('data', (chunk) => keep(chunk, process.stdout));
    child.stderr.on('data', (chunk) => keep(chunk, process.stderr));
    const timer = setTimeout(() => {
      timedOut = true;
      if (WINDOWS) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
      else process.kill(-child.pid, 'SIGKILL');
    }, timeoutMs);
    child.on('error', (error) => {
      spawnError = error;
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const tail = buffer
        .replace(ANSI, '')
        .split(/\r?\n/)
        .filter((l) => l.trim() !== '')
        .slice(-TAIL_LINES);
      resolveRun({ code, signal, timedOut, error: spawnError, tail });
    });
  });
}

/** Maps one step's command results to a status. PASSED requires every command to exit 0. */
async function runStep(step, { exec, timeoutMs }) {
  const started = Date.now();
  let outcome = { status: 'PASSED', exitCode: 0, reason: null, tail: [] };
  for (const command of step.commands) {
    console.log(`\n=== ${step.id}: ${command.join(' ')} ===`);
    const result = await exec(command, { timeoutMs });
    if (result.code === 0 && !result.timedOut && !result.error) continue;
    // pnpm appends a generic ELIFECYCLE line to every failure; the line before it is the useful one.
    const meaningful = result.tail.filter(
      (l) => !/ELIFECYCLE|Command failed with exit code/.test(l),
    );
    const last = meaningful.at(-1) ?? '';
    if (result.code === EXIT.NOT_RUN && !result.timedOut) {
      const reason = [...result.tail].reverse().find((l) => /^\s*(?:NOT RUN|SKIPPED):/.test(l));
      outcome = {
        status: 'NOT RUN',
        exitCode: 3,
        reason: reason?.trim() ?? 'tool or service unavailable (exit code 3)',
        tail: result.tail,
      };
    } else {
      let reason = `exited with code ${result.code}`;
      if (result.timedOut) reason = `timed out after ${Math.round(timeoutMs / 60_000)} min`;
      else if (result.error)
        reason = `could not start (${result.error.code ?? result.error.message})`;
      else if (result.signal) reason = `terminated by ${result.signal}`;
      outcome = {
        status: 'FAILED',
        exitCode: result.code,
        reason: `${reason}${last ? `; last output: ${last.slice(0, 160)}` : ''}`,
        tail: result.tail,
      };
    }
    break;
  }
  return {
    id: step.id,
    title: step.title,
    command: step.commands.map((c) => c.join(' ')).join(' && '),
    status: outcome.status,
    exitCode: outcome.exitCode,
    durationMs: Date.now() - started,
    reason: outcome.reason,
    outputTail: outcome.status === 'PASSED' ? [] : outcome.tail,
  };
}

/** Runs the selected steps in order. Steps after a --fail-fast failure are recorded as NOT RUN. */
async function runAll(steps, { exec, timeoutMs, failFast }) {
  const results = [];
  let stoppedBy = null;
  for (const step of steps) {
    if (stoppedBy) {
      results.push({
        id: step.id,
        title: step.title,
        command: step.commands.map((c) => c.join(' ')).join(' && '),
        status: 'NOT RUN',
        exitCode: null,
        durationMs: 0,
        reason: `skipped: --fail-fast after ${stoppedBy} failed`,
        outputTail: [],
      });
      continue;
    }
    const result = await runStep(step, { exec, timeoutMs });
    results.push(result);
    if (result.status === 'FAILED' && failFast) stoppedBy = step.id;
  }
  return results;
}

function exitCodeFor(steps, allowNotRun) {
  if (steps.some((step) => step.status === 'FAILED')) return EXIT.FAILED;
  if (steps.some((step) => step.status === 'NOT RUN') && !allowNotRun) return EXIT.NOT_RUN;
  return EXIT.PASSED;
}

const formatDuration = (ms) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

function toolVersion(command, args) {
  const line = [command, ...args].map(quote).join(' ');
  const result = WINDOWS
    ? spawnSync(`${command === 'pnpm' ? 'pnpm.cmd' : command} ${args.join(' ')}`, {
        cwd: ROOT,
        encoding: 'utf8',
        shell: true,
      })
    : spawnSync(command, args, { cwd: ROOT, encoding: 'utf8' });
  const text = (result.stdout ?? '').trim().split(/\r?\n/).at(-1);
  return result.status === 0 && text ? text : `unavailable (${line})`;
}

function gitInfo() {
  const git = (args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  const sha = git(['rev-parse', 'HEAD']);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const status = git(['status', '--porcelain']);
  return {
    commit: sha.status === 0 ? sha.stdout.trim() : 'unknown',
    branch: branch.status === 0 ? branch.stdout.trim() : 'unknown',
    dirty: status.status === 0 ? status.stdout.trim() !== '' : null,
  };
}

function collectEnvironment() {
  return {
    os: `${type()} ${release()} (${arch()})`,
    node: process.version,
    pnpm: toolVersion('pnpm', ['--version']),
    date: new Date().toISOString(),
    ci: process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true',
    ...gitInfo(),
  };
}

function renderMarkdown(report) {
  const { environment: env, steps } = report;
  const commit = `${env.commit.slice(0, 12)}${env.dirty ? ' (working tree has uncommitted changes)' : ''}`;
  const rows = steps.map(
    (step) =>
      `| \`${step.id}\` | **${step.status}** | ${formatDuration(step.durationMs)} | \`${step.command}\` | ${(step.reason ?? '').replace(/\|/g, '\\|') || '-'} |`,
  );
  const counts = ['PASSED', 'FAILED', 'NOT RUN']
    .map((status) => `${steps.filter((step) => step.status === status).length} ${status}`)
    .join(', ');
  return [
    '# Validation report',
    '',
    `> Generated by \`pnpm verify\`${report.partial ? ' (PARTIAL run: only the listed steps were selected)' : ''}${report.merged ? ' (merged from CI jobs)' : ''}. Do not edit by hand.`,
    '> A step is **PASSED** only when its command exited 0. **NOT RUN** means it could not be executed in that environment (for example no Docker daemon) and is **not** a pass.',
    '',
    '| Environment | |',
    '| --- | --- |',
    `| OS | ${env.os} |`,
    `| Node | ${env.node} |`,
    `| pnpm | ${env.pnpm} |`,
    `| Date (UTC) | ${env.date} |`,
    `| Commit | ${commit} |`,
    `| Branch | ${env.branch} |`,
    `| CI | ${env.ci ? 'yes' : 'no'} |`,
    '',
    `Result: ${counts}`,
    '',
    '| Step | Status | Duration | Command | Notes |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

const WORST = { FAILED: 3, 'NOT RUN': 2, PASSED: 1 };

/** Combines per-step reports from several CI jobs; absent steps are NOT RUN, never PASSED. */
function mergeReports(reports, { externals = {}, expected = STEP_IDS }) {
  const byId = new Map();
  for (const step of reports.flatMap((report) => report.steps)) {
    const known = byId.get(step.id);
    if (!known || WORST[step.status] > WORST[known.status]) byId.set(step.id, step);
  }
  const mapped = { success: 'PASSED', failure: 'FAILED' };
  for (const [id, result] of Object.entries(externals)) {
    const status = mapped[result] ?? 'NOT RUN';
    const title = STEPS.find((step) => step.id === id)?.title ?? id;
    byId.set(id, {
      id,
      title,
      command: `CI job result: ${result}`,
      status,
      exitCode: null,
      durationMs: 0,
      reason: `reported by the CI job conclusion (${result})`,
      outputTail: [],
    });
  }
  const steps = expected.map((id) => {
    const found = byId.get(id);
    if (found) return found;
    const step = STEPS.find((candidate) => candidate.id === id);
    return {
      id,
      title: step?.title ?? id,
      command: step ? step.commands.map((c) => c.join(' ')).join(' && ') : id,
      status: 'NOT RUN',
      exitCode: null,
      durationMs: 0,
      reason: 'no report was produced (job skipped, cancelled or failed earlier)',
      outputTail: [],
    };
  });
  const first = reports[0]?.environment ?? collectEnvironment();
  return {
    schemaVersion: 1,
    merged: true,
    partial: false,
    environment: { ...first, date: new Date().toISOString() },
    options: { merged: reports.length },
    steps,
  };
}

function parseArgs(argv) {
  const options = {
    only: null,
    skip: [],
    failFast: false,
    allowNotRun: false,
    list: false,
    jsonOut: resolve(ROOT, 'verification-report.json'),
    mdOut: null,
    writeMd: true,
    write: true,
    stepTimeoutMin: 30,
    merge: null,
    externals: {},
    selfTest: false,
  };
  const ids = (text) =>
    text
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      i += 1;
      if (argv[i] === undefined) throw new Error(`${arg} needs a value`);
      return argv[i];
    };
    if (arg === '--only') options.only = ids(value());
    else if (arg === '--skip') options.skip = ids(value());
    else if (arg === '--fail-fast') options.failFast = true;
    else if (arg === '--allow-not-run') options.allowNotRun = true;
    else if (arg === '--list') options.list = true;
    else if (arg === '--json-out') options.jsonOut = resolve(process.cwd(), value());
    else if (arg === '--md-out') options.mdOut = resolve(process.cwd(), value());
    else if (arg === '--no-md') options.writeMd = false;
    else if (arg === '--no-write') options.write = false;
    else if (arg === '--step-timeout') options.stepTimeoutMin = Number.parseFloat(value());
    else if (arg === '--merge') options.merge = resolve(process.cwd(), value());
    else if (arg === '--external') {
      const [id, result] = value().split('=');
      if (!id || !result) throw new Error('--external expects id=result');
      options.externals[id] = result;
    } else if (arg === '--self-test') options.selfTest = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  for (const id of [...(options.only ?? []), ...options.skip, ...Object.keys(options.externals)]) {
    if (!STEP_IDS.includes(id))
      throw new Error(`unknown step "${id}". Known steps: ${STEP_IDS.join(', ')}`);
  }
  if (!Number.isFinite(options.stepTimeoutMin) || options.stepTimeoutMin <= 0)
    throw new Error('--step-timeout must be a positive number of minutes');
  return options;
}

function writeTarget(report, options) {
  if (!options.writeMd) return null;
  if (options.mdOut) return options.mdOut;
  return report.partial ? null : resolve(ROOT, 'docs', 'assets', 'VALIDATION_REPORT.md');
}

function writeReport(report, options) {
  if (!options.write) return;
  mkdirSync(dirname(options.jsonOut), { recursive: true });
  writeFileSync(options.jsonOut, `${JSON.stringify(report, null, 2)}\n`);
  const mdPath = writeTarget(report, options);
  if (mdPath) {
    mkdirSync(dirname(mdPath), { recursive: true });
    writeFileSync(mdPath, renderMarkdown(report));
  }
}

function finish(report, options) {
  const markdown = renderMarkdown(report);
  console.log(`\n${markdown}`);
  writeReport(report, options);
  const code = exitCodeFor(report.steps, options.allowNotRun);
  console.log(
    `verify: ${{ 0: 'PASSED', 1: 'FAILED', 3: 'NOT RUN (see the table: not a pass)' }[code]}`,
  );
  return code;
}

async function selfTest() {
  const results = [];
  const check = async (name, fn) => {
    let ok = false;
    try {
      ok = (await fn()) === true;
    } catch (error) {
      console.error(`  error in "${name}": ${error.message}`);
    }
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  };
  const quiet = async (fn) => {
    const log = console.log;
    console.log = () => {};
    try {
      return await fn();
    } finally {
      console.log = log;
    }
  };
  const fake = (codes) => async (command) => {
    const key = command.join(' ');
    const entry = codes[key] ?? { code: 0 };
    return {
      code: entry.code,
      signal: null,
      timedOut: Boolean(entry.timedOut),
      error: entry.error ?? null,
      tail: entry.tail ?? [],
    };
  };
  const two = STEPS.slice(0, 3);
  await check(
    'PASSED only for exit code 0; exit 3 is NOT RUN with the tool-provided reason; everything else FAILED',
    async () => {
      const exec = fake({
        'pnpm run lint': { code: 3, tail: ['NOT RUN: Docker daemon not available'] },
        'pnpm run typecheck': { code: 2 },
      });
      const results2 = await quiet(() => runAll(two, { exec, timeoutMs: 1000, failFast: false }));
      return (
        results2.map((r) => r.status).join() === 'PASSED,NOT RUN,FAILED' &&
        results2[1].reason.includes('Docker daemon') &&
        results2[0].exitCode === 0 &&
        results2[2].exitCode === 2
      );
    },
  );
  await check('timeouts and spawn errors are FAILED, never PASSED', async () => {
    const exec = fake({
      'pnpm run format:check': { code: null, timedOut: true },
      'pnpm run lint': { code: null, error: Object.assign(new Error('x'), { code: 'ENOENT' }) },
    });
    const r = await quiet(() => runAll(two, { exec, timeoutMs: 60_000, failFast: false }));
    return (
      r[0].status === 'FAILED' &&
      r[0].reason.includes('timed out') &&
      r[1].status === 'FAILED' &&
      r[1].reason.includes('ENOENT')
    );
  });
  await check(
    '--fail-fast marks the remaining steps NOT RUN with the reason; default continues',
    async () => {
      const exec = fake({ 'pnpm run format:check': { code: 1 } });
      const fast = await quiet(() => runAll(two, { exec, timeoutMs: 1000, failFast: true }));
      const slow = await quiet(() => runAll(two, { exec, timeoutMs: 1000, failFast: false }));
      return (
        fast.map((r) => r.status).join() === 'FAILED,NOT RUN,NOT RUN' &&
        fast[1].reason.includes('--fail-fast') &&
        slow.map((r) => r.status).join() === 'FAILED,PASSED,PASSED'
      );
    },
  );
  await check('multi-command steps stop at the first failure', async () => {
    const calls = [];
    const exec = async (command) => {
      calls.push(command.join(' '));
      return {
        code: command.includes('demo:reset') ? 1 : 0,
        signal: null,
        timedOut: false,
        error: null,
        tail: [],
      };
    };
    const replay = STEPS.find((s) => s.id === 'demo:replay');
    const r = await quiet(() => runStep(replay, { exec, timeoutMs: 1000 }));
    return r.status === 'FAILED' && calls.length === 1;
  });
  await check(
    'exit codes: FAILED=1, NOT RUN=3 unless allowed, otherwise 0',
    () =>
      exitCodeFor([{ status: 'PASSED' }], false) === 0 &&
      exitCodeFor([{ status: 'PASSED' }, { status: 'NOT RUN' }], false) === 3 &&
      exitCodeFor([{ status: 'NOT RUN' }], true) === 0 &&
      exitCodeFor([{ status: 'FAILED' }, { status: 'NOT RUN' }], true) === 1,
  );
  await check('markdown has the environment header and one row per step; pipes are escaped', () => {
    const env = {
      os: 'Test OS',
      node: 'v24',
      pnpm: '10',
      date: '2026-10-29T00:00:00Z',
      commit: 'a'.repeat(40),
      branch: 'b',
      dirty: true,
      ci: false,
    };
    const md = renderMarkdown({
      environment: env,
      steps: [
        {
          id: 'lint',
          status: 'FAILED',
          durationMs: 1500,
          command: 'pnpm run lint',
          reason: 'a | b',
        },
      ],
    });
    return (
      md.includes('| OS | Test OS |') &&
      md.includes('| Node | v24 |') &&
      md.includes('| Date (UTC) |') &&
      md.includes('uncommitted') &&
      md.includes('**FAILED** | 1.5 s') &&
      md.includes('a \\| b')
    );
  });
  await check(
    'merge: worst status wins, absent steps and skipped jobs are NOT RUN, external results are mapped honestly',
    () => {
      const step = (id, status) => ({
        id,
        title: id,
        command: id,
        status,
        exitCode: 0,
        durationMs: 1,
        reason: null,
        outputTail: [],
      });
      const merged = mergeReports(
        [
          { environment: { os: 'x' }, steps: [step('lint', 'PASSED'), step('lint', 'FAILED')] },
          { environment: { os: 'x' }, steps: [step('build', 'PASSED')] },
        ],
        {
          externals: { 'docker:build': 'success', 'infra:validate': 'cancelled' },
          expected: ['lint', 'build', 'docker:build', 'infra:validate', 'test:e2e'],
        },
      );
      return (
        merged.steps.map((s) => s.status).join() === 'FAILED,PASSED,PASSED,NOT RUN,NOT RUN' &&
        merged.steps[4].reason.includes('no report')
      );
    },
  );
  await check(
    'arguments: --only/--skip/--external validate step ids; filtered runs do not write the markdown file by default',
    () => {
      let rejected = 0;
      for (const args of [
        ['--only', 'nope'],
        ['--skip', 'x'],
        ['--external', 'bad'],
        ['--step-timeout', '0'],
      ]) {
        try {
          parseArgs(args);
        } catch {
          rejected += 1;
        }
      }
      const ok = parseArgs(['--only', 'lint,build', '--fail-fast']);
      return (
        rejected === 4 &&
        ok.only.join() === 'lint,build' &&
        ok.failFast &&
        writeTarget({ partial: true }, ok) === null &&
        writeTarget({ partial: false }, ok).endsWith('VALIDATION_REPORT.md')
      );
    },
  );
  const passed = results.filter(Boolean).length;
  console.log(`verify self-test: ${passed}/${results.length} passed`);
  return passed === results.length;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) return (await selfTest()) ? EXIT.PASSED : EXIT.FAILED;
  if (options.list) {
    for (const step of STEPS)
      console.log(`${step.id.padEnd(15)} ${step.commands.map((c) => c.join(' ')).join(' && ')}`);
    return EXIT.PASSED;
  }
  if (options.merge) {
    if (!existsSync(options.merge))
      throw new Error(`--merge directory not found: ${options.merge}`);
    const reports = readdirSync(options.merge)
      .filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(readFileSync(join(options.merge, name), 'utf8')));
    return finish(mergeReports(reports, { externals: options.externals }), options);
  }
  const selected = STEPS.filter(
    (step) => (!options.only || options.only.includes(step.id)) && !options.skip.includes(step.id),
  );
  if (selected.length === 0) throw new Error('no steps selected');
  const steps = await runAll(selected, {
    exec: execCommand,
    timeoutMs: options.stepTimeoutMin * 60_000,
    failFast: options.failFast,
  });
  const partial = selected.length !== STEPS.length;
  return finish(
    {
      schemaVersion: 1,
      merged: false,
      partial,
      environment: collectEnvironment(),
      options: { only: options.only, skip: options.skip, failFast: options.failFast },
      steps,
    },
    options,
  );
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`verify: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = EXIT.USAGE;
  },
);
