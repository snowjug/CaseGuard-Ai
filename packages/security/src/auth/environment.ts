import type { AppEnvironment } from '@caseguard/schemas';

/** Environments where a development identity may exist. Anything else (including typos) is refused. */
export const DEV_AUTH_ALLOWED_ENVIRONMENTS: readonly AppEnvironment[] = [
  'local',
  'test',
  'development',
];

/**
 * Environments that must behave like production: no development identity, strict validation.
 * `staging` is deliberately included because it fronts real integrations and real credentials.
 */
export const PRODUCTION_LIKE_ENVIRONMENTS: readonly AppEnvironment[] = ['production', 'staging'];

/** Fail-closed check: unknown environment names are not allowed to enable dev auth. */
export function isDevAuthAllowedEnvironment(environment: string): boolean {
  return (DEV_AUTH_ALLOWED_ENVIRONMENTS as readonly string[]).includes(environment);
}
