#!/usr/bin/env node
// Dependency-free secret scanner used by the pre-commit hook, `pnpm secrets:scan` and CI (NFR-SEC-06).
//
// Scans `git ls-files -co --exclude-standard` (or the staged blobs with --staged) for secret-shaped
// content and exits non-zero on findings. It NEVER prints a matched value: only file:line and rule id.
//
// Allow-listing; every entry must carry a justification:
//   - `.secretscanignore`: `<path-glob> [rules=a,b]  # <reason>`
//   - per line: an `allow` marker comment on the same line, or an `allow-next-line` marker on the
//     previous line, followed by the reason (see CONTRIBUTING.md for the exact spelling).
//
// Exit codes: 0 clean, 1 findings, 2 usage/configuration error.
// `node scripts/scan-secrets.mjs --self-test` runs the built-in test-suite.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const IGNORE_FILE = '.secretscanignore';
const MAX_FILE_BYTES = 1024 * 1024;
const MIN_REASON_LENGTH = 8;
const MAX_PRINTED_FINDINGS = 200;

const words = (text) => text.split(/\s+/).filter(Boolean);
const BINARY_EXTENSIONS = new Set(
  words(
    '.png .jpg .jpeg .gif .ico .webp .avif .bmp .woff .woff2 .ttf .otf .eot .pdf .zip .gz .tgz ' +
      '.tar .7z .mp3 .mp4 .mov .webm .wav .wasm .data .bin',
  ),
);
const CONFIG_LIKE_EXTENSIONS = new Set(
  words('.yml .yaml .ini .cfg .conf .properties .toml .bicepparam .env'),
);
const SKIPPED_DIRECTORIES = new Set(
  words(
    '.git node_modules .next dist build coverage .data playwright-report test-results .pnpm-store',
  ),
);

/** Substrings that mark a value as documentation or a stand-in rather than a live credential. */
const PLACEHOLDER_WORDS = words(
  'example changeme change-me change_me placeholder dummy sample fake redacted your- your_ ' +
    'yourkey insert replace xxxx **** .... test mock dev-only dev_only devonly password secret ' +
    'token localhost process.env getenv keyvault secretref not-a-real',
);

