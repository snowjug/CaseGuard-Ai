import { IdSchema } from '@caseguard/schemas';
import { z } from 'zod';
import { NotFoundError, ValidationFailedError } from '../../errors';
import { toJsonParam } from '../normalize';
import { nowIso, parseStored, type RepoContext } from './support';
import type {
  CompleteIdempotentOptions,
  IdempotencyBegin,
  IdempotencyRepository,
  SqlExecutor,
} from './types';

/** Largest response body kept for replay. */
export const MAX_IDEMPOTENT_RESPONSE_BYTES = 1_048_576;
/** Keys one `purgeExpired` call removes by default, and the most it may be asked to. */
export const DEFAULT_PURGE_BATCH = 1_000;
export const MAX_PURGE_BATCH = 10_000;

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

function invalidCaseId(): ValidationFailedError {
  return new ValidationFailedError('Invalid case id', [
    { path: 'caseId', message: 'Expected a case id' },
  ]);
}

/**
 * Pattern for "the stored response mentions this id": the id as a whole word, delimited by anything
 * that cannot be part of an id (a JSON quote, a slash in a link). `case_1` does not match `case_10`.
 * Every regular-expression character of the id is escaped, whatever it is.
 */
function mentionPattern(caseId: string): string {
  return `(^|[^A-Za-z0-9_.:-])${caseId.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}([^A-Za-z0-9_.:-]|$)`;
}

/**
 * Removes the idempotent responses about `caseId` of one tenant and returns how many: the keys linked
 * to the case by `complete(..., { caseId })` (an index lookup) and the completed keys without a link
 * whose response mentions the case. Shared by `purgeForCase` and `CaseRepository.delete`.
 */
export async function purgeCaseResponses(
  tx: SqlExecutor,
  tenantId: string,
  caseId: string,
): Promise<number> {
  const linked = await tx.query(
    'DELETE FROM idempotency_keys WHERE tenant_id = $1 AND case_id = $2',
    [tenantId, caseId],
  );
  const unlinked = await tx.query(
    `DELETE FROM idempotency_keys
      WHERE tenant_id = $1 AND case_id IS NULL AND state = 'completed' AND response::text ~ $2`,
    [tenantId, mentionPattern(caseId)],
  );
  return linked.rowCount + unlinked.rowCount;
}

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

  async complete(
    key: string,
    scopeName: string,
    status: number,
    response: unknown,
    options: CompleteIdempotentOptions = {},
  ): Promise<void> {
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      throw new ValidationFailedError('Invalid status for an idempotent response', [
        { path: 'status', message: 'Expected an HTTP status code' },
      ]);
    }
    const caseId = options.caseId ?? null;
    if (caseId !== null && !IdSchema.safeParse(caseId).success) throw invalidCaseId();
    const body = toJsonParam(response === undefined ? null : response);
    if (Buffer.byteLength(body, 'utf8') > MAX_IDEMPOTENT_RESPONSE_BYTES) {
      throw new ValidationFailedError('The response is too large to store for idempotent replay', [
        { path: 'response', message: `At most ${MAX_IDEMPOTENT_RESPONSE_BYTES} bytes` },
      ]);
    }
    const { tenantId } = this.ctx.scope;
    await this.ctx.run(async (tx) => {
      if (caseId !== null) {
        // Holds the case row, so an erasure cannot slip in before this transaction ends (the foreign
        // key takes the same lock); a case that is already gone means the response describes erased data.
        const present = await tx.query(
          'SELECT 1 FROM cases WHERE tenant_id = $1 AND id = $2 FOR KEY SHARE',
          [tenantId, caseId],
        );
        if (present.rowCount === 0) {
          await tx.query(
            `DELETE FROM idempotency_keys
              WHERE tenant_id = $1 AND scope_name = $2 AND key = $3 AND state = 'reserved'`,
            [tenantId, scopeName, key],
          );
          return;
        }
      }
      const result = await tx.query(
        `UPDATE idempotency_keys
            SET state = 'completed', response_status = $4::integer, response = $5::jsonb,
                completed_at = $6::timestamptz, case_id = $7::text
          WHERE tenant_id = $1 AND scope_name = $2 AND key = $3 AND state = 'reserved'`,
        [tenantId, scopeName, key, status, body, nowIso(this.ctx), caseId],
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

  async purgeForCase(caseId: string): Promise<number> {
    if (!IdSchema.safeParse(caseId).success) throw invalidCaseId();
    return this.ctx.run((tx) => purgeCaseResponses(tx, this.ctx.scope.tenantId, caseId));
  }

  async purgeExpired(limit: number = DEFAULT_PURGE_BATCH): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PURGE_BATCH) {
      throw new ValidationFailedError(`limit must be an integer between 1 and ${MAX_PURGE_BATCH}`, [
        { path: 'limit', message: `Use a value between 1 and ${MAX_PURGE_BATCH}` },
      ]);
    }
    const { tenantId } = this.ctx.scope;
    const now = nowIso(this.ctx);
    return this.ctx.run(async (tx) => {
      // The oldest first, through (tenant_id, expires_at); SKIP LOCKED lets two purges share the work.
      // The batch is a MATERIALIZED CTE on purpose: as a subquery of DELETE ... USING (or IN) the
      // planner may re-run it for every row it joins, and every re-run skips the rows this statement
      // has already deleted and takes the next `limit`, so the batch silently grows to everything
      // expired. A CTE with a locking clause is evaluated exactly once.
      const result = await tx.query(
        `WITH expired AS MATERIALIZED (
           SELECT scope_name, key FROM idempotency_keys
            WHERE tenant_id = $1 AND expires_at <= $2::timestamptz
            ORDER BY expires_at
            LIMIT $3::integer
              FOR UPDATE SKIP LOCKED)
         DELETE FROM idempotency_keys k
          USING expired
          WHERE k.tenant_id = $1 AND k.scope_name = expired.scope_name AND k.key = expired.key`,
        [tenantId, now, limit],
      );
      return result.rowCount;
    });
  }
}
