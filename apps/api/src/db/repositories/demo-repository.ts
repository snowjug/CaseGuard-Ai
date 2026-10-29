import { z } from 'zod';
import { IsoTimestampSchema } from '@caseguard/schemas';
import { toJsonParam } from '../normalize';
import { nowIso, parseStored, validateInput, withErasure, type RepoContext } from './support';
import type { DemoRepository } from './types';

const SEED_MARKER_KEY = 'seed_marker';

const MarkerSchema = z.object({
  seededAt: IsoTimestampSchema,
  profile: z.string().min(1).max(80),
});

/**
 * Case-derived data, in an order that lets the cascades do most of the work. Tenants, users,
 * governance settings, prompt versions and audit events are intentionally not listed.
 */
const RESET_TABLES = [
  'cases',
  'skills',
  'jobs',
  'token_usage',
  'model_executions',
  'review_decisions',
  'idempotency_keys',
  'demo_state',
] as const;

export class DemoRepositoryImpl implements DemoRepository {
  constructor(private readonly ctx: RepoContext) {}

  /**
   * Erases the tenant's case-derived data. Deleting a case cascades through its source, events and
   * every artefact, so the erasure setting is switched on for the duration of this transaction only.
   */
  async resetTenantData(): Promise<void> {
    await this.ctx.run((tx) =>
      withErasure(tx, async () => {
        for (const table of RESET_TABLES) {
          await tx.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [this.ctx.scope.tenantId]);
        }
      }),
    );
  }

  async getSeedMarker(): Promise<{ seededAt: string; profile: string } | null> {
    return this.ctx.run(async (tx) => {
      const result = await tx.query<{ value: unknown }>(
        'SELECT value FROM demo_state WHERE tenant_id = $1 AND key = $2',
        [this.ctx.scope.tenantId, SEED_MARKER_KEY],
      );
      const row = result.rows[0];
      return row ? parseStored(MarkerSchema, row.value, 'demo seed marker') : null;
    });
  }

  async setSeedMarker(marker: { seededAt: string; profile: string }): Promise<void> {
    const valid = validateInput(MarkerSchema, marker, 'demo seed marker');
    await this.ctx.run((tx) =>
      tx.query(
        `INSERT INTO demo_state (tenant_id, key, value, updated_at)
         VALUES ($1, $2, $3::jsonb, $4::timestamptz)
         ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        [this.ctx.scope.tenantId, SEED_MARKER_KEY, toJsonParam(valid), nowIso(this.ctx)],
      ),
    );
  }
}
