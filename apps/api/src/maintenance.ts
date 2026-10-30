import type { BaseInfrastructure } from './infrastructure';

/** How often a replica deletes idempotency keys whose retention has passed. */
export const IDEMPOTENCY_PURGE_INTERVAL_MS = 10 * 60_000;

/** Keys deleted per call, and the most calls one tenant gets per sweep (a longer backlog drains over several sweeps). */
const PURGE_BATCH = 1_000;
const MAX_BATCHES_PER_TENANT = 10;

/**
 * Deletes the expired idempotency keys of every tenant and returns how many it removed. The keys are
 * also trimmed whenever a new one is reserved, so this only matters for tenants that stopped sending
 * requests. A tenant whose purge fails is logged and skipped, so one bad tenant cannot block the rest.
 */
export async function purgeExpiredIdempotency(
  infra: Pick<BaseInfrastructure, 'repos' | 'logger'>,
  tenantIds: readonly string[],
): Promise<number> {
  let purged = 0;
  for (const tenantId of tenantIds) {
    try {
      const repos = infra.repos.forTenant({ tenantId, actorId: 'system:maintenance' });
      for (let batch = 0; batch < MAX_BATCHES_PER_TENANT; batch += 1) {
        const removed = await repos.idempotency.purgeExpired(PURGE_BATCH);
        purged += removed;
        if (removed < PURGE_BATCH) break;
      }
    } catch (error) {
      infra.logger.error({ err: error, tenantId }, 'could not purge expired idempotency keys');
    }
  }
  return purged;
}
