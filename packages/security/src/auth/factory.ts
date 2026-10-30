import type { JWTVerifyGetKey } from 'jose';
import type { AppEnvironment, AuthMode, Role } from '@caseguard/schemas';
import { AuthConfigurationError } from '../errors';
import { DevPersonaAuthenticator, type DevPersonaAuthenticatorOptions } from './dev';
import { isDevAuthAllowedEnvironment } from './environment';
import { EntraJwtAuthenticator, type EntraJwtAuthenticatorOptions } from './entra';
import type { Authenticator } from './types';

/**
 * Endpoints Microsoft publishes for a tenant: the v2 issuer (what the authenticator derives), the v1
 * issuer (set ENTRA_ISSUER to it if the API app registration still issues v1 tokens) and the keys.
 */
export function deriveEntraEndpoints(tenantId: string): {
  issuer: string;
  issuerV1: string;
  jwksUri: string;
} {
  const tenant = encodeURIComponent(tenantId);
  return {
    issuer: `https://login.microsoftonline.com/${tenant}/v2.0`,
    issuerV1: `https://sts.windows.net/${tenant}/`,
    jwksUri: `https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`,
  };
}

export interface CreateAuthenticatorOptions {
  mode: AuthMode;
  environment: AppEnvironment;
  /** DEV_AUTH_ENABLED: the second switch that must be on for persona login. */
  devAuthEnabled: boolean;
  /** Shape of `AppConfig['auth']['entra']`; null/undefined fields are derived or rejected. */
  entra?: {
    tenantId?: string | null;
    audience?: string | null;
    issuer?: string | null;
    jwksUri?: string | null;
    tenantMap?: Readonly<Record<string, string>>;
    roleMap?: Readonly<Record<string, Role>>;
    clockToleranceSeconds?: number;
  };
}

export interface AuthenticatorDeps {
  lookupPersona?: DevPersonaAuthenticatorOptions['lookupPersona'];
  resolveUser?: EntraJwtAuthenticatorOptions['resolveUser'];
  keyResolver?: JWTVerifyGetKey;
  now?: () => Date;
}

/**
 * Builds the authenticator for the configured mode and refuses unsafe combinations outright
 * (NFR-SEC-03, SEC-1). Persona login exists only when APP_ENV is `local` or `test`, so dev auth is
 * refused in every other environment (development, staging, production and unknown names), and so is
 * `DEV_AUTH_ENABLED=true` there even when Entra is the active mode.
 */
export function createAuthenticator(
  options: CreateAuthenticatorOptions,
  deps: AuthenticatorDeps = {},
): Authenticator {
  if (options.mode === 'dev') {
    if (!isDevAuthAllowedEnvironment(options.environment)) {
      throw new AuthConfigurationError(
        `AUTH_MODE=dev is not allowed when APP_ENV=${options.environment} (persona login exists only when APP_ENV is local or test)`,
      );
    }
    if (options.devAuthEnabled !== true) {
      throw new AuthConfigurationError('AUTH_MODE=dev requires DEV_AUTH_ENABLED=true');
    }
    if (!deps.lookupPersona) {
      throw new AuthConfigurationError('Dev authentication needs a lookupPersona implementation');
    }
    return new DevPersonaAuthenticator({
      allowDev: true,
      environment: options.environment,
      lookupPersona: deps.lookupPersona,
    });
  }

  if (!isDevAuthAllowedEnvironment(options.environment) && options.devAuthEnabled) {
    throw new AuthConfigurationError(
      `DEV_AUTH_ENABLED must be false when APP_ENV=${options.environment}, even with AUTH_MODE=entra (persona login exists only when APP_ENV is local or test)`,
    );
  }

  const entra = options.entra;
  if (!entra?.audience)
    throw new AuthConfigurationError('ENTRA_AUDIENCE is required for AUTH_MODE=entra');
  if (!entra.tenantId && !entra.issuer) {
    throw new AuthConfigurationError(
      'ENTRA_TENANT_ID or ENTRA_ISSUER is required for AUTH_MODE=entra',
    );
  }

  const derived = entra.tenantId ? deriveEntraEndpoints(entra.tenantId) : undefined;
  const issuer = entra.issuer ?? derived?.issuer;
  const jwksUri = entra.jwksUri ?? derived?.jwksUri;
  if (!issuer) throw new AuthConfigurationError('ENTRA_ISSUER could not be determined');

  // Exactly one issuer is accepted. API app registrations that still issue v1 tokens must set
  // ENTRA_ISSUER to the v1 value (see `deriveEntraEndpoints(...).issuerV1`) or, preferably, set
  // `requestedAccessTokenVersion: 2` so tokens carry the derived v2 issuer.
  return new EntraJwtAuthenticator({
    issuer,
    audience: entra.audience,
    tenantMap: entra.tenantMap ?? {},
    roleMap: entra.roleMap ?? {},
    ...(deps.keyResolver ? { keyResolver: deps.keyResolver } : {}),
    ...(jwksUri ? { jwksUri } : {}),
    ...(entra.clockToleranceSeconds === undefined
      ? {}
      : { clockToleranceSeconds: entra.clockToleranceSeconds }),
    ...(deps.resolveUser ? { resolveUser: deps.resolveUser } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
}
