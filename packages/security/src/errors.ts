import type { Permission } from '@caseguard/schemas';

/**
 * Error codes raised by this package. They are a subset of the API's `ErrorCode` union so the HTTP
 * error handler can map every class here to a Problem Details response without special cases.
 */
export type SecurityErrorCode =
  'unauthenticated' | 'forbidden' | 'tenant_violation' | 'unsafe_content' | 'provider_unavailable';

/** Base class for errors that carry an HTTP status; messages are safe to show to clients. */
export class SecurityError extends Error {
  readonly code: SecurityErrorCode;
  readonly status: number;

  constructor(code: SecurityErrorCode, status: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
  }
}

/**
 * Why authentication failed. Used for server-side logs and metrics only: it is never part of the
 * client-visible message, so callers cannot learn which check rejected a forged credential.
 */
export type AuthFailureReason =
  | 'missing_credentials'
  | 'malformed_credentials'
  | 'malformed_token'
  | 'invalid_signature'
  | 'invalid_algorithm'
  | 'unknown_signing_key'
  | 'invalid_issuer'
  | 'invalid_audience'
  | 'token_expired'
  | 'token_not_yet_valid'
  | 'missing_claim'
  | 'unknown_tenant'
  | 'unknown_persona'
  | 'unknown_user'
  | 'user_disabled';

/** The caller could not be authenticated (HTTP 401). The message is deliberately generic. */
export class AuthenticationError extends SecurityError {
  readonly reason: AuthFailureReason;

  constructor(reason: AuthFailureReason, options?: ErrorOptions) {
    super('unauthenticated', 401, 'Authentication failed', options);
    this.reason = reason;
  }
}

/** The caller is authenticated but lacks the required permission or role (HTTP 403). */
export class AuthorizationError extends SecurityError {
  readonly requiredPermission: Permission | null;

  constructor(
    message = 'You do not have permission to perform this action',
    requiredPermission: Permission | null = null,
  ) {
    super('forbidden', 403, message);
    this.requiredPermission = requiredPermission;
  }
}

/**
 * A record or request crossed a tenant boundary (HTTP 403). The offending tenant ids are kept in
 * non-enumerable properties so a generic serializer cannot leak them into a response body.
 */
export class TenantIsolationError extends SecurityError {
  declare readonly expectedTenantId: string | null;
  declare readonly actualTenantId: string | null;

  constructor(expected: string | null, actual: string | null) {
    super('tenant_violation', 403, 'Cross-tenant access is not permitted');
    Object.defineProperty(this, 'expectedTenantId', { value: expected, enumerable: false });
    Object.defineProperty(this, 'actualTenantId', { value: actual, enumerable: false });
  }
}

export type UnsafeUrlReason =
  | 'invalid_url'
  | 'protocol_not_allowed'
  | 'credentials_in_url'
  | 'ip_literal_host'
  | 'private_or_local_host'
  | 'host_not_allowed'
  | 'port_not_allowed';

/** An outbound URL failed SSRF screening (HTTP 422 when it came from a client). */
export class UnsafeUrlError extends SecurityError {
  readonly reason: UnsafeUrlReason;

  constructor(reason: UnsafeUrlReason, message: string) {
    super('unsafe_content', 422, message);
    this.reason = reason;
  }
}

/** The identity provider's keys could not be retrieved: a platform fault, not a bad credential. */
export class IdentityProviderUnavailableError extends SecurityError {
  constructor(options?: ErrorOptions) {
    super('provider_unavailable', 503, 'Identity provider is temporarily unavailable', options);
  }
}

/** Authentication was wired up unsafely (for example dev auth in production). Fail fast, do not catch. */
export class AuthConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthConfigurationError';
  }
}