/** Shannon entropy in bits per character. */
function shannonEntropy(text) {
  if (text.length === 0) return 0;
  const counts = new Map();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  const total = [...text].length;
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / total;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** True for values that are obviously documentation, templating or variable references. */
function isPlaceholder(value) {
  const lower = value.toLowerCase();
  if (/[<>]/.test(value) || value.includes('${') || value.includes('$(') || value.includes('{{')) {
    return true;
  }
  if (value.startsWith('$') || value.startsWith('%') || /^\*+$/.test(value)) return true;
  if (/^(.)\1+$/.test(value) || /x{4,}/i.test(value) || /\*{3,}/.test(value)) return true;
  if (/^[0-9a-f-]+$/i.test(value) && new Set(value.replace(/-/g, '')).size <= 2) return true;
  return PLACEHOLDER_WORDS.some((word) => lower.includes(word));
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Identifiers, URLs, file paths and versions assigned to secret-named keys are not secrets. */
function looksLikeIdentifierOrPath(value) {
  if (GUID.test(value)) return true;
  if (value.includes('://') || /^(?:\.{0,2}\/|~\/|@[\w.-]+\/)/.test(value)) return true;
  if (/\.(?:ts|tsx|js|mjs|json|md|ya?ml|sql|pem|txt)$/i.test(value)) return true;
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(value)) return true;
  if (/^[a-z]+(?:[A-Z][a-z]+)+$/.test(value)) return true;
  return /^[a-z]+(?:[-_.][a-z]+)+$/.test(value);
}

function isConfigLike(file) {
  const base = basename(file).toLowerCase();
  return base.startsWith('.env') || CONFIG_LIKE_EXTENSIONS.has(extname(base));
}

function isPlaceholderGuid(value) {
  const digits = value.replace(/-/g, '').toLowerCase();
  const zeros = digits.split('0').length - 1;
  return new Set(digits).size <= 2 || zeros >= 20 || digits === '12345678123412341234123456789012';
}

/** A value that stops right before `${` or `{` is a template, not a literal credential. */
function isTemplated(line, matchEnd) {
  return line[matchEnd] === '$' || line[matchEnd] === '{';
}

/**
 * Secret detection rules. `validate` receives the regex groups and may reject a candidate match
 * (placeholders, low entropy) so that rules stay precise enough to run as a blocking gate.
 */
const RULES = [
  {
    id: 'private-key',
    description: 'private key block',
    regex: /-----BEGIN (?:(?:RSA|DSA|EC|OPENSSH|ENCRYPTED|PGP) )?PRIVATE KEY(?: BLOCK)?-----/g,
  },
  {
    id: 'aws-access-key-id',
    description: 'AWS access key id',
    regex: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[A-Z0-9]{16}\b/g,
  },
  {
    id: 'aws-secret-access-key',
    description: 'AWS secret access key assignment',
    regex: /aws_?secret_?access_?key["']?\s*[:=]\s*["']?(?<value>[A-Za-z0-9/+=]{40})\b/gi,
    validate: ({ groups }) => !isPlaceholder(groups.value) && shannonEntropy(groups.value) >= 3.5,
  },
  {
    id: 'github-token',
    description: 'GitHub token',
    regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g,
  },
  {
    id: 'slack-token',
    description: 'Slack token',
    regex: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  },
  {
    id: 'slack-webhook',
    description: 'Slack incoming webhook URL',
    regex: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/g,
  },
  {
    id: 'stripe-secret-key',
    description: 'Stripe live secret key',
    regex: /\b[sr]k_live_[A-Za-z0-9]{20,}\b/g,
  },
  {
    id: 'google-api-key',
    description: 'Google API key',
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    id: 'npm-token',
    description: 'npm access token',
    regex: /\bnpm_[A-Za-z0-9]{36}\b/g,
  },
  {
    id: 'npmrc-auth-token',
    description: 'registry auth token in an npmrc-style file',
    regex: /_auth(?:Token)?\s*=\s*(?<value>[^\s$][^\s]{7,})/g,
    validate: ({ groups }) => !isPlaceholder(groups.value),
  },
  {
    id: 'azure-storage-account-key',
    description: 'Azure storage account key',
    regex: /AccountKey=(?<value>[A-Za-z0-9+/]{40,}={0,2})/g,
    validate: ({ groups }) => shannonEntropy(groups.value) >= 3.5,
  },
  {
    id: 'azure-shared-access-key',
    description: 'Azure shared access key or signature in a connection string',
    regex: /\b(?:SharedAccessKey|SharedAccessSignature)=(?<value>[^;\s"'<>${}]{8,})/gi,
    validate: ({ groups, line, matchEnd }) =>
      !isTemplated(line, matchEnd) &&
      !isPlaceholder(groups.value) &&
      shannonEntropy(groups.value) >= 3,
  },
  {
    id: 'azure-sas-token',
    description: 'Azure SAS token in a URL',
    regex: /[?&]sig=(?<value>[A-Za-z0-9%+/=]{20,})/g,
    validate: ({ line, groups }) =>
      /[?&](?:sv|se|sp|sr)=/.test(line) && shannonEntropy(groups.value) >= 3.5,
  },
  {
    id: 'azure-ad-client-secret',
    description: 'Microsoft Entra application client secret',
    regex: /\b[A-Za-z0-9_~.-]{3}\dQ~[A-Za-z0-9_~.-]{31,34}\b/g,
  },
  {
    id: 'appinsights-instrumentation-key',
    description: 'Application Insights connection string with a real-looking key',
    regex:
      /InstrumentationKey=(?<value>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi,
    validate: ({ groups }) => !isPlaceholderGuid(groups.value),
  },
  {
    id: 'jwt',
    description: 'JSON Web Token',
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    id: 'credential-in-url',
    description: 'password embedded in a connection URL',
    regex: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/'"<>]+:(?<value>[^\s@/'"<>]{8,})@[A-Za-z0-9_.-]+/gi,
    // `[REDACTED:...]` is the output of a redactor, not a credential.
    validate: ({ groups, match }) =>
      !/REDACTED/i.test(match) &&
      !/[[\]]/.test(groups.value) &&
      !isPlaceholder(groups.value) &&
      shannonEntropy(groups.value) >= 3,
  },
  {
    id: 'generic-secret-assignment',
    description: 'high-entropy value assigned to a secret-like name',
    regex:
      /(?:secret|passw(?:or)?d|passwd|pwd|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|auth[_-]?key|credential)[A-Za-z0-9_.-]{0,40}["']?\s*(?::=|=>|[:=])\s*(?<quote>["'`]?)(?<value>[^\s"'`]{12,})/gi,
    validate: ({ groups, line, matchEnd, file }) => {
      const quote = groups.quote;
      const quoted = quote !== '' && line[matchEnd] === quote;
      if (quote !== '' && !quoted) return false;
      if (!quoted && !isConfigLike(file)) return false;
      const value = groups.value;
      if (isPlaceholder(value) || looksLikeIdentifierOrPath(value)) return false;
      if (!/\d/.test(value) || !/[A-Za-z]/.test(value)) return false;
      return value.length >= (quoted ? 16 : 24) && shannonEntropy(value) >= (quoted ? 3.5 : 4);
    },
  },
];

const FILE_RULES = [
  { id: 'env-file-committed', description: 'environment file that is not an *.example template' },
  { id: 'key-file-committed', description: 'private key / keystore file' },
  { id: 'allow-without-reason', description: 'allow marker without a justification' },
];
const KNOWN_RULE_IDS = new Set([...RULES, ...FILE_RULES].map((rule) => rule.id));

const MARKER = new RegExp('secretscan' + ':allow(-next-line)?([^\\r\\n]*)');

/** Parses an inline allow marker; returns null when the line has none. */
function parseMarker(line) {
  const found = MARKER.exec(line);
  if (!found) return null;
  const reason = found[2]
    .replace(/-->|\*\/|\*\)/g, '')
    .replace(/^[\s:\u2013\u2014-]+/, '')
    .trim();
  return { nextLine: Boolean(found[1]), reason };
}

/** Scans file content and returns findings (rule id + 1-based line); values are never retained. */
function scanText(text, file) {
  const lines = text.split(/\r?\n/);
  const found = [];
  lines.forEach((line, index) => {
    for (const rule of RULES) {
      rule.regex.lastIndex = 0;
      for (const match of line.matchAll(rule.regex)) {
        const matchEnd = (match.index ?? 0) + match[0].length;
        const groups = match.groups ?? {};
        if (rule.validate && !rule.validate({ groups, line, matchEnd, file, match: match[0] })) {
          continue;
        }
        found.push({ file, line: index + 1, rule: rule.id });
        break;
      }
    }
  });
  const results = [];
  for (const finding of found) {
    const same = parseMarker(lines[finding.line - 1] ?? '');
    const previous = finding.line > 1 ? parseMarker(lines[finding.line - 2] ?? '') : null;
    const marker = same && !same.nextLine ? same : previous?.nextLine ? previous : null;
    if (!marker) {
      results.push(finding);
    } else if (marker.reason.length < MIN_REASON_LENGTH) {
      results.push({ ...finding, rule: 'allow-without-reason' });
    }
  }
  return dedupe(results);
}

function dedupe(findings) {
  const seen = new Set();
  return findings.filter((finding) => {
    const key = `${finding.file}:${finding.line}:${finding.rule}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** File-level checks that do not need file content. */
function scanPath(file) {
  const base = basename(file);
  const found = [];
  if (/^\.env(\..+)?$/.test(base) && !/\.(example|sample|template)$/.test(base)) {
    found.push({ file, line: 1, rule: 'env-file-committed' });
  }
  if (/\.(pfx|p12|jks|keystore)$/i.test(base) || /^id_(rsa|dsa|ecdsa|ed25519)$/.test(base)) {
    found.push({ file, line: 1, rule: 'key-file-committed' });
  }
  return found;
}

/** Converts a gitignore-style glob to a RegExp over forward-slash relative paths. */
function globToRegExp(glob) {
  let pattern = glob.replace(/^\.\//, '');
  const anywhere = !pattern.includes('/');
  if (pattern.endsWith('/')) pattern = `${pattern}**`;
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '*' && pattern[i + 1] === '*') {
      const slash = pattern[i + 2] === '/';
      source += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(anywhere ? `(?:^|/)${source}$` : `^${source}$`);
}

/** Parses `.secretscanignore`; every entry needs a `# reason` and may restrict `rules=`. */
function parseAllowlist(text) {
  const entries = [];
  const errors = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const lineNo = index + 1;
    if (raw.trim() === '' || raw.trim().startsWith('#')) return;
    const hash = raw.indexOf('#');
    const reason = hash >= 0 ? raw.slice(hash + 1).trim() : '';
    const spec = (hash >= 0 ? raw.slice(0, hash) : raw).trim();
    if (reason.length < MIN_REASON_LENGTH) {
      errors.push(
        `${IGNORE_FILE}:${lineNo}: entry needs a "# <justification>" (min ${MIN_REASON_LENGTH} chars)`,
      );
      return;
    }
    const parts = spec.split(/\s+/);
    const glob = parts[0];
    const rulesPart = parts.slice(1).find((part) => part.startsWith('rules='));
    const rules = rulesPart ? rulesPart.slice('rules='.length).split(',').filter(Boolean) : null;
    const unknown = (rules ?? []).filter((rule) => !KNOWN_RULE_IDS.has(rule));
    if (!glob || parts.length > 2 || (parts.length === 2 && !rulesPart)) {
      errors.push(`${IGNORE_FILE}:${lineNo}: expected "<glob> [rules=a,b]  # <reason>"`);
    } else if (unknown.length > 0) {
      errors.push(`${IGNORE_FILE}:${lineNo}: unknown rule id(s): ${unknown.join(', ')}`);
    } else {
      entries.push({ glob, regex: globToRegExp(glob), rules, reason, lineNo });
    }
  });
  return { entries, errors };
}

function isAllowlisted(entries, file, rule) {
  return entries.some(
    (entry) => entry.regex.test(file) && (!entry.rules || entry.rules.includes(rule)),
  );
}

function git(args, options = {}) {
  return execFileSync('git', args, { cwd: ROOT, maxBuffer: 256 * 1024 * 1024, ...options });
}

/** Lists files to scan: tracked + untracked-not-ignored, or only staged additions/modifications. */
function listFiles({ staged }, run = git) {
  const args = staged
    ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']
    : ['ls-files', '-co', '--exclude-standard', '-z'];
  const out = run(args, { encoding: 'utf8' });
  return [...new Set(String(out).split('\0').filter(Boolean))].sort();
}

/** Fallback when git is unavailable: walk the tree, skipping build output and dependencies. */
function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else files.push(relative(ROOT, full).split(sep).join('/'));
  }
  return files;
}

function readContent(file, { staged }) {
  if (staged) return git(['show', `:${file}`]);
  const full = join(ROOT, file);
  if (!existsSync(full)) return null; // tracked but deleted in the working tree
  if (statSync(full).size > MAX_FILE_BYTES) return 'too-large';
  return readFileSync(full);
}

function formatFinding(finding) {
  const rule = [...RULES, ...FILE_RULES].find((candidate) => candidate.id === finding.rule);
  return `  ${finding.file}:${finding.line}  [${finding.rule}]  ${rule?.description ?? ''}`;
}

function runScan({ staged }) {
  const ignorePath = join(ROOT, IGNORE_FILE);
  const allowlist = existsSync(ignorePath)
    ? parseAllowlist(readFileSync(ignorePath, 'utf8'))
    : { entries: [], errors: [] };
  if (allowlist.errors.length > 0) {
    console.error('scan-secrets: invalid allowlist');
    for (const error of allowlist.errors) console.error(`  ${error}`);
    return 2;
  }
  let files;
  try {
    files = listFiles({ staged });
  } catch (error) {
    if (staged) {
      console.error(`scan-secrets: cannot list staged files (${error.message})`);
      return 2;
    }
    console.warn('scan-secrets: git unavailable, scanning the working tree instead');
    files = walk(ROOT);
  }
  const findings = [];
  const skipped = [];
  let scanned = 0;
  for (const file of files) {
    findings.push(...scanPath(file));
    if (BINARY_EXTENSIONS.has(extname(file).toLowerCase())) continue;
    const content = readContent(file, { staged });
    if (content === null) continue;
    if (content === 'too-large' || content.length > MAX_FILE_BYTES) {
      skipped.push(`${file} (larger than ${MAX_FILE_BYTES / 1024} KiB)`);
      continue;
    }
    if (content.subarray(0, 8000).includes(0)) continue; // binary content
    scanned += 1;
    findings.push(...scanText(content.toString('utf8'), file));
  }
  const active = findings.filter(
    (finding) => !isAllowlisted(allowlist.entries, finding.file, finding.rule),
  );
  const mode = staged ? 'staged' : 'working tree';
  console.log(`scan-secrets: scanned ${scanned} file(s) (${mode}), ${skipped.length} skipped`);
  for (const note of skipped) console.log(`  skipped: ${note}`);
  if (active.length === 0) {
    console.log('scan-secrets: PASSED, no findings');
    return 0;
  }
  console.error(`scan-secrets: FAILED, ${active.length} finding(s). Values are never printed.`);
  for (const finding of active.slice(0, MAX_PRINTED_FINDINGS))
    console.error(formatFinding(finding));
  if (active.length > MAX_PRINTED_FINDINGS)
    console.error(`  ... and ${active.length - MAX_PRINTED_FINDINGS} more`);
  console.error(
    [
      'If a value is real: remove it from the file and history, then rotate the credential.',
      `If it is a false positive: add an inline allow marker with a reason, or an entry with a justification to ${IGNORE_FILE}.`,
    ].join('\n'),
  );
  return 1;
}

// ---------------------------------------------------------------------------------------------
// Self-tests. Fixtures are assembled at runtime so this file never contains a secret-shaped string.

/** Deterministic pseudo-random string over `alphabet` (LCG) so fixtures are stable and high-entropy. */
function fixture(length, alphabet, seed = 7) {
  let state = seed;
  let out = '';
  for (let i = 0; i < length; i += 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    out += alphabet[Math.floor((state / 2147483648) * alphabet.length)];
  }
  return out;
}

const B62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const B64 = `${B62}+/`;
const URLSAFE = `${B62}-_`;
const concat = (...parts) => parts.join('');

function runSelfTests() {
  const marker = (suffix) => concat('secretscan', ':allow', suffix);
  const pemHeader = concat('-----BEGIN ', 'RSA PRIVATE KEY', '-----');
  const awsKey = concat('AKIA', fixture(16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', 3));
  const ghToken = concat('gh', 'p_', fixture(36, B62, 5));
  const slack = concat('xox', 'b-', fixture(12, '0123456789', 9), '-', fixture(24, B62, 11));
  const stripe = concat('sk', '_live_', fixture(26, B62, 13));
  const accountKey = concat('Account', 'Key=', fixture(86, B64, 17), '==');
  const sasUrl = concat(
    'https://acct.blob.core.windows.net/c/b?sv=2022-11-02&se=2030-01-01T00%3A00%3A00Z&sr=b&sp=r&sig=',
    fixture(43, B62, 19),
    '%3D',
  );
  const jwt = concat(
    'eyJ',
    fixture(30, URLSAFE, 21),
    '.eyJ',
    fixture(40, URLSAFE, 23),
    '.',
    fixture(43, URLSAFE, 29),
  );
  const entraSecret = concat(fixture(3, B62, 31), '8Q', '~', fixture(34, B62, 37));
  const random32 = fixture(32, B62, 41);
  const random28 = fixture(28, B62, 43);
  const urlPassword = fixture(20, B62, 47);

  const cases = [
    ['private key header', () => ruleIds(pemHeader, 'a.txt').includes('private-key')],
    ['aws access key id', () => ruleIds(`id = ${awsKey}`, 'a.txt').includes('aws-access-key-id')],
    ['github token', () => ruleIds(`GH=${ghToken}`, 'a.txt').includes('github-token')],
    ['slack token', () => ruleIds(`s = ${slack}`, 'a.txt').includes('slack-token')],
    ['stripe live key', () => ruleIds(`k: ${stripe}`, 'a.txt').includes('stripe-secret-key')],
    [
      'azure storage account key',
      () =>
        ruleIds(`DefaultEndpointsProtocol=https;${accountKey}`, 'a.txt').includes(
          'azure-storage-account-key',
        ),
    ],
    ['azure SAS url', () => ruleIds(`url = "${sasUrl}"`, 'a.txt').includes('azure-sas-token')],
    [
      'azure shared access signature',
      () =>
        ruleIds(`SharedAccessSignature=sv=2022&sig=${fixture(30, B62, 53)}`, 'a.txt').includes(
          'azure-shared-access-key',
        ),
    ],
    [
      'entra client secret',
      () => ruleIds(`secret ${entraSecret}`, 'a.txt').includes('azure-ad-client-secret'),
    ],
    ['jwt', () => ruleIds(`Authorization: ${jwt}`, 'a.txt').includes('jwt')],
    [
      'generic quoted assignment in code',
      () => ruleIds(`const apiKey = "${random32}";`, 'a.ts').includes('generic-secret-assignment'),
    ],
    [
      'generic unquoted assignment in yaml',
      () => ruleIds(`password: ${random28}`, 'a.yml').includes('generic-secret-assignment'),
    ],
    [
      'unquoted assignment in code is ignored',
      () => ruleIds(`password: ${random28}`, 'a.ts').length === 0,
    ],
    [
      'credential in url',
      () =>
        ruleIds(
          `DATABASE_URL=postgres://svc:${urlPassword}@db.internal:5432/app`,
          'a.txt',
        ).includes('credential-in-url'),
    ],
    [
      'placeholder url password is ignored',
      () =>
        ruleIds('DATABASE_URL=postgres://postgres:postgres@localhost:5432/app', 'a.txt').length ===
        0,
    ],
    [
      'variable reference url password is ignored',
      () => ruleIds('url: postgres://u:${DB_PASSWORD_VALUE}@host/db', 'a.yml').length === 0,
    ],
    [
      'placeholders are ignored',
      () =>
        ruleIds(
          'apiKey: "<your-api-key-here-0000>"\npassword = "changeme-changeme-1"\ntoken: "${GITHUB_TOKEN_VALUE}"',
          'a.ts',
        ).length === 0,
    ],
    [
      'identifiers and urls are ignored',
      () =>
        ruleIds(
          "const TOKEN_ENDPOINT = 'https://login.example.org/common/oauth2/v2.0/token';\nconst key = 'AZURE_OPENAI_API_KEY';",
          'a.ts',
        ).length === 0,
    ],
    [
      'zero guid instrumentation key is ignored',
      () =>
        ruleIds(
          'InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://x',
          'a.txt',
        ).length === 0,
    ],
    [
      'mostly-zero guid instrumentation key is ignored',
      () =>
        ruleIds('InstrumentationKey=00000000-0000-4000-8000-000000000001;', 'a.txt').length === 0,
    ],
    [
      'redactor output inside a url is ignored',
      () => ruleIds('postgres://svc:[REDACTED:password]@db.internal/app', 'a.txt').length === 0,
    ],
    [
      'templated shared access key is ignored',
      () => ruleIds('SharedAccessKey=Zx9Kq2LmPw${KEY_SUFFIX_VALUE}', 'a.yml').length === 0,
    ],
    [
      'real-looking instrumentation key is flagged',
      () =>
        ruleIds(
          concat('Instrumentation', 'Key=', '3f2504e0-4f89-41d3-9a0c-0305e82c3301', ';'),
          'a.txt',
        ).includes('appinsights-instrumentation-key'),
    ],
    [
      '.env is flagged, .env.example is not',
      () =>
        scanPath('apps/api/.env').length === 1 &&
        scanPath('.env.local').length === 1 &&
        scanPath('.env.example').length === 0,
    ],
    [
      'keystore files are flagged',
      () => scanPath('certs/server.pfx').some((f) => f.rule === 'key-file-committed'),
    ],
    [
      'inline allow marker with reason suppresses',
      () =>
        scanText(
          `const apiKey = "${random32}"; // ${marker(' synthetic canary for redaction test')}`,
          'a.ts',
        ).length === 0,
    ],
    [
      'allow-next-line marker with reason suppresses',
      () =>
        scanText(
          `// ${marker('-next-line synthetic canary for redaction test')}\nconst apiKey = "${random32}";`,
          'a.ts',
        ).length === 0,
    ],
    [
      'allow marker without reason is itself a finding',
      () =>
        ruleIds(`const apiKey = "${random32}"; // ${marker('')}`, 'a.ts').join() ===
        'allow-without-reason',
    ],
    [
      'output never contains the matched value',
      () => {
        const out = scanText(`const apiKey = "${random32}";`, 'a.ts').map(formatFinding).join('\n');
        return out.includes('a.ts:1') && !out.includes(random32);
      },
    ],
    [
      'entropy: constant string is 0, 4 distinct chars is 2 bits',
      () => shannonEntropy('aaaa') === 0 && Math.abs(shannonEntropy('abcd') - 2) < 1e-9,
    ],
    [
      'allowlist requires a justification',
      () =>
        parseAllowlist('docs/**\n').errors.length === 1 &&
        parseAllowlist('docs/** # short\n').errors.length === 1,
    ],
    [
      'allowlist accepts globs with reasons and rules',
      () => {
        const parsed = parseAllowlist(
          '# c\n\nsynthetic-data/**  # synthetic canary strings\ndocs/**/*.md rules=jwt  # redacted sample tokens\n',
        );
        return (
          parsed.errors.length === 0 &&
          parsed.entries.length === 2 &&
          parsed.entries[1].rules[0] === 'jwt'
        );
      },
    ],
    [
      'allowlist rejects unknown rule ids',
      () => parseAllowlist('a/** rules=nope  # some justification\n').errors.length === 1,
    ],
    [
      'glob: ** spans directories, * does not',
      () => {
        const deep = globToRegExp('synthetic-data/**');
        const star = globToRegExp('docs/*.md');
        return (
          deep.test('synthetic-data/a/b/c.json') &&
          star.test('docs/a.md') &&
          !star.test('docs/x/a.md')
        );
      },
    ],
    [
      'glob: slash-less pattern matches in any directory',
      () =>
        globToRegExp('*.snap').test('a/b/c.snap') && !globToRegExp('*.snap').test('a/b/c.snaps'),
    ],
    [
      'allowlist scoping by rule',
      () => {
        const { entries } = parseAllowlist('docs/** rules=jwt  # redacted sample tokens\n');
        return (
          isAllowlisted(entries, 'docs/a.md', 'jwt') &&
          !isAllowlisted(entries, 'docs/a.md', 'private-key')
        );
      },
    ],
    [
      'staged listing uses the index, not the working tree',
      () => {
        let seen = [];
        const files = listFiles({ staged: true }, (args) => {
          seen = args;
          return 'b.txt\0a.txt\0';
        });
        return seen.includes('--cached') && files.join() === 'a.txt,b.txt';
      },
    ],
  ];

  function ruleIds(text, file) {
    return scanText(text, file).map((finding) => finding.rule);
  }

  let failures = 0;
  for (const [name, run] of cases) {
    let ok = false;
    try {
      ok = run() === true;
    } catch (error) {
      console.error(`  error in "${name}": ${error.message}`);
    }
    if (!ok) failures += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  }
  console.log(`scan-secrets self-test: ${cases.length - failures}/${cases.length} passed`);
  return failures === 0;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node scripts/scan-secrets.mjs [--staged] [--self-test]');
    return 0;
  }
  const unknown = args.filter((arg) => !['--staged', '--self-test'].includes(arg));
  if (unknown.length > 0) {
    console.error(`scan-secrets: unknown argument(s): ${unknown.join(' ')}`);
    return 2;
  }
  if (args.includes('--self-test')) return runSelfTests() ? 0 : 1;
  return runScan({ staged: args.includes('--staged') });
}

process.exitCode = main();
