#!/usr/bin/env node
// Smoke test for a running CaseGuard AI stack (local docker compose or Azure).
//
//   node scripts/smoke-test.mjs --web <url> --api <url> [--auth enforced|dev] [--persona <userId>]
//                               [--timeout <ms>] [--wait <seconds>] [--json] [--self-test]
//
// Without --web/--api (or SMOKE_WEB_URL / SMOKE_API_URL) the local defaults are used. If only one of
// the two is given, only that service is checked. Checks:
//   api: /livez and /readyz are 200, security headers, unknown CORS origins are not allowed, and
//        /api/v1/me without credentials is 401 (no stack trace in the body)
//   web: / is 200 and contains "CaseGuard", security headers, and the same-origin /api proxy reaches the API
// --auth dev (local compose) additionally requires the dev persona header to be accepted.
// --wait polls until the services answer, for cold starts after a deployment.
//
// Exit codes: 0 no check failed (warnings allowed), 1 at least one check failed, 2 usage error.
import { createServer } from 'node:http';

const EXIT = { PASSED: 0, FAILED: 1, USAGE: 2 };
const DEFAULTS = { web: 'http://localhost:3000', api: 'http://localhost:4000' };
const EVIL_ORIGIN = 'https://evil.example.invalid';
const STACK_TRACE = /\n\s+at\s+\S+.*:\d+:\d+|node_modules[\\/]/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function describeError(error) {
  const code = error?.cause?.code ?? error?.code;
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'timeout';
  return `unreachable${code ? ` (${code})` : ''}`;
}

/** One HTTP request; never throws. Returns { status, headers, body } or { error }. */
async function request(url, { headers = {}, timeoutMs, fetchImpl }) {
  try {
    const response = await fetchImpl(url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: response.status, headers: response.headers, body: await response.text() };
  } catch (error) {
    return { error: describeError(error) };
  }
}

function missingHeaders(headers, required) {
  const csp = headers.get('content-security-policy') ?? '';
  return required.filter((name) => {
    if (name === 'x-content-type-options') return !/nosniff/i.test(headers.get(name) ?? '');
    if (name === 'frame-protection')
      return !headers.get('x-frame-options') && !/frame-ancestors/i.test(csp);
    return !headers.get(name);
  });
}

/** Runs every check against the given base URLs and returns result rows (PASS | FAIL | WARN). */
async function runChecks({ web, api, auth, persona, timeoutMs, fetchImpl }) {
  const rows = [];
  const add = (status, name, target, expected, actual) =>
    rows.push({ status, name, target, expected, actual });
  const get = (url, headers = {}) => request(url, { headers, timeoutMs, fetchImpl });
  const verdict = (ok, name, target, expected, actual) =>
    add(ok ? 'PASS' : 'FAIL', name, target, expected, actual);
  const headerChecks = (name, target, response, required, recommended, https) => {
    if (response.error) return;
    const missing = missingHeaders(response.headers, required);
    verdict(
      missing.length === 0,
      `${name} security headers`,
      target,
      required.join(', '),
      missing.length === 0 ? 'present' : `missing: ${missing.join(', ')}`,
    );
    const soft = missingHeaders(response.headers, [
      ...recommended,
      ...(https ? ['strict-transport-security'] : []),
    ]);
    if (soft.length > 0)
      add('WARN', `${name} recommended headers`, target, 'present', `missing: ${soft.join(', ')}`);
  };
  const meChecks = async (name, base) => {
    const url = `${base}/api/v1/me`;
    const anonymous = await get(url);
    if (anonymous.error)
      return verdict(false, `${name} /api/v1/me (no credentials)`, url, '401', anonymous.error);
    if (auth === 'enforced') {
      verdict(
        anonymous.status === 401,
        `${name} /api/v1/me (no credentials)`,
        url,
        '401',
        String(anonymous.status),
      );
    } else if (anonymous.status === 401) {
      verdict(true, `${name} /api/v1/me (no credentials)`, url, '401', '401');
    } else {
      add(
        'WARN',
        `${name} /api/v1/me (no credentials)`,
        url,
        '401',
        `${anonymous.status} (dev personas allow anonymous access?)`,
      );
    }
    if (anonymous.status >= 400) {
      verdict(
        !STACK_TRACE.test(anonymous.body),
        `${name} error body has no stack trace`,
        url,
        'no stack trace',
        STACK_TRACE.test(anonymous.body) ? 'stack trace present' : 'clean',
      );
    }
    if (auth === 'dev') {
      const withPersona = await get(url, { 'x-cg-persona': persona });
      verdict(
        withPersona.status === 200,
        `${name} /api/v1/me (dev persona)`,
        url,
        '200',
        withPersona.error ?? String(withPersona.status),
      );
    }
  };

  if (api) {
    const https = api.startsWith('https:');
    const live = await get(`${api}/livez`);
    verdict(
      live.status === 200,
      'api /livez',
      `${api}/livez`,
      '200',
      live.error ?? String(live.status),
    );
    const ready = await get(`${api}/readyz`);
    verdict(
      ready.status === 200,
      'api /readyz',
      `${api}/readyz`,
      '200',
      ready.error ?? String(ready.status),
    );
    headerChecks(
      'api',
      `${api}/livez`,
      live,
      ['x-content-type-options'],
      ['referrer-policy', 'frame-protection'],
      https,
    );
    const cors = await get(`${api}/livez`, { origin: EVIL_ORIGIN });
    if (!cors.error) {
      const allowed = cors.headers.get('access-control-allow-origin');
      verdict(
        allowed !== '*' && allowed !== EVIL_ORIGIN,
        'api CORS rejects unknown origins',
        `${api}/livez`,
        'no allow-origin for foreign origin',
        allowed ?? 'none',
      );
    }
    await meChecks('api', api);
  }
  if (web) {
    const https = web.startsWith('https:');
    const home = await get(`${web}/`);
    verdict(
      home.status === 200 && home.body.includes('CaseGuard'),
      'web / is 200 and mentions CaseGuard',
      `${web}/`,
      '200 + "CaseGuard"',
      home.error ?? `${home.status}${home.body.includes('CaseGuard') ? '' : ', text missing'}`,
    );
    headerChecks(
      'web',
      `${web}/`,
      home,
      ['content-security-policy', 'x-content-type-options', 'referrer-policy', 'frame-protection'],
      ['permissions-policy'],
      https,
    );
    await meChecks('web proxy', web);
  }
  return rows;
}

