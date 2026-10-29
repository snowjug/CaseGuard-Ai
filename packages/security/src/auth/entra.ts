import {
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import { IdSchema, type Role } from '@caseguard/schemas';
import {
  AuthConfigurationError,
  AuthenticationError,
  AuthorizationError,
  IdentityProviderUnavailableError,
  SecurityError,
  type AuthFailureReason,
} from '../errors';
import { permissionsFor } from '../rbac';
import { readSingleHeader } from './headers';
import type { AuthContext, Authenticator, HeadersLike } from './types';

/** Claims of a token whose signature, issuer, audience and lifetime have already been verified. */
export interface VerifiedEntraClaims {
  /** Entra tenant id (`tid`), lower-cased. */
  readonly entraTenantId: string;
  /** CaseGuard tenant the Entra tenant maps to. */
  readonly tenantId: string;
  /** Object id (`oid`) of the user or service principal. */
  readonly objectId: string;
  /** CaseGuard roles mapped from the `roles` claim (unknown app roles already dropped). */
  readonly roles: readonly Role[];
  readonly displayName: string | null;
  readonly email: string | null;
  readonly raw: Readonly<JWTPayload>;
}

/** Optional provisioning hook: map a verified identity to a stored user, or veto it. */
export interface ResolvedUser {
  readonly userId: string;
  readonly displayName?: string;
  readonly email?: string | null;
  readonly synthetic?: boolean;
  readonly disabled?: boolean;
}

export interface EntraJwtAuthenticatorOptions {
  /**
   * Accepted `iss` value(s). Entra v2 tokens use `https://login.microsoftonline.com/<tid>/v2.0`;
   * v1 tokens (the default for API app registrations that did not set
   * `requestedAccessTokenVersion: 2`) use `https://sts.windows.net/<tid>/`, so pass both if needed.
   */
  readonly issuer: string | readonly string[];
  /** Accepted `aud` value(s): the application id URI or client id of this API. */
  readonly audience: string | readonly string[];
  /** Entra `tid` -> CaseGuard tenant id. A token from an unmapped tenant is rejected. */
  readonly tenantMap: Readonly<Record<string, string>>;
  /** Entra app-role value -> CaseGuard role. Roles not listed here are ignored. */
  readonly roleMap: Readonly<Record<string, Role>>;
  /** Signing-key resolver. Inject `createLocalJWKSet(...)` in tests; defaults to a remote JWKS. */
  readonly keyResolver?: JWTVerifyGetKey;
  /** JWKS endpoint used to build the default remote key resolver (must be https). */
  readonly jwksUri?: string;
  /** Permit an http JWKS endpoint (local mocks only). */
  readonly allowInsecureJwksUri?: boolean;
  /** Accepted skew for `exp`/`nbf` in seconds (default 30, at most 300). */
  readonly clockToleranceSeconds?: number;
  /** Accepted signature algorithms (default `['RS256']`, what Entra uses). */
  readonly algorithms?: readonly string[];
  readonly now?: () => Date;
  readonly resolveUser?: (claims: VerifiedEntraClaims) => Promise<ResolvedUser | null>;
  /** Longest accepted bearer token in characters (default 16384). */
  readonly maxTokenLength?: number;
}

const ASYMMETRIC_ALGORITHMS = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
] as const;
type AsymmetricAlgorithm = (typeof ASYMMETRIC_ALGORITHMS)[number];

const BEARER_PATTERN = /^bearer ([A-Za-z0-9\-._~+/]+=*)$/i;
const MAX_ROLE_CLAIMS = 200;
// Display names come from the IdP; strip control, zero-width and bidi characters before they reach UIs and logs.
// eslint-disable-next-line no-control-regex -- matching control characters is the point of this pattern
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

function toList(value: string | readonly string[]): string[] {
  return (typeof value === 'string' ? [value] : [...value]).filter((item) => item.length > 0);
}

