import type { AuthMode, Permission, Role } from '@caseguard/schemas';

/** The authenticated caller. Derived only from a validated credential, never from request input. */
export interface AuthContext {
  readonly userId: string;
  readonly tenantId: string;
  readonly displayName: string;
  readonly roles: readonly Role[];
  readonly permissions: readonly Permission[];
  readonly authMode: AuthMode;
  /** True for development personas and other synthetic identities. */
  readonly synthetic: boolean;
  /** Identifier at the identity provider (Entra `oid`, or the persona id in dev mode). */
  readonly subject: string;
  readonly email: string | null;
}

/** Node/Fastify header bag (lower-cased names) or a Fetch `Headers`-style reader. */
export type HeadersLike =
  | Readonly<Record<string, string | readonly string[] | undefined>>
  | { get(name: string): string | null };

/**
 * Turns request headers into an `AuthContext`.
 * Throws `AuthenticationError` (401, generic message) for any credential problem and may throw
 * `AuthorizationError` (403) when the identity is valid but holds no CaseGuard role.
 */
export interface Authenticator {
  authenticate(headers: HeadersLike): Promise<AuthContext>;
}