/** Polls until `url` answers 200 or the deadline passes. Returns whether it became ready. */
async function waitFor(url, seconds, { timeoutMs, fetchImpl, pollMs = 3000 }) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const response = await request(url, { timeoutMs, fetchImpl });
    if (response.status === 200) return true;
    if (Date.now() + pollMs > deadline) return false;
    await sleep(pollMs);
  }
}

function parseArgs(argv, env = process.env) {
  const options = {
    web: env.SMOKE_WEB_URL ?? null,
    api: env.SMOKE_API_URL ?? null,
    auth: 'enforced',
    persona: 'user_ava_engineer',
    timeoutMs: 10_000,
    waitSeconds: 0,
    json: false,
    selfTest: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      i += 1;
      if (argv[i] === undefined) throw new Error(`${arg} needs a value`);
      return argv[i];
    };
    if (arg === '--web') options.web = value();
    else if (arg === '--api') options.api = value();
    else if (arg === '--auth') options.auth = value();
    else if (arg === '--persona') options.persona = value();
    else if (arg === '--timeout') options.timeoutMs = Number.parseInt(value(), 10);
    else if (arg === '--wait') options.waitSeconds = Number.parseInt(value(), 10);
    else if (arg === '--json') options.json = true;
    else if (arg === '--self-test') options.selfTest = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!['enforced', 'dev'].includes(options.auth))
    throw new Error('--auth must be enforced or dev');
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
    throw new Error('--timeout must be a positive number');
  if (!Number.isFinite(options.waitSeconds) || options.waitSeconds < 0)
    throw new Error('--wait must be >= 0');
  const explicit = options.web !== null || options.api !== null;
  const targets = explicit ? { web: options.web, api: options.api } : DEFAULTS;
  for (const [name, url] of Object.entries(targets)) {
    if (url !== null && !/^https?:\/\//i.test(url))
      throw new Error(`--${name} must be an http(s) URL`);
  }
  return {
    ...options,
    web: targets.web?.replace(/\/+$/, '') ?? null,
    api: targets.api?.replace(/\/+$/, '') ?? null,
  };
}

function printRows(rows) {
  const columns = ['status', 'name', 'target', 'expected', 'actual'];
  const widths = columns.map((column) =>
    Math.max(column.length, ...rows.map((row) => String(row[column]).length)),
  );
  const line = (cells) =>
    `  ${cells.map((cell, i) => String(cell).padEnd(widths[i])).join('  ')}`.trimEnd();
  console.log(line(columns.map((column) => column.toUpperCase())));
  console.log(line(widths.map((width) => '-'.repeat(width))));
  for (const row of rows) console.log(line(columns.map((column) => row[column])));
}