function stringClaim(payload: JWTPayload, name: string): string | undefined {
  const value = payload[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function cleanText(value: string | undefined, max: number): string | null {
  if (value === undefined) return null;
  const cleaned = value.replace(CONTROL_CHARS, '').trim().slice(0, max);
  return cleaned.length > 0 ? cleaned : null;
}

function claimFailureReason(claim: string): AuthFailureReason {
  switch (claim) {
    case 'nbf':
      return 'token_not_yet_valid';
    case 'iss':
      return 'invalid_issuer';
    case 'aud':
      return 'invalid_audience';
    default:
      // jose reports an expired token as JWTExpired, so a failure on `exp` means it is missing.
      return 'missing_claim';
  }
}

function verificationFailureReason(error: unknown): AuthFailureReason {
  if (error instanceof joseErrors.JWTExpired) return 'token_expired';
  if (error instanceof joseErrors.JWTClaimValidationFailed) return claimFailureReason(error.claim);
  if (error instanceof joseErrors.JWSSignatureVerificationFailed) return 'invalid_signature';
  if (
    error instanceof joseErrors.JOSEAlgNotAllowed ||
    error instanceof joseErrors.JOSENotSupported
  ) {
    return 'invalid_algorithm';
  }
  if (
    error instanceof joseErrors.JWKSNoMatchingKey ||
    error instanceof joseErrors.JWKSMultipleMatchingKeys
  ) {
    return 'unknown_signing_key';
  }
  return 'malformed_token';
}

/** Translates a jose failure into our client-safe error; the specific reason stays server-side. */
function mapVerificationError(error: unknown): Error {
  if (error instanceof SecurityError) return error;
  return new AuthenticationError(verificationFailureReason(error), { cause: error });
}

/**
 * Validates Microsoft Entra ID access tokens (NFR-SEC-03/A-15). Signature, issuer, audience,
 * expiry and not-before are verified with `jose`; `tid` must map to a known CaseGuard tenant and the
 * `roles` claim must map to at least one CaseGuard role.
 *
 * Implemented and unit-tested with locally generated keys only; it has not been exercised against a
 * live Entra tenant.
 */
export class EntraJwtAuthenticator implements Authenticator {
  readonly mode = 'entra' as const;
  private readonly issuers: string[];
  private readonly audiences: string[];
  private readonly tenantMap: Map<string, string>;
  private readonly roleMap: Map<string, Role>;
  private readonly keyResolver: JWTVerifyGetKey;
  private readonly algorithms: AsymmetricAlgorithm[];
  private readonly clockToleranceSeconds: number;
  private readonly maxTokenLength: number;
  private readonly now: () => Date;
  private readonly resolveUser: EntraJwtAuthenticatorOptions['resolveUser'];

  constructor(options: EntraJwtAuthenticatorOptions) {
    this.issuers = toList(options.issuer);
    this.audiences = toList(options.audience);
    if (this.issuers.length === 0) throw new AuthConfigurationError('Entra issuer is required');
    if (this.audiences.length === 0) throw new AuthConfigurationError('Entra audience is required');

    this.tenantMap = new Map(
      Object.entries(options.tenantMap).map(([entraTenant, tenant]) => [
        entraTenant.toLowerCase(),
        tenant,
      ]),
    );
    this.roleMap = new Map(Object.entries(options.roleMap));

    const tolerance = options.clockToleranceSeconds ?? 30;
    if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 300) {
      throw new AuthConfigurationError('clockToleranceSeconds must be between 0 and 300');
    }
    this.clockToleranceSeconds = tolerance;
    this.maxTokenLength = options.maxTokenLength ?? 16_384;

    const algorithms = options.algorithms ?? ['RS256'];
    const invalid = algorithms.filter(
      (algorithm) => !(ASYMMETRIC_ALGORITHMS as readonly string[]).includes(algorithm),
    );
    if (algorithms.length === 0 || invalid.length > 0) {
      throw new AuthConfigurationError(
        'algorithms must be a non-empty list of asymmetric JWS algorithms (never "none" or HS*)',
      );
    }
    this.algorithms = algorithms as AsymmetricAlgorithm[];

    this.keyResolver = this.guardKeyResolver(options);
    this.now = options.now ?? (() => new Date());
    this.resolveUser = options.resolveUser;
  }

  /** Wraps the resolver so JWKS outages surface as 503 rather than being mistaken for bad tokens. */
  private guardKeyResolver(options: EntraJwtAuthenticatorOptions): JWTVerifyGetKey {
    let resolver = options.keyResolver;
    if (resolver === undefined) {
      if (!options.jwksUri) {
        throw new AuthConfigurationError(
          'Provide keyResolver or jwksUri for Entra token validation',
        );
      }
      let url: URL;
      try {
        url = new URL(options.jwksUri);
      } catch {
        throw new AuthConfigurationError('jwksUri is not a valid URL');
      }
      if (
        url.protocol !== 'https:' &&
        !(options.allowInsecureJwksUri === true && url.protocol === 'http:')
      ) {
        throw new AuthConfigurationError('jwksUri must use https');
      }
      resolver = createRemoteJWKSet(url, {
        timeoutDuration: 5000,
        cooldownDuration: 30_000,
        cacheMaxAge: 600_000,
      });
    }
    const inner = resolver;
    return async (protectedHeader, token) => {
      try {
        return await inner(protectedHeader, token);
      } catch (error) {
        if (
          error instanceof joseErrors.JWKSNoMatchingKey ||
          error instanceof joseErrors.JWKSMultipleMatchingKeys
        ) {
          throw error;
        }
        throw new IdentityProviderUnavailableError({ cause: error });
      }
    };
  }

  async authenticate(headers: HeadersLike): Promise<AuthContext> {
    const token = this.extractBearerToken(headers);
    const payload = await this.verify(token);

    const entraTenantId = stringClaim(payload, 'tid')?.toLowerCase();
    if (entraTenantId === undefined) throw new AuthenticationError('missing_claim');
    const tenantId = this.tenantMap.get(entraTenantId);
    if (tenantId === undefined) throw new AuthenticationError('unknown_tenant');

    const objectId = stringClaim(payload, 'oid');
    if (objectId === undefined) throw new AuthenticationError('missing_claim');
    if (!IdSchema.safeParse(objectId).success) throw new AuthenticationError('malformed_token');

    const roles = this.mapRoles(payload.roles);
    if (roles.length === 0) {
      throw new AuthorizationError('No CaseGuard role is assigned to this account');
    }

    const preferred = stringClaim(payload, 'preferred_username');
    const claims: VerifiedEntraClaims = {
      entraTenantId,
      tenantId,
      objectId,
      roles,
      displayName: cleanText(stringClaim(payload, 'name') ?? preferred, 120),
      email: cleanText(
        stringClaim(payload, 'email') ??
          (preferred?.includes('@') ? preferred : undefined) ??
          stringClaim(payload, 'upn'),
        200,
      ),
      raw: payload,
    };

    const resolved = this.resolveUser ? await this.resolveUser(claims) : undefined;
    if (resolved === null) throw new AuthenticationError('unknown_user');
    if (resolved?.disabled === true) throw new AuthenticationError('user_disabled');

    return {
      userId: resolved?.userId ?? objectId,
      tenantId,
      displayName: cleanText(resolved?.displayName, 120) ?? claims.displayName ?? objectId,
      roles,
      permissions: permissionsFor(roles),
      authMode: 'entra',
      synthetic: resolved?.synthetic ?? false,
      subject: objectId,
      email: resolved?.email === undefined ? claims.email : resolved.email,
    };
  }

  private extractBearerToken(headers: HeadersLike): string {
    const header = readSingleHeader(headers, 'authorization');
    if (header === undefined || header.trim() === '') {
      throw new AuthenticationError('missing_credentials');
    }
    if (header.length > this.maxTokenLength + 7)
      throw new AuthenticationError('malformed_credentials');
    const match = BEARER_PATTERN.exec(header.trim());
    const token = match?.[1];
    if (token === undefined) throw new AuthenticationError('malformed_credentials');
    return token;
  }

  private async verify(token: string): Promise<JWTPayload> {
    try {
      const { payload } = await jwtVerify(token, this.keyResolver, {
        issuer: this.issuers,
        audience: this.audiences,
        algorithms: this.algorithms,
        clockTolerance: this.clockToleranceSeconds,
        currentDate: this.now(),
        requiredClaims: ['exp'],
      });
      return payload;
    } catch (error) {
      throw mapVerificationError(error);
    }
  }

  private mapRoles(claim: unknown): Role[] {
    if (!Array.isArray(claim)) return [];
    const mapped = new Set<Role>();
    for (const value of (claim as unknown[]).slice(0, MAX_ROLE_CLAIMS)) {
      if (typeof value !== 'string') continue;
      const role = this.roleMap.get(value);
      if (role !== undefined) mapped.add(role);
    }
    return [...mapped];
  }
}
