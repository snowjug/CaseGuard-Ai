import {
  DEFAULT_GOVERNANCE_VALUES,
  GOVERNANCE_SECTIONS,
  IdSchema,
  TenantSchema,
} from '@caseguard/schemas';
import { z } from 'zod';
import { AppError, ConflictError, ForbiddenError, ValidationFailedError } from '../errors';
import { mapDatabaseError } from './errors';
import { toJsonParam } from './normalize';
import { insertRows } from './repositories/support';
import { GOVERNANCE_SETTINGS } from './repositories/table-specs';
import type { Database, SqlExecutor } from './repositories/types';
import { SYNTHETIC_TENANT_DEFINITIONS } from './seed';

/*
 * Tenant provisioning: the rows a deployed environment needs before the first sign-in of a tenant.
 *
 * `tenants` and `governance_settings` are under FORCED row-level security (migration 0002), and the
 * application role `caseguard_app` may only read tenants. Provisioning therefore runs on the
 * connection that owns the schema (the one that applies the migrations) and, exactly like
 * `seedFoundation`, writes each tenant's rows under that tenant's `app.tenant_id`, so the forced
 * policy `id = current_setting('app.tenant_id')` admits the insert: no policy change, no
 * SECURITY DEFINER function and no extra privilege for the runtime role was needed.
 * A superuser bypasses RLS and the same statements work unchanged.
 *
 * Verified on PGlite only (including a non-superuser owner subject to the forced policies); it has
 * not been run against a real PostgreSQL server or Azure Database for PostgreSQL.
 */

/** Written as `updated_by` on the default governance settings. */
export const PROVISIONING_ACTOR = 'system:provision';
const DEFAULT_CHANGE_NOTE = 'Default configuration';

/** Upper bound for one call; a deployment names a handful of tenants. */
export const MAX_PROVISIONED_TENANTS = 200;

const SLUG_MAX_LENGTH = 60;
/** Tries `<slug>`, `<slug>-2` ... `<slug>-50` before giving up on a derived slug. */
const MAX_SLUG_ATTEMPTS = 50;
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** A tenant to provision. Only `id` is required. */
export interface TenantProvisioningRequest {
  /** CaseGuard tenant id (the values of `ENTRA_TENANT_MAP`): letters, digits and `_ . : -`, 1-120 characters. */
  readonly id: string;
  /** Display name, 1-120 characters without control characters or surrounding spaces. Defaults to the id. */
  readonly name?: string;
  /**
   * Lower-case letters and digits separated by single hyphens, at most 60 characters (stricter than
   * the schema, which only bounds the length). Defaults to a derivation of the id, made unique
   * with a numeric suffix when another tenant already uses it; an explicit slug is never altered.
   */
  readonly slug?: string;
  /**
   * Provisioned tenants are real tenants (`false`); only the reserved synthetic fixture ids
   * (`tenant_contoso_support`, `tenant_fabrikam_lab`) default to the synthetic rows `seedFoundation`
   * creates. Never changed on an existing row.
   */
  readonly synthetic?: boolean;
}

export interface TenantProvisioningResult {
  /** Tenants inserted by this call, in the order requested. */
  created: string[];
  /** Tenants that already existed (the row is left untouched), in the order requested. */
  existing: string[];
}

export interface ProvisionOptions {
  /** Clock for the creation and update stamps (tests). */
  now?: () => Date;
}

const ProvisioningRequestSchema = z.strictObject({
  id: IdSchema,
  name: z
    .string()
    .min(1)
    .max(120)
    .refine(
      (value) => value === value.trim() && !/\p{Cc}/u.test(value),
      'A name must not start or end with spaces or contain control characters',
    )
    .optional(),
  slug: z
    .string()
    .min(1)
    .max(SLUG_MAX_LENGTH)
    .regex(SLUG_PATTERN, 'A slug is lower-case letters and digits separated by single hyphens')
    .optional(),
  synthetic: z.boolean().optional(),
});

interface ValidRequest {
  id: string;
  name: string | undefined;
  slug: string | undefined;
  synthetic: boolean | undefined;
  /** Position in the caller's list, for messages. */
  position: number;
}

/** True when `value` is acceptable as a tenant id (the schema rule, nothing is normalised). */
export function isValidTenantId(value: unknown): value is string {
  return IdSchema.safeParse(value).success;
}

type Issue = { path: string; message: string };

