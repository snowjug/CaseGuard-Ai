import type { ResolvedUser, VerifiedEntraClaims } from '@caseguard/security';
import type { Logger } from '@caseguard/observability';
import type { Repositories } from './db';

/** How long a user's stored profile is trusted before it is synced from the token again. */
export const IDENTITY_SYNC_TTL_MS = 5 * 60_000;
/** Profiles remembered at once; the oldest entries are dropped first. */
const MAX_REMEMBERED_PROFILES = 5_000;

export interface IdentityResolverDeps {
  readonly repos: Pick<Repositories, 'forTenant'>;
  readonly now: () => Date;
  readonly logger: Pick<Logger, 'warn'>;
  readonly ttlMs?: number;
}

/**
 * Just-in-time user provisioning for Entra sign-ins. The token is the source of truth for who the user
 * is and which roles they hold, so the first request of a user (and any change of display name, e-mail
 * or roles) is written to the tenant's user list; the stored status and creation time are kept, so an
 * administrator's `disabled` always wins. While a profile is unchanged the token is not written again
 * for a few minutes, but the stored user is still read on every request so that disabling someone takes
 * effect immediately.
 *
 * Implemented and tested against the repository only: it has not run against a live Entra tenant.
 */
export function createIdentityResolver(
  deps: IdentityResolverDeps,
): (claims: VerifiedEntraClaims) => Promise<ResolvedUser> {
  const ttlMs = deps.ttlMs ?? IDENTITY_SYNC_TTL_MS;
  const synced = new Map<string, { fingerprint: string; until: number }>();

  return async (claims) => {
    const repos = deps.repos.forTenant({ tenantId: claims.tenantId, actorId: 'system:auth' });
    const key = `${claims.tenantId}:${claims.objectId}`;
    const fingerprint = JSON.stringify([
      claims.displayName,
      claims.email,
      [...claims.roles].sort(),
    ]);
    const nowMs = deps.now().getTime();
    const known = synced.get(key);
    const current = known !== undefined && known.fingerprint === fingerprint && known.until > nowMs;

    let user = null;
    if (!current) {
      try {
        user = await repos.governance.upsertIdentityUser({
          userId: claims.objectId,
          displayName: claims.displayName ?? claims.email ?? claims.objectId,
          email: claims.email,
          roles: [...claims.roles],
          synthetic: false,
        });
        synced.delete(key);
        synced.set(key, { fingerprint, until: nowMs + ttlMs });
        while (synced.size > MAX_REMEMBERED_PROFILES) {
          const oldest = synced.keys().next();
          if (oldest.done) break;
          synced.delete(oldest.value);
        }
      } catch (error) {
        // A profile that cannot be stored must not lock the user out: fall back to what is stored.
        deps.logger.warn(
          { err: error, event: 'identity.sync_failed' },
          'could not sync the signed-in user to the user list',
        );
      }
    }
    user ??= await repos.governance.getUser(claims.objectId);

    return {
      userId: claims.objectId,
      ...(user
        ? { displayName: user.displayName, email: user.email, synthetic: user.synthetic }
        : {}),
      ...(user?.status === 'disabled' ? { disabled: true } : {}),
    };
  };
}
