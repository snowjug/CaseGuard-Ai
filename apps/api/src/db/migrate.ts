import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from './hash';
import type { Database, MigrationStatus, SqlExecutor } from './repositories/types';

/** Raised when migrations cannot be applied safely (drift, unreadable or malformed files). */
export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

export interface MigrationFile {
  /** File name without extension, e.g. `0003_cases`. */
  name: string;
  /** SHA-256 of the file content with line endings normalised to LF. */
  checksum: string;
  sql: string;
}

export interface MigrateOptions {
  /** Directory holding `NNNN_name.sql` files. Defaults to the migrations shipped next to this module. */
  dir?: string | undefined;
}

export interface MigrationResult {
  /** Names applied by this call (empty when the database was already up to date). */
  appliedNow: string[];
  status: MigrationStatus;
}

const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;
/** Serialises concurrent migrators (several API replicas starting at once). */
const LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext('caseguard.schema_migrations'))";

const DEFAULT_DIR_CANDIDATES = [
  new URL('./migrations/', import.meta.url),
  new URL('./db/migrations/', import.meta.url),
  new URL('../src/db/migrations/', import.meta.url),
];

async function resolveMigrationsDir(explicit?: string): Promise<string> {
  if (explicit) return explicit;
  for (const candidate of DEFAULT_DIR_CANDIDATES) {
    const path = fileURLToPath(candidate);
    try {
      if ((await stat(path)).isDirectory()) return path;
    } catch {
      // Not present in this layout (source vs bundled); try the next candidate.
    }
  }
  throw new MigrationError(
    'The SQL migrations directory was not found. Copy src/db/migrations next to the bundled ' +
      'output or pass an explicit directory.',
  );
}

/** Reads and checksums the migration files in application order. */
export async function loadMigrations(dir?: string): Promise<MigrationFile[]> {
  const directory = await resolveMigrationsDir(dir);
  const entries = (await readdir(directory)).filter((entry) => entry.endsWith('.sql')).sort();
  const seen = new Set<string>();
  const files: MigrationFile[] = [];
  for (const entry of entries) {
    const match = FILE_PATTERN.exec(entry);
    if (!match) {
      throw new MigrationError(`Migration file "${entry}" does not match NNNN_name.sql`);
    }
    const [, number] = match;
    if (number === undefined || seen.has(number)) {
      throw new MigrationError(`Migration number ${number ?? '?'} is used by more than one file`);
    }
    seen.add(number);
    const raw = await readFile(join(directory, entry), 'utf8');
    const sql = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    files.push({ name: entry.slice(0, -'.sql'.length), checksum: sha256Hex(sql), sql });
  }
  return files;
}

interface AppliedRow {
  name: string;
  checksum: string;
  applied_at: string;
}

async function readApplied(db: SqlExecutor): Promise<AppliedRow[]> {
  const present = await db.query<{ present: boolean }>(
    "SELECT to_regclass('schema_migrations') IS NOT NULL AS present",
  );
  if (!present.rows[0]?.present) return [];
  const result = await db.query<AppliedRow>(
    'SELECT name, checksum, applied_at FROM schema_migrations ORDER BY name',
  );
  return result.rows;
}

function buildStatus(
  files: readonly MigrationFile[],
  applied: readonly AppliedRow[],
): MigrationStatus {
  const byName = new Map(files.map((file) => [file.name, file]));
  const appliedNames = new Set(applied.map((row) => row.name));
  return {
    applied: applied.map((row) => ({
      name: row.name,
      checksum: row.checksum,
      appliedAt: row.applied_at,
    })),
    pending: files.filter((file) => !appliedNames.has(file.name)).map((file) => file.name),
    // The most recently applied migration; unknown to this build when a newer release migrated first.
    latest: applied[applied.length - 1]?.name ?? null,
    // Applied migrations that this build does not ship are not drift (an older replica may still
    // be running against a newer schema); only a changed file for a known name is.
    checksumMismatch: applied
      .filter((row) => {
        const file = byName.get(row.name);
        return file !== undefined && file.checksum !== row.checksum;
      })
      .map((row) => row.name),
  };
}

/** Which migrations are applied, which are pending and whether any applied file changed. */
export async function getMigrationStatus(
  db: Database,
  options: MigrateOptions = {},
): Promise<MigrationStatus> {
  const files = await loadMigrations(options.dir);
  return buildStatus(files, await readApplied(db));
}

async function ensureMigrationsTable(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query(LOCK_SQL);
    await tx.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name       text        PRIMARY KEY,
         checksum   text        NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
  });
}

async function applyOne(db: Database, file: MigrationFile): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.query(LOCK_SQL);
    const existing = await tx.query<{ checksum: string }>(
      'SELECT checksum FROM schema_migrations WHERE name = $1',
      [file.name],
    );
    const recorded = existing.rows[0];
    if (recorded) {
      if (recorded.checksum !== file.checksum) {
        throw new MigrationError(`Migration ${file.name} was modified after it was applied`);
      }
      // Another process applied it while this one was waiting for the lock.
      return false;
    }
    await tx.query(file.sql);
    await tx.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
      file.name,
      file.checksum,
    ]);
    return true;
  });
}

/**
 * Applies pending migrations in order, each in its own transaction, and records name, checksum and
 * time in `schema_migrations`. Refuses to run when an applied migration file has changed.
 */
export async function migrate(
  db: Database,
  options: MigrateOptions = {},
): Promise<MigrationResult> {
  const files = await loadMigrations(options.dir);
  await ensureMigrationsTable(db);
  const before = buildStatus(files, await readApplied(db));
  if (before.checksumMismatch.length > 0) {
    throw new MigrationError(
      `Applied migrations were modified after they ran: ${before.checksumMismatch.join(', ')}. ` +
        'Add a new migration instead of editing an applied one.',
    );
  }
  const pending = new Set(before.pending);
  const appliedNow: string[] = [];
  for (const file of files) {
    if (!pending.has(file.name)) continue;
    if (await applyOne(db, file)) appliedNow.push(file.name);
  }
  return { appliedNow, status: buildStatus(files, await readApplied(db)) };
}
