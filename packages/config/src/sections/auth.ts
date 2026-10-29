import { IdSchema, RoleSchema, type Role } from '@caseguard/schemas';
import { z } from 'zod';
import { type BuildContext, parseUrl } from '../context';
import type { AuthConfig, EntraConfig } from '../types';

export const DEFAULT_ENTRA_ROLE_MAP: Readonly<Record<string, Role>> = Object.freeze({
  'CaseGuard.Engineer': 'engineer',
  'CaseGuard.Reviewer': 'reviewer',
  'CaseGuard.Manager': 'manager',
  'CaseGuard.SkillCurator': 'skill_curator',
  'CaseGuard.Administrator': 'administrator',
});

const TenantMapSchema = z.record(z.guid(), IdSchema);
const RoleMapSchema = z.record(z.string().min(1).max(100), RoleSchema);
const GuidSchema = z.guid();

type JsonResult = { ok: true; value: unknown } | { ok: false };

function parseJson(text: string): JsonResult {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function parseTenantMap(ctx: BuildContext, text: string | undefined): Record<string, string> {
  if (text === undefined) {
    ctx.fail(
      'ENTRA_TENANT_MAP',
      'is required when AUTH_MODE=entra: a JSON object mapping Entra tenant ids to CaseGuard tenant ids',
    );
    return {};
  }
  const json = parseJson(text);
  const parsed = json.ok ? TenantMapSchema.safeParse(json.value) : null;
  if (!parsed?.success || Object.keys(parsed.data).length === 0) {
    ctx.fail(
      'ENTRA_TENANT_MAP',
      'must be a non-empty JSON object mapping Entra tenant ids (GUIDs) to CaseGuard tenant ids',
    );
    return {};
  }
  return parsed.data;
}

function parseRoleMap(ctx: BuildContext, text: string | undefined): Record<string, Role> {
  if (text === undefined) return { ...DEFAULT_ENTRA_ROLE_MAP };
  const json = parseJson(text);
  const parsed = json.ok ? RoleMapSchema.safeParse(json.value) : null;
  if (!parsed?.success || Object.keys(parsed.data).length === 0) {
    ctx.fail(
      'ENTRA_ROLE_MAP',
      `must be a non-empty JSON object mapping Entra app roles to CaseGuard roles (${RoleSchema.options.join(', ')})`,
    );
    return { ...DEFAULT_ENTRA_ROLE_MAP };
  }
  return parsed.data;
}

function buildEntra(ctx: BuildContext): EntraConfig | null {
  const { raw } = ctx;
  let valid = true;

  const tenantId = raw.ENTRA_TENANT_ID;
  if (tenantId === undefined || !GuidSchema.safeParse(tenantId).success) {
    ctx.fail('ENTRA_TENANT_ID', 'is required when AUTH_MODE=entra and must be a tenant GUID');
    valid = false;
  }
  const audience = raw.ENTRA_AUDIENCE;
  if (audience === undefined || /\s/.test(audience)) {
    ctx.fail('ENTRA_AUDIENCE', 'is required when AUTH_MODE=entra and must not contain whitespace');
    valid = false;
  }
  const issuer =
    raw.ENTRA_ISSUER ?? (tenantId ? `https://login.microsoftonline.com/${tenantId}/v2.0` : '');
  if (raw.ENTRA_ISSUER !== undefined && !parseUrl(raw.ENTRA_ISSUER, ['https:'])) {
    ctx.fail('ENTRA_ISSUER', 'must be an https URL');
    valid = false;
  }
  const jwksUri =
    raw.ENTRA_JWKS_URI ??
    (tenantId ? `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys` : '');
  if (raw.ENTRA_JWKS_URI !== undefined && !parseUrl(raw.ENTRA_JWKS_URI, ['https:'])) {
    ctx.fail('ENTRA_JWKS_URI', 'must be an https URL');
    valid = false;
  }
  const tenantMap = parseTenantMap(ctx, raw.ENTRA_TENANT_MAP);
  const roleMap = parseRoleMap(ctx, raw.ENTRA_ROLE_MAP);

  if (!valid || tenantId === undefined || audience === undefined) return null;
  return { tenantId, audience, issuer, jwksUri, tenantMap, roleMap };
}

/**
 * Identity configuration. The persona login exists only for AUTH_MODE=dev outside production and
 * can never be combined with Entra, so a deployment cannot accidentally accept both.
 */
export function buildAuth(ctx: BuildContext): AuthConfig {
  const { raw } = ctx;
  const mode = raw.AUTH_MODE ?? (ctx.localLike ? 'dev' : 'entra');
  const devAuthEnabled = raw.DEV_AUTH_ENABLED ?? (ctx.localLike && mode === 'dev');

  if (ctx.production && mode !== 'entra') {
    ctx.fail('AUTH_MODE', "must be 'entra' when APP_ENV=production");
  }
  if (ctx.production && devAuthEnabled) {
    ctx.fail('DEV_AUTH_ENABLED', 'must be false when APP_ENV=production');
  }
  if (mode === 'dev' && !devAuthEnabled && !ctx.production) {
    ctx.fail('DEV_AUTH_ENABLED', 'AUTH_MODE=dev also requires DEV_AUTH_ENABLED=true');
  }
  if (mode === 'entra' && devAuthEnabled) {
    ctx.fail('DEV_AUTH_ENABLED', 'persona login cannot be enabled while AUTH_MODE=entra');
  }
  if (mode === 'dev' && !ctx.localLike && !ctx.production) {
    ctx.warn(
      'Development identity is enabled outside local and test environments; personas have no real authentication.',
    );
  }

  return {
    mode,
    devAuthEnabled: mode === 'dev' && devAuthEnabled,
    entra: mode === 'entra' ? buildEntra(ctx) : null,
    azureClientId: raw.AZURE_CLIENT_ID ?? null,
  };
}