/** Messages name the entry and the field, never the offending value (it could be a pasted secret). */
function validateRequests(tenants: unknown): ValidRequest[] {
  if (!Array.isArray(tenants)) {
    throw new ValidationFailedError('Invalid tenant provisioning request', [
      { path: 'tenants', message: 'Expected a list of tenants' },
    ]);
  }
  const entries: readonly unknown[] = tenants;
  if (entries.length > MAX_PROVISIONED_TENANTS) {
    throw new ValidationFailedError('Invalid tenant provisioning request', [
      { path: 'tenants', message: `At most ${MAX_PROVISIONED_TENANTS} tenants per call` },
    ]);
  }
  const issues: Issue[] = [];
  const valid: ValidRequest[] = [];
  const seen = new Map<string, ValidRequest>();
  entries.forEach((entry, index) => {
    const parsed = ProvisioningRequestSchema.safeParse(entry);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        issues.push({
          path: ['tenants', index, ...issue.path].map(String).join('.'),
          message: issue.code === 'unrecognized_keys' ? 'Unknown field' : issue.message,
        });
      }
      return;
    }
    const request: ValidRequest = {
      id: parsed.data.id,
      name: parsed.data.name,
      slug: parsed.data.slug,
      synthetic: parsed.data.synthetic,
      position: index + 1,
    };
    const earlier = seen.get(request.id);
    if (earlier === undefined) {
      seen.set(request.id, request);
      valid.push(request);
    } else if (
      earlier.name !== request.name ||
      earlier.slug !== request.slug ||
      earlier.synthetic !== request.synthetic
    ) {
      issues.push({
        path: `tenants.${index}`,
        message: 'A tenant listed twice must have identical values',
      });
    }
  });
  if (issues.length > 0) {
    throw new ValidationFailedError('Invalid tenant provisioning request', issues.slice(0, 20));
  }
  return valid;
}

/** Lower-case, runs of other characters become one hyphen, trimmed, at most 60 characters. */
function deriveSlug(id: string): string {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/, '');
}

/** The slugs to try, best first: exactly one when the caller chose it. */
function slugCandidates(request: ValidRequest, fixtureSlug: string | undefined): string[] {
  if (request.slug !== undefined) return [request.slug];
  const base = fixtureSlug ?? deriveSlug(request.id);
  const candidates = [base];
  for (let attempt = 2; attempt <= MAX_SLUG_ATTEMPTS; attempt += 1) {
    const suffix = `-${attempt}`;
    candidates.push(
      `${base.slice(0, SLUG_MAX_LENGTH - suffix.length).replace(/-+$/, '')}${suffix}`,
    );
  }
  return candidates;
}

