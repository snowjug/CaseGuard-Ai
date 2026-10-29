#!/usr/bin/env node
// Builds the container images (caseguard-api:local, caseguard-web:local) and validates docker-compose.yml.
//
//   node scripts/docker-build.mjs [--only api|web] [--no-compose] [--no-cache] [--self-test]
//
// `docker compose config` works without a daemon, so it runs on its own (skip with --no-compose). Image
// builds need a reachable daemon: without one this prints "SKIPPED: docker daemon not available" and
// exits 3 (NOT RUN), never 0. The build context is the repository root for both images.
//
// Exit codes: 0 every requested check passed, 1 a check failed, 2 usage error, 3 NOT RUN (no CLI/daemon).
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const EXIT = { PASSED: 0, FAILED: 1, USAGE: 2, NOT_RUN: 3 };
const IMAGES = [
  { key: 'api', dockerfile: 'apps/api/Dockerfile', tag: 'caseguard-api:local' },
  { key: 'web', dockerfile: 'apps/web/Dockerfile', tag: 'caseguard-web:local' },
];

/** Runs the docker CLI (docker.exe on Windows, so no shell is needed). */
function docker(args, { inherit = false, timeout = 60_000 } = {}) {
  const result = spawnSync('docker', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : 'pipe',
    timeout,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
}

function gitCommit() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : 'unknown';
}

/** First line of CLI output with URLs and surrounding noise removed, for one-line reasons. */
function firstLine(text) {
  const line = text.split(/\r?\n/).find((candidate) => candidate.trim() !== '') ?? '';
  return line
    .replace(/https?:\/\/\S+/g, '<url>')
    .trim()
    .slice(0, 160);
}

/**
 * Decides and runs every check with an injected `run` (docker CLI) so the decision logic is testable.
 * Returns { checks, code }; each check is { name, status: PASSED | FAILED | NOT RUN, detail, seconds }.
 */
function execute({ run, commit, options }) {
  const checks = [];
  const add = (name, status, detail, seconds = 0) => checks.push({ name, status, detail, seconds });
  const version = run(['--version']);
  if (version.error || version.status !== 0) {
    add('docker CLI', 'NOT RUN', 'docker CLI not found');
    console.log('SKIPPED: docker CLI not found');
    return { checks, code: EXIT.NOT_RUN };
  }

  if (options.compose) {
    const plugin = run(['compose', 'version']);
    if (plugin.status !== 0) {
      add('compose config', 'NOT RUN', 'docker compose plugin not available');
    } else {
      const started = Date.now();
      const config = run(['compose', 'config', '--quiet']);
      const seconds = (Date.now() - started) / 1000;
      add(
        'compose config',
        config.status === 0 ? 'PASSED' : 'FAILED',
        config.status === 0
          ? 'docker-compose.yml is valid (daemon not required)'
          : firstLine(config.stderr),
        seconds,
      );
    }
  }

  const info = run(['info', '--format', '{{.ServerVersion}}'], { timeout: 30_000 });
  const daemonUp = !info.error && info.status === 0 && info.stdout.trim() !== '';
  if (!daemonUp) {
    const reason =
      firstLine(info.stderr) ||
      (info.error ? String(info.error.code ?? info.error.message) : 'no response');
    console.log(`SKIPPED: docker daemon not available (${reason})`);
    for (const image of IMAGES.filter((item) => !options.only || item.key === options.only)) {
      add(`build ${image.tag}`, 'NOT RUN', 'docker daemon not available');
    }
  } else {
    for (const image of IMAGES.filter((item) => !options.only || item.key === options.only)) {
      const args = [
        'build',
        '-f',
        image.dockerfile,
        '-t',
        image.tag,
        '--build-arg',
        `GIT_COMMIT=${commit}`,
        ...(options.noCache ? ['--no-cache'] : []),
        '.',
      ];
      console.log(`\n== docker ${args.join(' ')} ==`);
      const started = Date.now();
      const result = run(args, { inherit: true, timeout: 30 * 60_000 });
      add(
        `build ${image.tag}`,
        result.status === 0 && !result.error ? 'PASSED' : 'FAILED',
        result.status === 0 && !result.error
          ? 'image built'
          : `docker build exited ${result.status ?? result.error?.code}`,
        (Date.now() - started) / 1000,
      );
    }
  }

  let code = EXIT.PASSED;
  if (checks.some((check) => check.status === 'FAILED')) code = EXIT.FAILED;
  else if (checks.some((check) => check.status === 'NOT RUN')) code = EXIT.NOT_RUN;
  return { checks, code };
}

