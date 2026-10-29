#!/usr/bin/env node
// Dependency audit: lockfile hygiene plus a known-vulnerability gate.
//
//   node scripts/audit-deps.mjs [--source auto|pnpm|osv] [--include-dev] [--lockfile <file>]
//                               [--exceptions <file> | --allow <file> | --no-exceptions] [--self-test]
//
// 1. Lockfile hygiene: pnpm-lock.yaml (and .npmrc) must not reference a private package feed or a
//    tarball outside registry.npmjs.org. `node scripts/sanitize-lockfile.mjs` repairs the lockfile.
// 2. Vulnerabilities: `pnpm audit --prod --audit-level=high --json` first; when the registry does not
//    offer the audit endpoint, the (name, version) pairs of the production dependency graph from
//    pnpm-lock.yaml are sent to https://api.osv.dev/v1/querybatch instead. HIGH and CRITICAL fail
//    (MAL- advisories count as CRITICAL). Time-boxed exceptions live in docs/dependency-exceptions.json:
//    { "exceptions": [{ "id": "GHSA-...", "package": "name", "justification": "...", "expires": "YYYY-MM-DD" }] }
//
// Exit codes: 0 passed, 1 failed, 2 usage/configuration error, 3 NOT RUN (no audit mechanism could be
// reached, so nothing was verified). Callers must report exit code 3 as "not run", never as passed.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const EXIT = { PASSED: 0, FAILED: 1, USAGE: 2, NOT_RUN: 3 };
const OSV_BATCH_URL = 'https://api.osv.dev/v1/querybatch';
const OSV_VULN_URL = 'https://api.osv.dev/v1/vulns/';
const OSV_BATCH_SIZE = 1000;
const OSV_DETAIL_CONCURRENCY = 8;
const SEVERITY_RANK = { UNKNOWN: 0, LOW: 1, MODERATE: 2, HIGH: 3, CRITICAL: 4 };
const FAIL_RANK = SEVERITY_RANK.HIGH;
const MIN_JUSTIFICATION_LENGTH = 20;
const PRIVATE_FEED = /visualstudio\.com|packagefeedproxy|pkgs\.dev\.azure\.com/i;
const NPM_HOST = 'registry.npmjs.org';

// ---------------------------------------------------------------------------------------------
// Lockfile hygiene

/** Returns problems found in pnpm-lock.yaml text: private feed hosts and non-npmjs tarballs. */
function checkLockfileHygiene(text) {
  const problems = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const feed = PRIVATE_FEED.exec(line);
    if (feed)
      problems.push({ line: index + 1, problem: `private package feed reference (${feed[0]})` });
    for (const match of line.matchAll(/tarball:\s*(https?:\/\/[^\s,}]+)/g)) {
      let host = 'unparseable-url';
      try {
        host = new URL(match[1]).hostname;
      } catch {
        // keep the placeholder host: an unparseable tarball URL is itself a problem
      }
      if (host !== NPM_HOST)
        problems.push({ line: index + 1, problem: `tarball outside ${NPM_HOST} (${host})` });
    }
  });
  return problems;
}

/** Flags registries other than npmjs and committed credentials in an .npmrc file. */
function checkNpmrcHygiene(text) {
  const problems = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) return;
    const registry = /(?:^|:)registry\s*=\s*(\S+)/.exec(line);
    if (registry && !registry[1].includes(NPM_HOST)) {
      problems.push({
        line: index + 1,
        problem: 'registry other than registry.npmjs.org configured',
      });
    }
    if (/_auth(?:Token)?\s*=|_password\s*=/i.test(line)) {
      problems.push({ line: index + 1, problem: 'registry credential in .npmrc' });
    }
  });
  return problems;
}

// ---------------------------------------------------------------------------------------------
// pnpm-lock.yaml (lockfileVersion 9) parsing: production dependency closure