/** Code-unit order: deterministic on every platform, unlike a locale-aware comparison. */
function compareIds(a: ValidRequest, b: ValidRequest): number {
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

const SET_TENANT_SQL = "SELECT set_config('app.tenant_id', $1, true)";

/*
 * No conflict target: an existing id and a slug that another tenant already uses are both absorbed,
 * so the caller can tell them apart without an error (which would abort the transaction). The other
 * tenant's row is invisible under row-level security, so a SELECT cannot be used to look for it.
 */
const INSERT_TENANT_SQL = `INSERT INTO tenants (id, name, slug, synthetic, created_at, data)
  VALUES ($1::text, $2::text, $3::text, $4::boolean, $5::timestamptz, $6::jsonb)
  ON CONFLICT DO NOTHING`;

async function provisionOne(
  tx: SqlExecutor,
  request: ValidRequest,
  stamp: string,
): Promise<'created' | 'existing'> {
  await tx.query(SET_TENANT_SQL, [request.id]);
  const fixture = SYNTHETIC_TENANT_DEFINITIONS.find((candidate) => candidate.id === request.id);
  let outcome: 'created' | 'existing' | undefined;
  for (const slug of slugCandidates(request, fixture?.slug)) {
    const tenant = TenantSchema.parse({
      id: request.id,
      name: request.name ?? fixture?.name ?? request.id,
      slug,
      synthetic: request.synthetic ?? fixture?.synthetic ?? false,
      createdAt: stamp,
    });
    const inserted = await tx.query(INSERT_TENANT_SQL, [
      tenant.id,
      tenant.name,
      tenant.slug,
      tenant.synthetic,
      tenant.createdAt,
      toJsonParam(tenant),
    ]);
    if (inserted.rowCount === 1) {
      outcome = 'created';
      break;
    }
    const present = await tx.query('SELECT 1 AS present FROM tenants WHERE id = $1', [request.id]);
    if (present.rows.length > 0) {
      outcome = 'existing';
      break;
    }
    // The id is free, so the slug belongs to another tenant: try the next candidate.
  }
  if (outcome === undefined) {
    throw new ConflictError(
      request.slug === undefined
        ? `No free slug could be derived for tenant #${request.position}; choose one explicitly`
        : `The slug requested for tenant #${request.position} is already used by another tenant`,
      { reason: 'duplicate' },
    );
  }

  // Missing sections only (an edited or already seeded section is never touched).
  await insertRows(
    tx,
    GOVERNANCE_SETTINGS,
    GOVERNANCE_SECTIONS.map((section) => ({
      tenantId: request.id,
      section,
      value: DEFAULT_GOVERNANCE_VALUES[section],
      version: 1,
      updatedAt: stamp,
      updatedBy: PROVISIONING_ACTOR,
      changeNote: DEFAULT_CHANGE_NOTE,
    })),
    'ignore',
  );
  return outcome;
}

/** A refusal by the database almost always means the role is not the one that owns the schema. */
function explain(error: unknown): unknown {
  const mapped = mapDatabaseError(error);
  if (
    mapped instanceof AppError &&
    (mapped.code === 'forbidden' || mapped.code === 'tenant_violation')
  ) {
    const refused = new ForbiddenError(
      'The database refused tenant provisioning: run it as the role that owns the schema, the one that applies the migrations',
    );
    // The sanitised database error stays the direct cause, where getDatabaseErrorCode looks for it.
    refused.cause = mapped.cause ?? mapped;
    return refused;
  }
  return mapped;
}

/**
 * Idempotently creates the tenant rows (and their default governance settings) a deployment needs
 * before its first sign-in. Safe to run on every deployment:
 *  - a tenant that exists is reported as `existing` and left untouched (name, slug and `synthetic`
 *    are never rewritten); only governance sections it lacks are added, at version 1;
 *  - nothing is ever updated or deleted, and no user, personal data or audit event is written;
 *  - the whole call is one transaction: an invalid or conflicting entry provisions nothing.
 * Input is validated before the database is touched and invalid values are rejected, not cleaned.
 * Must run on the owner/migration connection (see the note at the top of this file).
 */
export async function provisionTenants(
  db: Database,
  tenants: readonly TenantProvisioningRequest[],
  options: ProvisionOptions = {},
): Promise<TenantProvisioningResult> {
  const requests = validateRequests(tenants);
  if (requests.length === 0) return { created: [], existing: [] };

  const stamp = (options.now ?? (() => new Date()))().toISOString();
  // Concurrent provisioners lock rows in the same order, so they wait for each other instead of deadlocking.
  const ordered = [...requests].sort(compareIds);

  const outcomes = new Map<string, 'created' | 'existing'>();
  try {
    await db.transaction(async (tx) => {
      for (const request of ordered) {
        outcomes.set(request.id, await provisionOne(tx, request, stamp));
      }
    });
  } catch (error) {
    throw explain(error);
  }
  return {
    created: requests.filter((r) => outcomes.get(r.id) === 'created').map((r) => r.id),
    existing: requests.filter((r) => outcomes.get(r.id) === 'existing').map((r) => r.id),
  };
}

/**
 * The ids (in the order given, without duplicates) that have no tenant row yet. Read-only; works
 * before the first migration (every id is then missing). Used by `pnpm db:migrate --status`.
 */
export async function findMissingTenants(db: Database, ids: readonly string[]): Promise<string[]> {
  const unique = [...new Set(ids)];
  const invalid = unique.findIndex((id) => !isValidTenantId(id));
  if (invalid >= 0) {
    throw new ValidationFailedError('Invalid tenant id', [
      { path: `ids.${invalid}`, message: 'Not a valid tenant id' },
    ]);
  }
  if (unique.length === 0) return [];
  try {
    return await db.transaction(async (tx) => {
      const table = await tx.query<{ present: boolean }>(
        "SELECT to_regclass('tenants') IS NOT NULL AS present",
      );
      if (table.rows[0]?.present !== true) return unique;
      const missing: string[] = [];
      for (const id of unique) {
        // Row-level security shows the owner only the row of the tenant named here.
        await tx.query(SET_TENANT_SQL, [id]);
        const found = await tx.query('SELECT 1 AS present FROM tenants WHERE id = $1', [id]);
        if (found.rows.length === 0) missing.push(id);
      }
      return missing;
    });
  } catch (error) {
    throw explain(error);
  }
}
