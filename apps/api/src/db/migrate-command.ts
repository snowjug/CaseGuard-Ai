import { parseEntraTenantMap } from '@caseguard/config';
import { AppError } from '../errors';
import { createDatabase, type DatabaseOptions } from './client';
import { describeFailure, extractDatabaseErrorInfo } from './errors';
import { MigrationError, getMigrationStatus, migrate } from './migrate';
import { findMissingTenants, isValidTenantId, provisionTenants } from './provision';
import type { Database } from './repositories/types';

const USAGE = 'Usage: pnpm db:migrate [--status] [--tenant <id>]...';

const TENANT_ID_RULE =
  'a tenant id is 1-120 characters: letters, digits and _ . : - only, starting with a letter or digit';

/** Where the command writes; the real console unless a test supplies its own. */
export interface CliOutput {
  log(message: string): void;
  error(message: string): void;
}

/** What the command needs from its surroundings; tests inject a database, a clock and the output. */
export interface MigrateCliDeps {
  open?: (options: DatabaseOptions) => Promise<Database>;
  now?: () => Date;
  output?: CliOutput;
}

type ParsedArguments =
  | { readonly ok: true; readonly statusOnly: boolean; readonly tenantFlags: readonly string[] }
  | { readonly ok: false };

/** `--status` and any number of `--tenant <id>` / `--tenant=<id>`; nothing else is accepted. */
function parseArguments(rawArgv: readonly string[]): ParsedArguments {
  // Some package-manager versions pass the separator through (`pnpm db:migrate -- --status`).
  const argv = rawArgv.filter((argument) => argument !== '--');
  let statusOnly = false;
  const tenantFlags: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    if (argument === '--status') {
      statusOnly = true;
    } else if (argument === '--tenant') {
      index += 1;
      const value = argv[index];
      // A tenant id never starts with a dash, so another flag here means the value is missing.
      if (value === undefined || value.startsWith('-')) return { ok: false };
      tenantFlags.push(value);
    } else if (argument.startsWith('--tenant=')) {
      tenantFlags.push(argument.slice('--tenant='.length));
    } else {
      return { ok: false };
    }
  }
  return { ok: true, statusOnly, tenantFlags };
}

type Requested =
  | { readonly ok: true; readonly ids: readonly string[] }
  | { readonly ok: false; readonly message: string };

/**
 * The tenants to provision: the values of ENTRA_TENANT_MAP (in the order written), then the
 * `--tenant` flags, without duplicates. Only that one variable is read, never the full
 * configuration, so the job keeps working with just the DATABASE_* variables. Messages say which
 * input is wrong, never what it contained.
 */
function requestedTenants(env: NodeJS.ProcessEnv, flags: readonly string[]): Requested {
  const ids: string[] = [];
  const map = parseEntraTenantMap(env.ENTRA_TENANT_MAP);
  if (map.ok) {
    ids.push(...Object.values(map.map));
  } else if (map.reason === 'invalid') {
    return {
      ok: false,
      message:
        'ENTRA_TENANT_MAP is not valid: it must be a non-empty JSON object mapping Entra tenant ids (GUIDs) to CaseGuard tenant ids',
    };
  }
  for (const [index, flag] of flags.entries()) {
    if (!isValidTenantId(flag)) {
      return { ok: false, message: `Invalid --tenant value (#${index + 1}): ${TENANT_ID_RULE}` };
    }
    ids.push(flag);
  }
  return { ok: true, ids: [...new Set(ids)] };
}

/**
 * Only messages that carry no SQL, parameters, host names or secrets are printed: the text of our
 * own errors plus the sanitised database cause (a SQLSTATE or a connection error code).
 */
function describeError(error: unknown): string {
  if (error instanceof MigrationError) return error.message;
  if (error instanceof AppError) {
    return error.cause instanceof Error
      ? `${error.message}: ${error.cause.message}`
      : error.message;
  }
  const classified =
    extractDatabaseErrorInfo(error) !== null ||
    typeof (error as { code?: unknown } | null | undefined)?.code === 'string';
  // An error of unknown origin may carry anything in its message, so only its class is named.
  if (error instanceof Error && !classified) return `unexpected ${error.name}`;
  return describeFailure(error);
}