const unquote = (value) => value.replace(/^(['"])(.*)\1$/, '$2');
const DEP_GROUPS = new Set(['dependencies', 'devDependencies', 'optionalDependencies']);

/** Line-based parser for the importers/snapshots sections of a v9 lockfile. */
function parseLockfile(text) {
  const importers = new Map();
  const snapshots = new Map();
  let section = '';
  let importer = null;
  let snapshot = null;
  let group = null;
  let dependency = null;
  for (const raw of text.split(/\r?\n/)) {
    const content = raw.trim();
    if (content === '' || content.startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent === 0) {
      section = content.replace(/:.*$/, '');
      importer = snapshot = group = dependency = null;
    } else if (section === 'importers') {
      if (indent === 2) {
        importer = unquote(content.replace(/:$/, ''));
        importers.set(importer, {
          dependencies: new Map(),
          devDependencies: new Map(),
          optionalDependencies: new Map(),
        });
        group = dependency = null;
      } else if (indent === 4) {
        group = content.replace(/:$/, '');
      } else if (indent === 6 && DEP_GROUPS.has(group ?? '')) {
        dependency = unquote(content.replace(/:$/, ''));
      } else if (indent === 8 && dependency && importer && content.startsWith('version:')) {
        const groups = importers.get(importer);
        groups[group].set(dependency, unquote(content.slice('version:'.length).trim()));
      }
    } else if (section === 'snapshots') {
      if (indent === 2) {
        snapshot = unquote(content.replace(/:\s*(?:\{\})?$/, ''));
        snapshots.set(snapshot, { dependencies: new Map(), optionalDependencies: new Map() });
        group = null;
      } else if (indent === 4) {
        group = content.replace(/:$/, '');
      } else if (
        indent === 6 &&
        snapshot &&
        (group === 'dependencies' || group === 'optionalDependencies')
      ) {
        const entry = /^(['"]?)(.+?)\1:\s*(.+)$/.exec(content);
        if (entry) snapshots.get(snapshot)[group].set(entry[2], unquote(entry[3].trim()));
      }
    }
  }
  return { importers, snapshots };
}

/** Maps a (name, version spec) edge to the snapshot key it points at; null for workspace links. */
function snapshotKey(name, spec) {
  if (/^(?:link|file|workspace):/.test(spec)) return null;
  if (/^\d/.test(spec)) return `${name}@${spec}`;
  // `alias@1.2.3` specs point at another package name; anything else is a plain version/tag.
  return /^(?:@[^/@]+\/)?[^@/()]+@/.test(spec) ? spec : `${name}@${spec}`;
}

/** Splits `name@1.2.3(peer@4)` into { name, version }; null when the version is not semver-like. */
function splitKey(key) {
  const bare = key.replace(/\(.*$/, '');
  const at = bare.lastIndexOf('@');
  if (at <= 0) return null;
  const version = bare.slice(at + 1);
  return /^\d+\.\d+\.\d+/.test(version) ? { name: bare.slice(0, at), version } : null;
}

/** Unique {name, version} pairs reachable from the importers (production only unless includeDev). */
function dependencyClosure(lockfileText, { includeDev = false } = {}) {
  const { importers, snapshots } = parseLockfile(lockfileText);
  const queue = [];
  for (const groups of importers.values()) {
    const wanted = includeDev
      ? ['dependencies', 'devDependencies', 'optionalDependencies']
      : ['dependencies', 'optionalDependencies'];
    for (const group of wanted) {
      for (const [name, spec] of groups[group]) {
        const key = snapshotKey(name, spec);
        if (key) queue.push(key);
      }
    }
  }
  const seen = new Set();
  while (queue.length > 0) {
    const key = queue.pop();
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = snapshots.get(key);
    if (!entry) continue;
    for (const edges of [entry.dependencies, entry.optionalDependencies]) {
      for (const [name, spec] of edges) {
        const next = snapshotKey(name, spec);
        if (next) queue.push(next);
      }
    }
  }
  const pairs = new Map();
  for (const key of seen) {
    const pair = splitKey(key);
    if (pair) pairs.set(`${pair.name}@${pair.version}`, pair);
  }
  return [...pairs.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
}

// ---------------------------------------------------------------------------------------------
// Severity mapping

const CVSS3 = {
  AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
  AC: { L: 0.77, H: 0.44 },
  UI: { N: 0.85, R: 0.62 },
  CIA: { H: 0.56, L: 0.22, N: 0 },
  PR_UNCHANGED: { N: 0.85, L: 0.62, H: 0.27 },
  PR_CHANGED: { N: 0.85, L: 0.68, H: 0.5 },
};

function roundUp1(value) {
  const scaled = Math.round(value * 100000);
  return scaled % 10000 === 0 ? scaled / 100000 : (Math.floor(scaled / 10000) + 1) / 10;
}

/** CVSS v3.x base score from a vector string; null when the vector is malformed. */
function cvss3BaseScore(vector) {
  if (!/^CVSS:3\.[01]\//.test(vector)) return null;
  const metrics = Object.fromEntries(
    vector
      .split('/')
      .slice(1)
      .map((part) => part.split(':')),
  );
  const changed = metrics.S === 'C';
  const av = CVSS3.AV[metrics.AV];
  const ac = CVSS3.AC[metrics.AC];
  const pr = (changed ? CVSS3.PR_CHANGED : CVSS3.PR_UNCHANGED)[metrics.PR];
  const ui = CVSS3.UI[metrics.UI];
  const [c, i, a] = [metrics.C, metrics.I, metrics.A].map((metric) => CVSS3.CIA[metric]);
  if (
    [av, ac, pr, ui, c, i, a].some((value) => value === undefined) ||
    !['U', 'C'].includes(metrics.S)
  )
    return null;
  const iss = 1 - (1 - c) * (1 - i) * (1 - a);
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15 : 6.42 * iss;
  if (impact <= 0) return 0;
  const exploitability = 8.22 * av * ac * pr * ui;
  return roundUp1(
    Math.min(changed ? 1.08 * (impact + exploitability) : impact + exploitability, 10),
  );
}

function severityFromScore(score) {
  if (score >= 9) return 'CRITICAL';
  if (score >= 7) return 'HIGH';
  if (score >= 4) return 'MODERATE';
  return score > 0 ? 'LOW' : 'UNKNOWN';
}

function normalizeSeverity(label) {
  const upper = String(label ?? '').toUpperCase();
  if (upper === 'MEDIUM') return 'MODERATE';
  return upper in SEVERITY_RANK ? upper : 'UNKNOWN';
}

/** Maps an OSV vulnerability record to LOW | MODERATE | HIGH | CRITICAL | UNKNOWN. */
function osvSeverity(detail) {
  if (String(detail.id ?? '').startsWith('MAL-')) return 'CRITICAL'; // known malicious package
  const labelled = normalizeSeverity(detail.database_specific?.severity);
  if (labelled !== 'UNKNOWN') return labelled;
  let best = 'UNKNOWN';
  for (const entry of detail.severity ?? []) {
    const score = typeof entry.score === 'string' ? cvss3BaseScore(entry.score) : null;
    const mapped = score === null ? 'UNKNOWN' : severityFromScore(score);
    if (SEVERITY_RANK[mapped] > SEVERITY_RANK[best]) best = mapped;
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Exceptions

/** Validates docs/dependency-exceptions.json content. Every entry needs id, package, justification, expiry. */
function parseExceptions(text) {
  const entries = [];
  const errors = [];
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { entries, errors: [`not valid JSON (${error.message})`] };
  }
  if (!data || !Array.isArray(data.exceptions))
    return { entries, errors: ['expected { "exceptions": [...] }'] };
  data.exceptions.forEach((item, index) => {
    const where = `exceptions[${index}]`;
    const problems = [];
    for (const field of ['id', 'package']) {
      if (typeof item?.[field] !== 'string' || item[field].trim() === '')
        problems.push(`${field} is required`);
    }
    if (
      typeof item?.justification !== 'string' ||
      item.justification.trim().length < MIN_JUSTIFICATION_LENGTH
    ) {
      problems.push(`justification is required (min ${MIN_JUSTIFICATION_LENGTH} characters)`);
    }
    const expires = item?.expires;
    if (
      typeof expires !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(expires) ||
      Number.isNaN(Date.parse(expires))
    ) {
      problems.push('expires is required as YYYY-MM-DD');
    }
    if (problems.length > 0) errors.push(`${where}: ${problems.join('; ')}`);
    else
      entries.push({
        id: item.id.trim(),
        package: item.package.trim(),
        justification: item.justification,
        expires,
      });
  });
  return { entries, errors };
}

const todayUtc = () => new Date().toISOString().slice(0, 10);

function matchException(entries, vuln, today) {
  const ids = [vuln.id, ...vuln.aliases].map((id) => String(id).toUpperCase());
  return entries.find(
    (entry) =>
      entry.package === vuln.package &&
      ids.includes(entry.id.toUpperCase()) &&
      entry.expires >= today,
  );
}

// ---------------------------------------------------------------------------------------------
// pnpm audit

/** Interprets the result of `pnpm audit --json`; { available: false, reason } when it cannot be trusted. */
function parsePnpmAudit({ stdout = '', status, error }) {
  if (error)
    return { available: false, reason: `pnpm could not be run (${error.code ?? error.message})` };
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  let data = null;
  if (start !== -1 && end > start) {
    try {
      data = JSON.parse(stdout.slice(start, end + 1));
    } catch {
      data = null;
    }
  }
  if (!data) return { available: false, reason: `pnpm audit returned no JSON (exit ${status})` };
  if (data.error) {
    const message = String(data.error.message ?? '')
      .replace(/https?:\/\/\S+/g, '<url>')
      .split('\n')[0];
    return { available: false, reason: `${data.error.code ?? 'audit error'}: ${message}` };
  }
  if (!data.advisories || typeof data.advisories !== 'object') {
    return { available: false, reason: 'pnpm audit output had no advisories section' };
  }
  const vulns = [];
  for (const advisory of Object.values(data.advisories)) {
    const aliases = [
      advisory.github_advisory_id,
      ...(advisory.cves ?? []),
      String(advisory.id ?? ''),
    ].filter(Boolean);
    const versions = [...new Set((advisory.findings ?? []).map((finding) => finding.version))];
    for (const version of versions.length > 0 ? versions : ['?']) {
      vulns.push({
        package: advisory.module_name,
        version,
        id: advisory.github_advisory_id ?? String(advisory.id),
        aliases,
        severity: normalizeSeverity(advisory.severity),
        fixed: advisory.patched_versions ?? 'no fix',
      });
    }
  }
  return { available: true, vulns };
}

function runPnpmAudit(spawn = spawnSync) {
  const options = {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 64 * 1024 * 1024,
  };
  const args = ['audit', '--prod', '--audit-level=high', '--json'];
  // pnpm is a .cmd shim on Windows, which Node can only start through a shell. The arguments are
  // constants, so the command line is built as one string (an args array plus shell is deprecated).
  const result =
    process.platform === 'win32'
      ? spawn(`pnpm.cmd ${args.join(' ')}`, { ...options, shell: true })
      : spawn('pnpm', args, options);
  return parsePnpmAudit(result);
}

// ---------------------------------------------------------------------------------------------
// OSV fallback

class HttpError extends Error {}

async function fetchJson(fetchImpl, url, init, { retries, timeoutMs, sleep }) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (response.ok) return await response.json();
      last = new HttpError(`HTTP ${response.status}`);
      if (response.status !== 429 && response.status < 500) throw last;
    } catch (error) {
      if (error instanceof HttpError && !/HTTP (429|5\d\d)/.test(error.message)) throw error;
      last = error;
    }
    if (attempt < retries) await sleep(500 * 2 ** attempt);
  }
  throw last;
}

/** Looks the packages up on OSV. Throws when the batch query cannot be completed (=> NOT RUN). */
async function auditWithOsv(
  packages,
  {
    fetchImpl = fetch,
    retries = 2,
    timeoutMs = 30_000,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = {},
) {
  const http = { retries, timeoutMs, sleep };
  const affected = new Map();
  for (let offset = 0; offset < packages.length; offset += OSV_BATCH_SIZE) {
    const batch = packages.slice(offset, offset + OSV_BATCH_SIZE);
    const body = JSON.stringify({
      queries: batch.map(({ name, version }) => ({ package: { name, ecosystem: 'npm' }, version })),
    });
    const data = await fetchJson(
      fetchImpl,
      OSV_BATCH_URL,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body },
      http,
    );
    if (!Array.isArray(data?.results) || data.results.length !== batch.length) {
      throw new Error('unexpected OSV querybatch response shape');
    }
    data.results.forEach((result, index) => {
      for (const vuln of result?.vulns ?? []) {
        const list = affected.get(vuln.id) ?? [];
        list.push(batch[index]);
        affected.set(vuln.id, list);
      }
    });
  }

  const details = new Map();
  const failed = [];
  const ids = [...affected.keys()];
  let next = 0;
  async function worker() {
    while (next < ids.length) {
      const id = ids[next++];
      try {
        details.set(
          id,
          await fetchJson(fetchImpl, `${OSV_VULN_URL}${encodeURIComponent(id)}`, {}, http),
        );
      } catch {
        failed.push(id);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(OSV_DETAIL_CONCURRENCY, ids.length) }, worker));

  const vulns = [];
  for (const [id, detail] of details) {
    for (const pkg of affected.get(id) ?? []) {
      const fixes = (detail.affected ?? [])
        .filter((entry) => entry.package?.name === pkg.name)
        .flatMap((entry) => entry.ranges ?? [])
        .flatMap((range) => range.events ?? [])
        .map((event) => event.fixed)
        .filter(Boolean);
      vulns.push({
        package: pkg.name,
        version: pkg.version,
        id,
        aliases: detail.aliases ?? [],
        severity: osvSeverity(detail),
        fixed: fixes.length > 0 ? [...new Set(fixes)].join(', ') : 'no fix listed',
      });
    }
  }
  return { vulns, failed };
}

// ---------------------------------------------------------------------------------------------
// Orchestration

/**
 * Runs the vulnerability audit with the configured sources and applies exceptions.
 * status: passed | failed | not-run.
 */
async function runVulnerabilityAudit({
  source,
  lockfileText,
  includeDev,
  exceptions,
  today,
  pnpmAudit,
  osv,
}) {
  const notes = [];
  let vulns = null;
  let used = '';
  let incomplete = [];
  if (source !== 'osv') {
    const result = pnpmAudit();
    if (result.available) {
      vulns = result.vulns;
      used = 'pnpm audit --prod';
    } else {
      notes.push(`pnpm audit unavailable: ${result.reason}`);
    }
  }
  if (vulns === null && source !== 'pnpm') {
    const packages = dependencyClosure(lockfileText, { includeDev });
    try {
      const result = await auditWithOsv(packages, osv);
      vulns = result.vulns;
      incomplete = result.failed;
      used = `OSV querybatch (${packages.length} ${includeDev ? 'all' : 'production'} packages)`;
    } catch (error) {
      notes.push(`OSV unavailable: ${error.message}`);
    }
  }
  if (vulns === null)
    return {
      status: 'not-run',
      notes,
      used,
      vulns: [],
      blocking: [],
      allowed: [],
      unusedExceptions: [],
      lowerCount: 0,
      incomplete,
    };

  const blocking = [];
  const allowed = [];
  let lowerCount = 0;
  const usedExceptions = new Set();
  for (const vuln of vulns) {
    if (SEVERITY_RANK[vuln.severity] < FAIL_RANK) {
      lowerCount += 1;
      continue;
    }
    const exception = matchException(exceptions, vuln, today);
    if (exception) {
      usedExceptions.add(exception);
      allowed.push({ ...vuln, exception });
    } else {
      blocking.push(vuln);
    }
  }
  const unusedExceptions = exceptions.filter((entry) => !usedExceptions.has(entry));
  const expired = exceptions.filter((entry) => entry.expires < today);
  for (const entry of expired)
    notes.push(
      `exception ${entry.id} for ${entry.package} expired on ${entry.expires} and is ignored`,
    );
  let status = 'passed';
  if (blocking.length > 0) status = 'failed';
  else if (incomplete.length > 0) {
    status = 'not-run';
    notes.push(`advisory details could not be retrieved for: ${incomplete.join(', ')}`);
  }
  return {
    status,
    notes,
    used,
    vulns,
    blocking,
    allowed,
    unusedExceptions,
    lowerCount,
    incomplete,
  };
}

function table(rows, headers) {
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => String(row[i]).length)),
  );
  const line = (cells) =>
    `  ${cells.map((cell, i) => String(cell).padEnd(widths[i])).join('  ')}`.trimEnd();
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

function printVulnerabilityReport(result) {
  if (result.status === 'not-run' && result.vulns.length === 0 && result.used === '') {
    console.error(
      `NOT RUN: vulnerability audit could not be performed. ${result.notes.join('; ')}`,
    );
    return;
  }
  console.log(`Vulnerability source: ${result.used}`);
  for (const note of result.notes) console.log(`  note: ${note}`);
  const rows = [
    ...result.blocking.map((v) => [v.package, v.version, v.id, v.severity, v.fixed, 'FAIL']),
    ...result.allowed.map((v) => [
      v.package,
      v.version,
      v.id,
      v.severity,
      v.fixed,
      `allowed until ${v.exception.expires}`,
    ]),
  ];
  if (rows.length > 0)
    console.log(table(rows, ['Package', 'Version', 'Advisory', 'Severity', 'Fixed in', 'Status']));
  console.log(
    `  HIGH/CRITICAL blocking: ${result.blocking.length}, allowed by exception: ${result.allowed.length}, lower severity (not gated): ${result.lowerCount}`,
  );
  for (const entry of result.unusedExceptions) {
    console.log(`  note: exception ${entry.id} (${entry.package}) matched nothing; remove it`);
  }
  if (result.status === 'not-run') {
    console.error(`NOT RUN: audit incomplete. ${result.notes.join('; ')}`);
  }
}

function parseArgs(argv) {
  const options = {
    source: 'auto',
    includeDev: false,
    lockfile: resolve(ROOT, 'pnpm-lock.yaml'),
    exceptions: resolve(ROOT, 'docs', 'dependency-exceptions.json'),
    useExceptions: true,
    selfTest: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      i += 1;
      if (argv[i] === undefined) throw new Error(`${arg} needs a value`);
      return argv[i];
    };
    if (arg === '--source') options.source = value();
    else if (arg === '--include-dev') options.includeDev = true;
    else if (arg === '--lockfile') options.lockfile = resolve(process.cwd(), value());
    else if (arg === '--exceptions' || arg === '--allow')
      options.exceptions = resolve(process.cwd(), value());
    else if (arg === '--no-exceptions') options.useExceptions = false;
    else if (arg === '--self-test') options.selfTest = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!['auto', 'pnpm', 'osv'].includes(options.source))
    throw new Error('--source must be auto, pnpm or osv');
  return options;
}

/** Exit code for the combined hygiene + vulnerability outcome. A failure always outranks NOT RUN. */
function exitCodeFor(hygieneProblemCount, status) {
  if (hygieneProblemCount > 0 || status === 'failed') return EXIT.FAILED;
  return status === 'not-run' ? EXIT.NOT_RUN : EXIT.PASSED;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) return (await runSelfTests()) ? 0 : 1;

  console.log('== Lockfile hygiene ==');
  if (!existsSync(options.lockfile)) {
    console.error(`FAILED: ${options.lockfile} not found`);
    return EXIT.FAILED;
  }
  const lockfileText = readFileSync(options.lockfile, 'utf8');
  const npmrcPath = resolve(ROOT, '.npmrc');
  const problems = [
    ...checkLockfileHygiene(lockfileText).map((p) => ({ file: 'pnpm-lock.yaml', ...p })),
    ...(existsSync(npmrcPath)
      ? checkNpmrcHygiene(readFileSync(npmrcPath, 'utf8')).map((p) => ({ file: '.npmrc', ...p }))
      : []),
  ];
  for (const { file, line, problem } of problems.slice(0, 20))
    console.error(`  ${file}:${line}  ${problem}`);
  if (problems.length > 20) console.error(`  ... and ${problems.length - 20} more`);
  console.log(
    problems.length === 0
      ? 'PASSED: no private feed URLs or foreign tarballs'
      : `FAILED: ${problems.length} problem(s); run node scripts/sanitize-lockfile.mjs`,
  );

  let exceptions = [];
  if (options.useExceptions && existsSync(options.exceptions)) {
    const parsed = parseExceptions(readFileSync(options.exceptions, 'utf8'));
    if (parsed.errors.length > 0) {
      console.error(`Invalid exceptions file ${options.exceptions}:`);
      for (const error of parsed.errors) console.error(`  ${error}`);
      return EXIT.USAGE;
    }
    exceptions = parsed.entries;
  }

  console.log('\n== Known vulnerabilities (production dependencies, fail on HIGH/CRITICAL) ==');
  const result = await runVulnerabilityAudit({
    source: options.source,
    lockfileText,
    includeDev: options.includeDev,
    exceptions,
    today: todayUtc(),
    pnpmAudit: runPnpmAudit,
    osv: {},
  });
  printVulnerabilityReport(result);
  const code = exitCodeFor(problems.length, result.status);
  const label = { 0: 'PASSED', 1: 'FAILED', 3: 'NOT RUN' }[code];
  console.log(`\naudit-deps: ${label}`);
  return code;
}

// ---------------------------------------------------------------------------------------------
// Self-tests (mocked fetch and pnpm; no network)

const LOCK_FIXTURE = `lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      vitest:
        specifier: ^4.0.0
        version: 4.0.1(vite@7.0.0)

  apps/api:
    dependencies:
      '@caseguard/schemas':
        specifier: workspace:*
        version: link:../../packages/schemas
      fastify:
        specifier: ^5.0.0
        version: 5.1.0
      cjs-alias:
        specifier: npm:string-width@^4.2.3
        version: string-width@4.2.3

packages:

  fastify@5.1.0:
    resolution: {integrity: sha512-aaa}

snapshots:

  fastify@5.1.0:
    dependencies:
      pino: 9.0.0
    optionalDependencies:
      fsevents: 2.3.3

  pino@9.0.0: {}

  fsevents@2.3.3:
    optional: true

  string-width@4.2.3:
    dependencies:
      is-fullwidth-code-point: 3.0.0

  is-fullwidth-code-point@3.0.0: {}

  vitest@4.0.1(vite@7.0.0):
    dependencies:
      dev-only-helper: 1.0.0

  dev-only-helper@1.0.0: {}
`;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Mock OSV: `vulnsByPackage` maps "name@version" to vuln ids; `details` maps id to the OSV record. */
function mockOsv({ vulnsByPackage = {}, details = {}, failBatch = false, failDetail = [] }) {
  const calls = { batch: [], details: [] };
  const fetchImpl = async (url, init) => {
    if (url === OSV_BATCH_URL) {
      if (failBatch) throw new Error('getaddrinfo ENOTFOUND api.osv.dev');
      const queries = JSON.parse(init.body).queries;
      calls.batch.push(queries);
      return jsonResponse({
        results: queries.map((q) => ({
          vulns: (vulnsByPackage[`${q.package.name}@${q.version}`] ?? []).map((id) => ({ id })),
        })),
      });
    }
    const id = decodeURIComponent(url.slice(OSV_VULN_URL.length));
    calls.details.push(id);
    if (failDetail.includes(id)) return jsonResponse({ error: 'boom' }, 500);
    return jsonResponse(details[id] ?? { id });
  };
  return { fetchImpl, calls };
}

const noSleep = () => Promise.resolve();
const highDetail = (id, pkg) => ({
  id,
  aliases: [`CVE-${id.slice(-4)}`],
  database_specific: { severity: 'HIGH' },
  affected: [
    { package: { name: pkg }, ranges: [{ events: [{ introduced: '0' }, { fixed: '9.9.9' }] }] },
  ],
});

async function runSelfTests() {
  const failures = [];
  let total = 0;
  const check = async (name, run) => {
    let ok = false;
    total += 1;
    try {
      ok = (await run()) === true;
    } catch (error) {
      console.error(`  error in "${name}": ${error.message}`);
    }
    if (!ok) failures.push(name);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  };
  const run = (overrides) =>
    runVulnerabilityAudit({
      source: 'auto',
      lockfileText: LOCK_FIXTURE,
      includeDev: false,
      exceptions: [],
      today: '2026-10-29',
      pnpmAudit: () => ({ available: false, reason: 'endpoint not supported' }),
      osv: { retries: 0, sleep: noSleep },
      ...overrides,
    });

  await check('hygiene flags private feeds and foreign tarballs, accepts a clean lockfile', () => {
    const bad = [
      'resolution: {integrity: sha512-x, tarball: https://pkgs.dev.azure.com/o/_packaging/f/npm/registry/a.tgz}',
      'resolution: {tarball: https://example.org/a.tgz}',
      'x: contoso.pkgs.visualstudio.com',
    ].join('\n');
    const good =
      'resolution: {integrity: sha512-x}\nresolution: {tarball: https://registry.npmjs.org/a/-/a-1.0.0.tgz}';
    return checkLockfileHygiene(bad).length >= 3 && checkLockfileHygiene(good).length === 0;
  });
  await check('npmrc hygiene flags foreign registries and credentials only', () => {
    const bad = checkNpmrcHygiene(
      'registry=https://feed.example.org/npm/\n//feed.example.org/:_authToken=abc\n',
    );
    return (
      bad.length === 2 &&
      checkNpmrcHygiene(
        '# registry=https://x\nauto-install-peers=true\nregistry=https://registry.npmjs.org/\n',
      ).length === 0
    );
  });
  await check(
    'closure follows prod edges, skips dev-only and workspace links, resolves aliases',
    () => {
      const names = dependencyClosure(LOCK_FIXTURE).map((p) => `${p.name}@${p.version}`);
      const all = dependencyClosure(LOCK_FIXTURE, { includeDev: true }).map((p) => p.name);
      return (
        names.join() ===
          'fastify@5.1.0,fsevents@2.3.3,is-fullwidth-code-point@3.0.0,pino@9.0.0,string-width@4.2.3' &&
        all.includes('vitest') &&
        all.includes('dev-only-helper')
      );
    },
  );
  await check(
    'CVSS v3 base scores match the specification examples',
    () =>
      cvss3BaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H') === 9.8 &&
      cvss3BaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N') === 5.3 &&
      cvss3BaseScore('CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:L/I:N/A:N') === 3.3 &&
      cvss3BaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N') === 6.1 &&
      cvss3BaseScore('CVSS:4.0/AV:N') === null,
  );
  await check(
    'severity: label wins, CVSS is the fallback, MAL- is critical, nothing is UNKNOWN',
    () =>
      osvSeverity({ id: 'GHSA-x', database_specific: { severity: 'MODERATE' } }) === 'MODERATE' &&
      osvSeverity({
        id: 'CVE-1',
        severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }],
      }) === 'CRITICAL' &&
      osvSeverity({ id: 'MAL-2026-1' }) === 'CRITICAL' &&
      osvSeverity({ id: 'X-1' }) === 'UNKNOWN',
  );
  await check('exceptions need id, package, justification and a valid expiry', () => {
    const good = JSON.stringify({
      exceptions: [
        {
          id: 'GHSA-aaaa',
          package: 'p',
          justification: 'not reachable: only the auth-code flow is affected',
          expires: '2027-01-31',
        },
      ],
    });
    const bad = JSON.stringify({
      exceptions: [
        { id: 'GHSA-aaaa', package: 'p', justification: 'short', expires: '2027-13-45' },
        { package: 'q' },
      ],
    });
    return (
      parseExceptions(good).errors.length === 0 &&
      parseExceptions(bad).errors.length === 2 &&
      parseExceptions('{').errors.length === 1
    );
  });
  await check(
    'OSV: HIGH advisory in a production package fails; only production packages are queried',
    async () => {
      const { fetchImpl, calls } = mockOsv({
        vulnsByPackage: { 'pino@9.0.0': ['GHSA-1111'] },
        details: { 'GHSA-1111': highDetail('GHSA-1111', 'pino') },
      });
      const result = await run({ osv: { fetchImpl, retries: 0, sleep: noSleep } });
      const queried = calls.batch[0].map((q) => q.package.name);
      return (
        result.status === 'failed' &&
        result.blocking[0].fixed === '9.9.9' &&
        !queried.includes('vitest') &&
        calls.batch[0][0].package.ecosystem === 'npm' &&
        queried.length === 5
      );
    },
  );
  await check('OSV: MODERATE advisories and dev-only packages do not fail', async () => {
    const { fetchImpl } = mockOsv({
      vulnsByPackage: { 'pino@9.0.0': ['GHSA-2222'] },
      details: { 'GHSA-2222': { id: 'GHSA-2222', database_specific: { severity: 'MODERATE' } } },
    });
    const result = await run({ osv: { fetchImpl, retries: 0, sleep: noSleep } });
    return result.status === 'passed' && result.lowerCount === 1;
  });
  await check(
    'exception allows a HIGH advisory; an expired one does not; unused ones are reported',
    async () => {
      const { fetchImpl } = mockOsv({
        vulnsByPackage: { 'pino@9.0.0': ['GHSA-1111'] },
        details: { 'GHSA-1111': highDetail('GHSA-1111', 'pino') },
      });
      const entry = {
        id: 'ghsa-1111',
        package: 'pino',
        justification: 'not reachable from any request path',
        expires: '2026-12-31',
      };
      const stale = { ...entry, expires: '2026-01-01' };
      const unused = {
        id: 'GHSA-9999',
        package: 'zod',
        justification: 'documented risk acceptance, see ticket',
        expires: '2026-12-31',
      };
      const osv = { fetchImpl, retries: 0, sleep: noSleep };
      const allowed = await run({ osv, exceptions: [entry, unused] });
      const expired = await run({ osv, exceptions: [stale] });
      return (
        allowed.status === 'passed' &&
        allowed.allowed.length === 1 &&
        allowed.unusedExceptions.length === 1 &&
        expired.status === 'failed' &&
        expired.notes.some((n) => n.includes('expired'))
      );
    },
  );
  await check('NOT RUN when neither pnpm audit nor OSV is reachable (exit code 3)', async () => {
    const { fetchImpl } = mockOsv({ failBatch: true });
    const result = await run({ osv: { fetchImpl, retries: 0, sleep: noSleep } });
    return (
      result.status === 'not-run' &&
      exitCodeFor(0, result.status) === EXIT.NOT_RUN &&
      exitCodeFor(1, result.status) === EXIT.FAILED
    );
  });
  await check(
    'NOT RUN when advisory details cannot be fetched and nothing blocking is known',
    async () => {
      const { fetchImpl } = mockOsv({
        vulnsByPackage: { 'pino@9.0.0': ['GHSA-3333'] },
        failDetail: ['GHSA-3333'],
      });
      const result = await run({ osv: { fetchImpl, retries: 0, sleep: noSleep } });
      return result.status === 'not-run' && result.incomplete.join() === 'GHSA-3333';
    },
  );
  await check(
    'pnpm audit output is parsed; endpoint errors and non-JSON fall back to OSV',
    async () => {
      const ok = parsePnpmAudit({
        status: 1,
        stdout: JSON.stringify({
          advisories: {
            1: {
              id: 1,
              module_name: 'pino',
              severity: 'high',
              github_advisory_id: 'GHSA-1111',
              cves: ['CVE-2026-1'],
              patched_versions: '>=9.9.9',
              findings: [{ version: '9.0.0', paths: [] }],
            },
          },
          metadata: {},
        }),
      });
      const broken = parsePnpmAudit({
        status: 1,
        stdout: JSON.stringify({
          error: {
            code: 'ERR_PNPM_AUDIT_BAD_RESPONSE',
            message: 'responded with 404: https://feed.example.org/audits',
          },
        }),
      });
      const garbage = parsePnpmAudit({ status: 0, stdout: 'not json' });
      const { fetchImpl, calls } = mockOsv({});
      const viaOsv = await run({ osv: { fetchImpl, retries: 0, sleep: noSleep } });
      const viaPnpm = await run({
        pnpmAudit: () => ok,
        osv: { fetchImpl, retries: 0, sleep: noSleep },
      });
      return (
        ok.available &&
        ok.vulns[0].severity === 'HIGH' &&
        ok.vulns[0].aliases.includes('CVE-2026-1') &&
        !broken.available &&
        !broken.reason.includes('https://') &&
        !garbage.available &&
        viaOsv.status === 'passed' &&
        viaOsv.used.startsWith('OSV') &&
        viaPnpm.status === 'failed' &&
        viaPnpm.used.startsWith('pnpm') &&
        calls.batch.length === 1
      );
    },
  );
  await check('--source flag values are validated', () => {
    let rejected = false;
    try {
      parseArgs(['--source', 'nope']);
    } catch {
      rejected = true;
    }
    return rejected && parseArgs(['--allow', 'x.json']).exceptions.endsWith('x.json');
  });

  console.log(`audit-deps self-test: ${total - failures.length}/${total} passed`);
  return failures.length === 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`audit-deps: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = EXIT.USAGE;
  },
);
