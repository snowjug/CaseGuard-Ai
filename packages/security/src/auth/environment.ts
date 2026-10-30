import type { AppEnvironment } from '@caseguard/schemas';

/**
 * The only environments where a development identity may exist: a developer machine (`local`) and
 * the automated tests (`test`). `development` is deliberately not listed: it is the name of the
 * internet-facing Azure development environment, where anyone who can reach the API could forge the
 * `x-cg-persona` header and obtain any role. Anything else, including typos and case variants, is
 * refused as well.
 */
export const DEV_AUTH_ALLOWED_ENVIRONMENTS: readonly AppEnvironment[] = Object.freeze([
  'local',
  'test',
] as const);

/**
 * Environments that must behave like production: strict validation, real integrations and real
 * credentials. The persona-login rule does not depend on this list: it is the allow-list above, so
 * `development` is refused too.
 */
export const PRODUCTION_LIKE_ENVIRONMENTS: readonly AppEnvironment[] = Object.freeze([
  'production',
  'staging',
] as const);

/** Fail-closed check: only an exact `local` or `test` may enable dev auth; unknown names may not. */
export function isDevAuthAllowedEnvironment(environment: string): boolean {
  return (DEV_AUTH_ALLOWED_ENVIRONMENTS as readonly string[]).includes(environment);
}