function parseArgs(argv) {
  const options = { only: null, compose: true, noCache: false, selfTest: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--only') {
      options.only = argv[(i += 1)];
      if (!IMAGES.some((image) => image.key === options.only))
        throw new Error('--only must be api or web');
    } else if (arg === '--no-compose') options.compose = false;
    else if (arg === '--no-cache') options.noCache = true;
    else if (arg === '--self-test') options.selfTest = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function selfTest() {
  const results = [];
  const check = (name, fn) => {
    let ok = false;
    try {
      ok = fn() === true;
    } catch (error) {
      console.error(`  error in "${name}": ${error.message}`);
    }
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  };
  const fake = ({ cli = true, compose = 0, daemon = true, build = 0 }) => {
    const calls = [];
    const run = (args) => {
      calls.push(args.join(' '));
      if (args[0] === '--version')
        return {
          status: cli ? 0 : null,
          stdout: 'Docker',
          stderr: '',
          error: cli ? undefined : new Error('ENOENT'),
        };
      if (args[0] === 'compose' && args[1] === 'version')
        return { status: 0, stdout: 'v2', stderr: '' };
      if (args[0] === 'compose')
        return {
          status: compose,
          stdout: '',
          stderr: compose ? 'yaml: line 3: mapping values are not allowed' : '',
        };
      if (args[0] === 'info')
        return {
          status: daemon ? 0 : 1,
          stdout: daemon ? '29.0.0' : '',
          stderr: daemon ? '' : 'failed to connect to the docker API at npipe:////./pipe/x',
        };
      return { status: build, stdout: '', stderr: '' };
    };
    return { run, calls };
  };
  const options = { only: null, compose: true, noCache: false };
  const quiet = (fn) => {
    const log = console.log;
    console.log = () => {};
    try {
      return fn();
    } finally {
      console.log = log;
    }
  };

  check('no daemon: compose is still validated, builds are NOT RUN, exit code is 3', () => {
    const { run, calls } = fake({ daemon: false });
    const { checks, code } = quiet(() => execute({ run, commit: 'abc', options }));
    return (
      code === EXIT.NOT_RUN &&
      checks[0].status === 'PASSED' &&
      checks.filter((c) => c.status === 'NOT RUN').length === 2 &&
      !calls.some((c) => c.startsWith('build'))
    );
  });
  check('daemon up: both images are built with the contract tags and the commit build-arg', () => {
    const { run, calls } = fake({});
    const { checks, code } = quiet(() => execute({ run, commit: 'abc123', options }));
    const builds = calls.filter((c) => c.startsWith('build'));
    return (
      code === EXIT.PASSED &&
      checks.length === 3 &&
      builds.length === 2 &&
      builds[0].includes('-t caseguard-api:local') &&
      builds[1].includes('-t caseguard-web:local') &&
      builds[0].includes('GIT_COMMIT=abc123')
    );
  });
  check('a failing compose config fails the run even without a daemon', () => {
    const { run } = fake({ compose: 1, daemon: false });
    return quiet(() => execute({ run, commit: 'x', options })).code === EXIT.FAILED;
  });
  check('a failing build fails the run; --only restricts the images', () => {
    const failed = quiet(() => execute({ run: fake({ build: 1 }).run, commit: 'x', options }));
    const only = fake({});
    quiet(() =>
      execute({ run: only.run, commit: 'x', options: { ...options, only: 'web', compose: false } }),
    );
    return (
      failed.code === EXIT.FAILED && only.calls.filter((c) => c.startsWith('build')).length === 1
    );
  });
  check(
    'missing docker CLI is NOT RUN',
    () =>
      quiet(() => execute({ run: fake({ cli: false }).run, commit: 'x', options })).code ===
      EXIT.NOT_RUN,
  );
  const passed = results.filter(Boolean).length;
  console.log(`docker-build self-test: ${passed}/${results.length} passed`);
  return passed === results.length;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) return selfTest() ? EXIT.PASSED : EXIT.FAILED;
  const { checks, code } = execute({ run: docker, commit: gitCommit(), options });
  const width = Math.max(...checks.map((check) => check.name.length));
  console.log('\ndocker-build summary');
  for (const check of checks) {
    const time = check.seconds > 0 ? ` (${check.seconds.toFixed(1)}s)` : '';
    console.log(`  ${check.name.padEnd(width)}  ${check.status.padEnd(8)}  ${check.detail}${time}`);
  }
  if (code === EXIT.NOT_RUN) {
    const reasons = checks
      .filter((check) => check.status === 'NOT RUN')
      .map((check) => `${check.name}: ${check.detail}`);
    console.error(`NOT RUN: ${reasons.join('; ')}`);
  }
  console.log(`docker-build: ${{ 0: 'PASSED', 1: 'FAILED', 3: 'NOT RUN' }[code]}`);
  return code;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`docker-build: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = EXIT.USAGE;
}
