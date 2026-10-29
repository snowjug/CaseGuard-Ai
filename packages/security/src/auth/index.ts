export type { AuthContext, Authenticator, HeadersLike } from './types';
export {
  DEV_AUTH_ALLOWED_ENVIRONMENTS,
  PRODUCTION_LIKE_ENVIRONMENTS,
  isDevAuthAllowedEnvironment,
} from './environment';
export { DEV_PERSONA_HEADER, DevPersonaAuthenticator } from './dev';
export type { DevPersonaAuthenticatorOptions, PersonaRecord } from './dev';
export { EntraJwtAuthenticator } from './entra';
export type { EntraJwtAuthenticatorOptions, ResolvedUser, VerifiedEntraClaims } from './entra';
export { createAuthenticator, deriveEntraEndpoints } from './factory';
export type { AuthenticatorDeps, CreateAuthenticatorOptions } from './factory';
export { readSingleHeader } from './headers';
