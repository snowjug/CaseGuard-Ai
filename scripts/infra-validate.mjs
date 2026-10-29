#!/usr/bin/env node
// Static validation of the Bicep infrastructure. Nothing is deployed and no Azure API is called.
//
//   node scripts/infra-validate.mjs [--main infra/bicep/main.bicep] [--infra-dir infra] [--strict] [--self-test]
//
// Runs `bicep build` (stdout discarded) and `bicep lint` for main.bicep, `bicep build-params` for every
// *.bicepparam, then scans parameter files for GUID-looking identifiers and secret-looking literals.
// Works with a standalone `bicep` binary or with `az bicep`. --strict also fails on warnings.
//
// Exit codes: 0 passed, 1 failed, 3 NOT RUN (Bicep CLI missing or no main.bicep to validate).
// Callers must report exit code 3 as "not run", never as passed.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const EXIT = { PASSED: 0, FAILED: 1, USAGE: 2, NOT_RUN: 3 };
const GUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const GUID_ONCE = new RegExp(GUID.source, 'i');
const SECRET_KEY =
  /(password|passwd|secret|token|connection ?string|api ?key|access ?key|credential)/i;
const SAFE_EXPRESSION =
  /readEnvironmentVariable\(|getSecret\(|keyVault|secretName|secretVersion|reference\(/i;
const PLACEHOLDER_VALUE = /^(?:<.*>|\$\{.*\}|changeme|placeholder|example|none|null|true|false)$/i;

const quoteArg = (arg) => (/[\s&|<>()^"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg);

/** Runs a command; `az` is a .cmd shim on Windows and only starts through a shell. */
function run(command, args, spawn = spawnSync) {
  const options = { cwd: ROOT, encoding: 'utf8', timeout: 300_000, maxBuffer: 256 * 1024 * 1024 };
  const viaShell = process.platform === 'win32' && command === 'az';
  const result = viaShell
    ? spawn(`az ${args.map(quoteArg).join(' ')}`, { ...options, shell: true })
    : spawn(command, args, options);
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
}

const CLIS = [
  {
    label: 'bicep',
    command: 'bicep',
    versionArgs: ['--version'],
    args: (verb, file, extra = []) => [verb, file, ...extra],
  },
  {
    label: 'az bicep',
    command: 'az',
    versionArgs: ['bicep', 'version'],
    args: (verb, file, extra = []) => ['bicep', verb, '--file', file, ...extra],
  },
];

/** First working Bicep CLI (standalone or via the Azure CLI), or null. */
function detectCli(exec = run) {
  for (const cli of CLIS) {
    const result = exec(cli.command, cli.versionArgs);
    const text = `${result.stdout}\n${result.stderr}`;
    if (!result.error && result.status === 0 && /bicep/i.test(text)) {
      const version = text.split(/\r?\n/).find((line) => /bicep/i.test(line));
      return { ...cli, version: (version ?? cli.label).trim() };
    }
  }
  return null;
}

/** Counts Bicep diagnostics in CLI output and keeps the first few lines for display. */
function summarizeDiagnostics(text) {
  const lines = text
    .split(/\r?\n/)
    .filter((line) => /\b(?:Error|Warning)\s+[A-Za-z0-9-]+\s*:/.test(line));
  return {
    errors: lines.filter((line) => /\bError\s/.test(line)).length,
    warnings: lines.filter((line) => /\bWarning\s/.test(line)).length,
    sample: lines.slice(0, 8),
  };
}

function isPlaceholderGuid(value) {
  const digits = value.replace(/-/g, '').toLowerCase();
  return new Set(digits).size <= 2 || digits === '12345678123412341234123456789012';
}

/** True when `value` looks like a real secret literal rather than a placeholder, id or key vault reference. */
function isSecretLiteral(value, line) {
  return !PLACEHOLDER_VALUE.test(value) && !SAFE_EXPRESSION.test(line) && !GUID_ONCE.test(value);
}

/** Finds GUID-looking identifiers and secret-looking literals in parameter text (values are not returned). */
function scanParameterText(text) {
  const findings = [];
  let pendingSecretKey = -1;
  text.split(/\r?\n/).forEach((line, index) => {
    for (const match of line.matchAll(GUID)) {
      if (!isPlaceholderGuid(match[0])) {
        findings.push({
          line: index + 1,
          rule: 'guid',
          detail: 'GUID-looking identifier (tenant/subscription/object id?)',
        });
        break;
      }
    }
    const trimmed = line.trim();
    if (/^(?:\/\/|#|\/\*|\*)/.test(trimmed)) return;
    // .bicepparam: `param <secret-looking name> = 'literal'`
    const param = /^param\s+(\w+)\s*=\s*'([^']{8,})'/.exec(trimmed);
    let value = param && SECRET_KEY.test(param[1]) ? param[2] : undefined;
    // JSON parameters: a secret-looking key, with the literal on the same line or within two lines
    const jsonKey = /^"([^"]+)"\s*:\s*(?:"([^"]{8,})")?/.exec(trimmed);
    if (jsonKey && SECRET_KEY.test(jsonKey[1])) {
      pendingSecretKey = index;
      value = jsonKey[2];
    } else if (pendingSecretKey !== -1 && index - pendingSecretKey <= 2) {
      value = /^"value"\s*:\s*"([^"]{8,})"/.exec(trimmed)?.[1];
    }
    if (value && isSecretLiteral(value, line)) {
      findings.push({
        line: index + 1,
        rule: 'secret-literal',
        detail: 'literal assigned to a secret-looking parameter',
      });
      pendingSecretKey = -1;
    }
  });
  return findings;
}

/** Recursively lists parameter files under `dir`, skipping dot-directories, node_modules and local overrides. */
function findParameterFiles(dir) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findParameterFiles(full));
    else if (/\.(bicepparam|parameters\.json)$/.test(entry.name) && !/\.local\./.test(entry.name))
      found.push(full);
  }
  return found.sort();
}