function summarize(rows) {
  const count = (status) => rows.filter((row) => row.status === status).length;
  return { passed: count('PASS'), warnings: count('WARN'), failed: count('FAIL') };
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
  const secure = {
    'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=()',
  };
  const serve = (handler) =>
    new Promise((resolve) => {
      const server = createServer(handler);
      server.listen(0, '127.0.0.1', () =>
        resolve({ server, url: `http://127.0.0.1:${server.address().port}` }),
      );
    });
  const goodApi = (req, res) => {
    if (req.url === '/api/v1/me') {
      const persona = req.headers['x-cg-persona'];
      res.writeHead(persona ? 200 : 401, { ...secure, 'content-type': 'application/json' });
      return res.end(JSON.stringify(persona ? { id: persona } : { error: 'unauthorized' }));
    }
    res.writeHead(200, secure);
    res.end('ok');
  };
  const goodWeb = (req, res) => {
    if (req.url.startsWith('/api/')) return goodApi(req, res);
    res.writeHead(200, { ...secure, 'content-type': 'text/html' });
    res.end('<title>CaseGuard AI</title>');
  };
  const badServer = (req, res) => {
    if (req.url === '/api/v1/me') {
      res.writeHead(500, { 'content-type': 'text/plain' });
      return res.end('Error: boom\n    at handler (C:\\app\\node_modules\\x.js:1:1)');
    }
    res.writeHead(req.url === '/readyz' ? 503 : 200, { 'access-control-allow-origin': '*' });
    res.end('hello');
  };
  const good = await Promise.all([serve(goodApi), serve(goodWeb)]);
  const bad = await serve(badServer);
  const base = {
    auth: 'enforced',
    persona: 'user_ava_engineer',
    timeoutMs: 2000,
    fetchImpl: fetch,
  };
  try {
    await check('a correctly configured stack passes with no failures', async () => {
      const rows = await runChecks({ ...base, api: good[0].url, web: good[1].url });
      return (
        summarize(rows).failed === 0 &&
        rows.some(
          (row) => row.name === 'web / is 200 and mentions CaseGuard' && row.status === 'PASS',
        )
      );
    });
    await check('dev mode requires the persona header to be accepted', async () => {
      const rows = await runChecks({ ...base, auth: 'dev', api: good[0].url, web: null });
      return (
        summarize(rows).failed === 0 &&
        rows.some((row) => row.name === 'api /api/v1/me (dev persona)' && row.status === 'PASS')
      );
    });
    await check(
      'a misconfigured stack fails readiness, headers, CORS, text, auth and stack-trace checks',
      async () => {
        const rows = await runChecks({ ...base, api: bad.url, web: bad.url });
        const failed = rows.filter((row) => row.status === 'FAIL').map((row) => row.name);
        return [
          'api /readyz',
          'api security headers',
          'api CORS rejects unknown origins',
          'api /api/v1/me (no credentials)',
          'api error body has no stack trace',
          'web / is 200 and mentions CaseGuard',
          'web security headers',
        ].every((name) => failed.includes(name));
      },
    );
    await check('an unreachable service fails instead of being skipped', async () => {
      const rows = await runChecks({
        ...base,
        api: 'http://127.0.0.1:1',
        web: null,
        timeoutMs: 500,
      });
      return rows.some(
        (row) =>
          row.name === 'api /livez' &&
          row.status === 'FAIL' &&
          row.actual.startsWith('unreachable'),
      );
    });
    await check('wait returns true once /livez answers and false after the deadline', async () => {
      const ready = await waitFor(`${good[0].url}/livez`, 2, {
        timeoutMs: 500,
        fetchImpl: fetch,
        pollMs: 100,
      });
      const never = await waitFor('http://127.0.0.1:1/livez', 1, {
        timeoutMs: 200,
        fetchImpl: fetch,
        pollMs: 100,
      });
      return ready === true && never === false;
    });
    await check('argument parsing validates URLs and modes', () => {
      const ok = parseArgs(['--api', 'http://x:1/', '--auth', 'dev'], {});
      let rejected = 0;
      for (const args of [
        ['--web', 'ftp://x'],
        ['--auth', 'maybe'],
        ['--timeout', '0'],
      ]) {
        try {
          parseArgs(args, {});
        } catch {
          rejected += 1;
        }
      }
      return (
        ok.api === 'http://x:1' &&
        ok.web === null &&
        rejected === 3 &&
        parseArgs([], {}).web === DEFAULTS.web
      );
    });
  } finally {
    for (const { server } of [...good, bad]) server.close();
  }
  const passed = results.filter(Boolean).length;
  console.log(`smoke-test self-test: ${passed}/${results.length} passed`);
  return passed === results.length;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) return (await selfTest()) ? EXIT.PASSED : EXIT.FAILED;
  const common = { timeoutMs: options.timeoutMs, fetchImpl: fetch };
  if (options.waitSeconds > 0) {
    for (const url of [
      options.api && `${options.api}/livez`,
      options.web && `${options.web}/`,
    ].filter(Boolean)) {
      console.log(`waiting up to ${options.waitSeconds}s for ${url}`);
      if (!(await waitFor(url, options.waitSeconds, common)))
        console.log(`  not ready yet: ${url}`);
    }
  }
  const rows = await runChecks({ ...options, ...common });
  if (options.json) console.log(JSON.stringify({ rows, summary: summarize(rows) }, null, 2));
  else printRows(rows);
  const { passed, warnings, failed } = summarize(rows);
  console.log(
    `\nsmoke-test: ${failed === 0 ? 'PASSED' : 'FAILED'} (${passed} passed, ${warnings} warning(s), ${failed} failed)`,
  );
  return failed === 0 ? EXIT.PASSED : EXIT.FAILED;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`smoke-test: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = EXIT.USAGE;
  },
);