async function applyAndProvision(
  db: Database,
  ids: readonly string[],
  out: CliOutput,
  now: (() => Date) | undefined,
): Promise<number> {
  const result = await migrate(db);
  if (result.appliedNow.length === 0) {
    out.log('No pending migrations.');
  } else {
    for (const name of result.appliedNow) out.log(`Applied ${name}`);
  }
  const status = await getMigrationStatus(db);
  out.log(`Applied: ${status.applied.length}, pending: ${status.pending.length}`);
  for (const entry of status.applied) out.log(`  [x] ${entry.name} (${entry.appliedAt})`);
  for (const name of status.pending) out.log(`  [ ] ${name}`);
  if (status.checksumMismatch.length > 0) {
    out.error(`Checksum mismatch: ${status.checksumMismatch.join(', ')}`);
    return 1;
  }

  if (ids.length === 0) {
    out.log('Tenants: none requested (set ENTRA_TENANT_MAP or pass --tenant <id>)');
    return 0;
  }
  try {
    const provisioned = await provisionTenants(
      db,
      ids.map((id) => ({ id })),
      now === undefined ? {} : { now },
    );
    const created = new Set(provisioned.created);
    for (const id of ids) {
      out.log(`Tenants: ${id} ${created.has(id) ? 'created' : 'already provisioned'}`);
    }
    return 0;
  } catch (error) {
    out.error(
      `Tenant provisioning failed (the migrations above were applied; re-running is safe): ${describeError(error)}`,
    );
    return 1;
  }
}

async function reportStatus(db: Database, ids: readonly string[], out: CliOutput): Promise<number> {
  const status = await getMigrationStatus(db);
  out.log(`Applied: ${status.applied.length}, pending: ${status.pending.length}`);
  for (const entry of status.applied) out.log(`  [x] ${entry.name} (${entry.appliedAt})`);
  for (const name of status.pending) out.log(`  [ ] ${name}`);
  let code = status.pending.length > 0 ? 1 : 0;
  if (status.checksumMismatch.length > 0) {
    out.error(`Checksum mismatch: ${status.checksumMismatch.join(', ')}`);
    code = 1;
  }
  if (ids.length > 0) {
    const missing = new Set(await findMissingTenants(db, ids));
    for (const id of ids) {
      out.log(`Tenants: ${id} ${missing.has(id) ? 'missing' : 'provisioned'}`);
    }
    if (missing.size > 0) {
      out.error(
        `${missing.size} of ${ids.length} tenant(s) are not provisioned: run pnpm db:migrate without --status to provision them.`,
      );
      code = 1;
    }
  }
  return code;
}

/**
 * `pnpm db:migrate [--status] [--tenant <id>]...` against DATABASE_URL.
 *  - Without `--status`: applies pending migrations, then provisions the tenants named by
 *    ENTRA_TENANT_MAP and by `--tenant` (idempotent: see `provisionTenants`), printing one
 *    `Tenants: <id> created | already provisioned` line per tenant.
 *  - With `--status`: only reports, writes nothing. Exit code 1 when migrations are pending, an
 *    applied file changed, or a requested tenant is missing.
 * Never prints the connection string, a secret or a token. Returns the exit code: 0 success,
 * 1 failure (including an invalid tenant id or map, rejected before any database work), 2 usage.
 */
export async function runMigrateCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  deps: MigrateCliDeps = {},
): Promise<number> {
  const out = deps.output ?? console;
  const parsed = parseArguments(argv);
  if (!parsed.ok) {
    out.error(USAGE);
    return 2;
  }
  const requested = requestedTenants(env, parsed.tenantFlags);
  if (!requested.ok) {
    out.error(requested.message);
    return 1;
  }

  const url = env.DATABASE_URL ?? 'pglite://.data/caseguard';
  const auth = env.DATABASE_AUTH === 'entra' ? 'entra' : 'password';
  const poolMax = Number.parseInt(env.DB_POOL_MAX ?? '', 10);
  const target = url.startsWith('pglite://')
    ? `PGlite (${url.slice('pglite://'.length)})`
    : 'PostgreSQL';
  out.log(`Database: ${target}${auth === 'entra' ? ' with Microsoft Entra authentication' : ''}`);

  let db: Database;
  try {
    db = await (deps.open ?? createDatabase)({
      url,
      auth,
      poolMax: Number.isFinite(poolMax) && poolMax > 0 ? poolMax : undefined,
      applicationName: 'caseguard-migrate',
    });
  } catch (error) {
    out.error(`Migration failed: ${describeError(error)}`);
    return 1;
  }
  try {
    return parsed.statusOnly
      ? await reportStatus(db, requested.ids, out)
      : await applyAndProvision(db, requested.ids, out, deps.now);
  } catch (error) {
    out.error(`Migration failed: ${describeError(error)}`);
    return 1;
  } finally {
    await db.close();
  }
}
