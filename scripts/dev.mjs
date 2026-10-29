#!/usr/bin/env node
// `pnpm dev`: starts the API and the web app together (via `concurrently`), after loading `.env`.
//
// Usage: node scripts/dev.mjs [--api-only] [--web-only] [--env-file <path>] [--dry-run]
//   --dry-run   print what would run (and which .env variables would be loaded) without starting anything
//
// Variables already present in the environment win over `.env`, like every dotenv loader. The file is
// read once here and inherited by both child processes, so one root `.env` configures the whole stack.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PNPM = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const REQUIRED_NODE_MAJOR = 24;

/** Parses dotenv text: `KEY=value`, optional `export`, quotes, `#` comments. Returns a plain object. */
function parseEnv(text) {
  const values = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rest] = match;
    let value = rest.trim();
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      const end = value.indexOf(quote, 1);
      value = end === -1 ? value.slice(1) : value.slice(1, end);
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else {
      const comment = value.search(/\s#/);
      value = (comment === -1 ? value : value.slice(0, comment)).trim();
    }
    values[key] = value;
  }
  return values;
}

/** Applies parsed values to `env` without overriding existing variables. Returns the names applied. */
function applyEnv(values, env) {
  const applied = [];
  for (const [key, value] of Object.entries(values)) {
    if (env[key] === undefined) {
      env[key] = value;
      applied.push(key);
    }
  }
  return applied;
}

function parseArgs(argv) {
  const options = { apiOnly: false, webOnly: false, dryRun: false, envFile: resolve(ROOT, '.env') };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--api-only') options.apiOnly = true;
    else if (arg === '--web-only') options.webOnly = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--env-file') options.envFile = resolve(process.cwd(), argv[(i += 1)] ?? '');
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (options.apiOnly && options.webOnly)
    throw new Error('--api-only and --web-only are exclusive');
  return options;
}

function personaHint(env) {
  const mode = env.AUTH_MODE ?? 'dev';
  const devEnabled = (env.DEV_AUTH_ENABLED ?? 'true') !== 'false';
  if (mode !== 'dev' || !devEnabled) {
    return [
      'Auth: AUTH_MODE is not "dev", so dev personas are disabled; a valid Entra token is required.',
    ];
  }
  return [
    'Dev personas (synthetic users; accepted only when APP_ENV is local or test):',
    '  send the header  x-cg-persona: <userId>  to the API',
    '  user_ava_engineer (engineer)   user_riley_reviewer (reviewer)   user_morgan_manager (manager)',
    '  user_casey_curator (skill_curator)   user_alex_admin (administrator)   all in tenant_contoso_support',
    '  user_fabi_engineer (engineer) lives in tenant_fabrikam_lab and exists for tenant-isolation checks',
  ];
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(
      'Usage: node scripts/dev.mjs [--api-only] [--web-only] [--env-file <path>] [--dry-run]',
    );
    return 0;
  }
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  if (nodeMajor < REQUIRED_NODE_MAJOR) {
    console.error(
      `dev: Node ${REQUIRED_NODE_MAJOR}+ is required (found ${process.versions.node}).`,
    );
    return 2;
  }
  if (!existsSync(resolve(ROOT, 'node_modules'))) {
    console.error('dev: dependencies are not installed. Run `pnpm install` first.');
    return 2;
  }

  const envFileFound = existsSync(options.envFile);
  const applied = envFileFound
    ? applyEnv(parseEnv(readFileSync(options.envFile, 'utf8')), process.env)
    : [];
  const apiPort = process.env.API_PORT ?? '4000';

  const commands = [];
  if (!options.webOnly) {
    commands.push({
      name: 'api',
      command: `${PNPM} --filter @caseguard/api dev`,
      prefixColor: 'cyan',
    });
  }
  if (!options.apiOnly) {
    commands.push({
      name: 'web',
      command: `${PNPM} --filter @caseguard/web dev`,
      prefixColor: 'magenta',
    });
  }

  console.log('CaseGuard AI dev servers (synthetic demo data only)');
  if (!options.webOnly) console.log(`  API  http://localhost:${apiPort}   health: /livez  /readyz`);
  if (!options.apiOnly) console.log('  Web  http://localhost:3000');
  console.log(
    envFileFound
      ? `Config: loaded ${applied.length} variable(s) from ${options.envFile} (existing environment wins)`
      : 'Config: no .env found, using built-in local defaults (copy .env.example to .env to customise)',
  );
  for (const line of personaHint(process.env)) console.log(line);
  console.log('Stop with Ctrl+C.\n');

  if (options.dryRun) {
    for (const { name, command } of commands) console.log(`[dry-run] ${name}: ${command}`);
    if (applied.length > 0) console.log(`[dry-run] variables from env file: ${applied.join(', ')}`);
    return 0;
  }

  const { default: concurrently } = await import('concurrently');
  const { result } = concurrently(commands, {
    prefix: 'name',
    killOthersOn: ['failure'],
    handleInput: false,
  });
  return result.then(
    () => 0,
    () => 1,
  );
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`dev: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  },
);