function parseArgs(argv) {
  const options = {
    main: resolve(ROOT, 'infra', 'bicep', 'main.bicep'),
    infraDir: resolve(ROOT, 'infra'),
    strict: false,
    selfTest: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      i += 1;
      if (argv[i] === undefined) throw new Error(`${arg} needs a value`);
      return resolve(process.cwd(), argv[i]);
    };
    if (arg === '--main') options.main = value();
    else if (arg === '--infra-dir') options.infraDir = value();
    else if (arg === '--strict') options.strict = true;
    else if (arg === '--self-test') options.selfTest = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

const rel = (file) => relative(ROOT, file).split('\\').join('/');

/** Combines check results: any FAILED wins, then NOT RUN, otherwise passed. */
function exitCodeFor(checks) {
  if (checks.some((check) => check.status === 'FAILED')) return EXIT.FAILED;
  return checks.some((check) => check.status === 'NOT RUN') ? EXIT.NOT_RUN : EXIT.PASSED;
}

function runBicepCheck(cli, name, verb, file, extra, strict, exec = run) {
  const result = exec(cli.command, cli.args(verb, file, extra));
  const diagnostics = summarizeDiagnostics(`${result.stderr}\n${result.stdout}`);
  const failed = result.error || result.status !== 0 || (strict && diagnostics.warnings > 0);
  const detail = result.error
    ? `could not run (${result.error.code ?? result.error.message})`
    : `${diagnostics.errors} error(s), ${diagnostics.warnings} warning(s)`;
  if (failed || diagnostics.warnings > 0) {
    for (const line of diagnostics.sample) console.log(`    ${line.trim()}`);
    if (failed && diagnostics.sample.length === 0 && result.stderr.trim()) {
      console.log(`    ${result.stderr.trim().split(/\r?\n/).slice(0, 5).join('\n    ')}`);
    }
  }
  return { name, status: failed ? 'FAILED' : 'PASSED', detail };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) return selfTest() ? EXIT.PASSED : EXIT.FAILED;

  const checks = [];
  const cli = detectCli();
  if (!cli) {
    checks.push({
      name: 'bicep CLI',
      status: 'NOT RUN',
      detail: 'not found (tried "bicep" and "az bicep"); install it or run "az bicep install"',
    });
  } else {
    checks.push({
      name: 'bicep CLI',
      status: 'PASSED',
      detail: `${cli.version} (via ${cli.label})`,
    });
  }

  if (!existsSync(options.main)) {
    checks.push({
      name: `build ${rel(options.main)}`,
      status: 'NOT RUN',
      detail: 'template not found; nothing to validate',
    });
  } else if (cli) {
    const main = rel(options.main);
    checks.push(runBicepCheck(cli, `build ${main}`, 'build', main, ['--stdout'], options.strict));
    checks.push(runBicepCheck(cli, `lint ${main}`, 'lint', main, [], options.strict));
  } else {
    checks.push({
      name: `build/lint ${rel(options.main)}`,
      status: 'NOT RUN',
      detail: 'Bicep CLI missing',
    });
  }

  const parameterFiles = findParameterFiles(options.infraDir);
  for (const file of parameterFiles.filter((name) => name.endsWith('.bicepparam'))) {
    if (cli)
      checks.push(
        runBicepCheck(
          cli,
          `build-params ${rel(file)}`,
          'build-params',
          rel(file),
          ['--stdout'],
          options.strict,
        ),
      );
    else
      checks.push({
        name: `build-params ${rel(file)}`,
        status: 'NOT RUN',
        detail: 'Bicep CLI missing',
      });
  }

  const scanFindings = parameterFiles.flatMap((file) =>
    scanParameterText(readFileSync(file, 'utf8')).map((finding) => ({
      file: rel(file),
      ...finding,
    })),
  );
  for (const finding of scanFindings)
    console.log(`    ${finding.file}:${finding.line}  [${finding.rule}] ${finding.detail}`);
  checks.push({
    name: `parameter scan (${parameterFiles.length} file(s))`,
    status: scanFindings.length > 0 ? 'FAILED' : 'PASSED',
    detail:
      scanFindings.length > 0
        ? `${scanFindings.length} finding(s); values are not printed`
        : 'no real-looking ids or secret literals',
  });

  const width = Math.max(...checks.map((check) => check.name.length));
  console.log('\ninfra-validate summary');
  for (const check of checks)
    console.log(`  ${check.name.padEnd(width)}  ${check.status.padEnd(8)}  ${check.detail}`);
  const code = exitCodeFor(checks);
  if (code === EXIT.NOT_RUN) {
    const reasons = checks
      .filter((check) => check.status === 'NOT RUN')
      .map((check) => `${check.name}: ${check.detail}`);
    console.error(`NOT RUN: ${reasons.join('; ')}`);
  }
  console.log(`infra-validate: ${{ 0: 'PASSED', 1: 'FAILED', 3: 'NOT RUN' }[code]}`);
  return code;
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
  const realGuid = ['3f2504e0', '4f89', '41d3', '9a0c', '0305e82c3301'].join('-');
  const rules = (text) => scanParameterText(text).map((finding) => finding.rule);

  check(
    'real-looking GUIDs are flagged, placeholders are not',
    () =>
      rules(`param tenantId = '${realGuid}'`).join() === 'guid' &&
      rules("param tenantId = '00000000-0000-0000-0000-000000000000'").length === 0 &&
      rules("param id = '11111111-1111-1111-1111-111111111111'").length === 0,
  );
  check(
    'secret-looking literals are flagged, references and placeholders are not',
    () =>
      rules(['param adminPassword', "'Tr0ub4dor&3-literal'"].join(' = ')).join() ===
        'secret-literal' &&
      rules("param adminPassword = readEnvironmentVariable('ADMIN_PW', '')").length === 0 &&
      rules("param apiKey = '<set at deploy time>'").length === 0,
  );
  check(
    'JSON parameter files: value on the line after the key is checked',
    () =>
      rules('"sqlPassword": {\n  "value": "Sup3r-literal-value"\n}').join() === 'secret-literal' &&
      rules('"location": {\n  "value": "westeurope"\n}').length === 0 &&
      rules('"adminPassword": {\n  "reference": { "secretName": "sql-admin-secret" }\n}').length ===
        0,
  );
  check(
    'comments and non-secret parameters never trigger the secret rule',
    () =>
      rules("// the password comes from the environment\nparam storageSku = 'Standard_LRS'")
        .length === 0 && rules("param postgresAuthMode = 'password'").length === 0,
  );
  check('diagnostics are counted from Bicep output', () => {
    const text = [
      'main.bicep(3,1) : Warning no-unused-params: Parameter "x" is declared but never used.',
      'main.bicep(9,5) : Error BCP035: The specified "object" declaration is missing properties.',
    ].join('\n');
    const summary = summarizeDiagnostics(text);
    return summary.errors === 1 && summary.warnings === 1;
  });
  check(
    'CLI detection prefers bicep, falls back to az bicep, and returns null when neither works',
    () => {
      const missing = {
        status: null,
        stdout: '',
        stderr: '',
        error: Object.assign(new Error('x'), { code: 'ENOENT' }),
      };
      const fine = { status: 0, stdout: 'Bicep CLI version 0.48.1 (abc)', stderr: '' };
      const onlyAz = detectCli((command) => (command === 'az' ? fine : missing));
      const both = detectCli(() => fine);
      return (
        onlyAz?.label === 'az bicep' && both?.label === 'bicep' && detectCli(() => missing) === null
      );
    },
  );
  check(
    'exit code: FAILED outranks NOT RUN, NOT RUN outranks PASSED',
    () =>
      exitCodeFor([{ status: 'PASSED' }, { status: 'NOT RUN' }]) === EXIT.NOT_RUN &&
      exitCodeFor([{ status: 'FAILED' }, { status: 'NOT RUN' }]) === EXIT.FAILED &&
      exitCodeFor([{ status: 'PASSED' }]) === EXIT.PASSED,
  );
  check('strict mode turns warnings into failures; non-strict does not', () => {
    const exec = () => ({
      status: 0,
      stdout: '',
      stderr: 'main.bicep(1,1) : Warning no-unused-vars: x',
      error: undefined,
    });
    const cli = CLIS[0];
    const quiet = console.log;
    console.log = () => {};
    try {
      return (
        runBicepCheck(cli, 'lint', 'lint', 'main.bicep', [], false, exec).status === 'PASSED' &&
        runBicepCheck(cli, 'lint', 'lint', 'main.bicep', [], true, exec).status === 'FAILED'
      );
    } finally {
      console.log = quiet;
    }
  });
  const passed = results.filter(Boolean).length;
  console.log(`infra-validate self-test: ${passed}/${results.length} passed`);
  return passed === results.length;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`infra-validate: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = EXIT.USAGE;
}
