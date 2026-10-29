import { z } from 'zod';
import { NotFoundError, ValidationFailedError } from '../../errors';
import { toJsonParam } from '../normalize';
import { nowIso, parseStored, type RepoContext } from './support';
import type { IdempotencyBegin, IdempotencyRepository } from './types';

/** Largest response body kept for replay. */
export const MAX_IDEMPOTENT_RESPONSE_BYTES = 1_048_576;

const KeySchema = z.object({
  key: z.string().min(1).max(255),
  scopeName: z.string().min(1).max(120),
});

interface ExistingRow {
  request_hash: string;
  state: string;
  response_status: number | null;
  response: unknown;
  created_at: string;
}

const ExistingSchema = z.object({
  request_hash: z.string(),
  state: z.enum(['reserved', 'completed']),
  response_status: z.number().nullable(),
  response: z.unknown(),
  created_at: z.string(),
});

export class IdempotencyRepositoryImpl implements IdempotencyRepository {
  constructor(private readonly ctx: RepoContext) {}

  async begin(key: string, scopeName: string, requestHash: string): Promise<IdempotencyBegin> {
    const ids = KeySchema.safeParse({ key, scopeName });
    if (!ids.success || requestHash.length === 0 || requestHash.length > 128) {
      throw new ValidationFailedError('Invalid idempotency key', [
        { path: 'Idempotency-Key', message: 'Use a key of 1-255 characters' },
      ]);
    }
    const { tenantId } = this.ctx.scope;
    const now = this.ctx.now();
    const created = now.toISOString();
    const expires = new Date(now.getTime() + this.ctx.idempotency.ttlMs).toISOString();

    return this.ctx.run(async (tx) => {
      // TTL cleanup: expired keys of this tenant disappear whenever a new key is reserved.
      await tx.query(
        'DELETE FROM idempotency_keys WHERE tenant_id = $1 AND expires_at <= $2::timestamptz',
        [tenantId, created],
      );
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const inserted = await tx.query(
          `INSERT INTO idempotency_keys
             (tenant_id, scope_name, key, request_hash, state, created_at, expires_at)
           VALUES ($1, $2, $3, $4, 'reserved', $5::timestamptz, $6::timestamptz)
           ON CONFLICT (tenant_id, scope_name, key) DO NOTHING`,
          [tenantId, scopeName, key, requestHash, created, expires],
        );
        if (inserted.rowCount === 1) return { state: 'new' };

        const found = await tx.query<ExistingRow>(
          `SELECT request_hash, state, response_status, response, created_at
             FROM idempotency_keys
            WHERE tenant_id = $1 AND scope_name = $2 AND key = $3 FOR UPDATE`,
          [tenantId, scopeName, key],
        );
        const raw = found.rows[0];
        if (!raw) continue; // removed by a concurrent cleanup between the insert and the read
        const row = parseStored(ExistingSchema, raw, 'idempotency record');
        if (row.request_hash !== requestHash) return { state: 'conflict' };
        if (row.state === 'completed') {
          return { state: 'replay', status: row.response_status ?? 200, response: row.response };
        }
        const reservedAt = Date.parse(row.created_at);
        if (reservedAt + this.ctx.idempotency.reservationTtlMs <= now.getTime()) {
          // The request that reserved the key never completed (crashed process): take it over.
          await tx.query(
            `UPDATE idempotency_keys SET created_at = $4::timestamptz, expires_at = $5::timestamptz
              WHERE tenant_id = $1 AND scope_name = $2 AND key = $3 AND state = 'reserved'`,
            [tenantId, scopeName, key, created, expires],
          );
          return { state: 'new' };
        }
        return { state: 'in_progress' };
      }
      throw new ValidationFailedError('The idempotency key could not be reserved; retry', [
        { path: 'Idempotency-Key', message: 'Concurrent requests are using the same key' },
      ]);
    });
  }

  async complete(key: string, scopeName: string, status: number, response: unknown): Promise<void> {
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      throw new ValidationFailedError('Invalid status for an idempotent response', [
        { path: 'status', message: 'Expected an HTTP status code' },
      ]);
    }
    const body = toJsonParam(response === undefined ? null : response);
    if (Buffer.byteLength(body, 'utf8') > MAX_IDEMPOTENT_RESPONSE_BYTES) {
      throw new ValidationFailedError('The response is too large to store for idempotent replay', [
        { path: 'response', message: `At most ${MAX_IDEMPOTENT_RESPONSE_BYTES} bytes` },
      ]);
    }
    await this.ctx.run(async (tx) => {
      const result = await tx.query(
        `UPDATE idempotency_keys
            SET state = 'completed', response_status = $4::integer, response = $5::jsonb,
                completed_at = $6::timestamptz
          WHERE tenant_id = $1 AND scope_name = $2 AND key = $3 AND state = 'reserved'`,
        [this.ctx.scope.tenantId, scopeName, key, status, body, nowIso(this.ctx)],
      );
      if (result.rowCount !== 1) throw new NotFoundError('Idempotency reservation', key);
    });
  }

  async release(key: string, scopeName: string): Promise<void> {
    await this.ctx.run((tx) =>
      tx.query(
        `DELETE FROM idempotency_keys
          WHERE tenant_id = $1 AND scope_name = $2 AND key = $3 AND state = 'reserved'`,
        [this.ctx.scope.tenantId, scopeName, key],
      ),
    );
  }
}
