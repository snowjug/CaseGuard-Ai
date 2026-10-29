import {
  AuditEventSchema,
  AuditVerificationSchema,
  IsoTimestampSchema,
  RoleSchema,
  type AuditEvent,
  type AuditVerification,
  type Page,
} from '@caseguard/schemas';
import { z } from 'zod';
import { ValidationFailedError } from '../../errors';
import { decodeCursor, encodeCursor, normalizeLimit, toPage } from '../cursor';
import { canonicalJson, sha256Hex } from '../hash';
import { toJsonParam } from '../normalize';
import { AUDIT_EVENTS } from './table-specs';
import {
  QueryBuilder,
  insertRows,
  normalizeInstant,
  nowIso,
  parseStored,
  validateInput,
  type RepoContext,
} from './support';
import type { AuditAppendInput, AuditQueryInput, AuditRepository } from './types';

/** `prevHash` of the first event of every tenant chain. */
export const AUDIT_GENESIS_HASH = '0'.repeat(64);

/** hash = sha256(prevHash + "\n" + canonicalJson(event without its hash)). */
export function computeAuditHash(prevHash: string, event: Omit<AuditEvent, 'hash'>): string {
  return sha256Hex(`${prevHash}\n${canonicalJson(event)}`);
}

const VERIFY_BATCH = 500;
const MAX_EXPORT = 100_000;

const AppendSchema = z.object({
  actorId: z.string().min(1).max(120),
  actorRole: z.union([RoleSchema, z.literal('system'), z.literal('anonymous')]),
  action: z.string().min(1).max(80),
  targetType: z.string().min(1).max(60),
  targetId: z.string().max(120).nullable(),
  caseId: z.string().min(1).max(120).nullable(),
  outcome: z.enum(['success', 'denied', 'failure']),
  details: z.record(z.string(), z.unknown()),
  correlationId: z.string().min(1).max(80),
  occurredAt: IsoTimestampSchema.optional(),
});

interface AuditRow {
  id: string;
  tenant_id: string;
  sequence: number;
  occurred_at: string;
  actor_id: string;
  actor_role: string;
  action: string;
  target_type: string;
  target_id: string | null;
  case_id: string | null;
  outcome: string;
  details: unknown;
  correlation_id: string;
  prev_hash: string;
  hash: string;
}

const AUDIT_COLUMNS = `id, tenant_id, sequence, occurred_at, actor_id, actor_role, action, target_type,
  target_id, case_id, outcome, details, correlation_id, prev_hash, hash`;

function rowToCandidate(row: AuditRow): Record<string, unknown> {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    sequence: row.sequence,
    occurredAt: row.occurred_at,
    actorId: row.actor_id,
    actorRole: row.actor_role,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    caseId: row.case_id,
    outcome: row.outcome,
    details: row.details,
    correlationId: row.correlation_id,
    prevHash: row.prev_hash,
    hash: row.hash,
  };
}

export class AuditRepositoryImpl implements AuditRepository {
  constructor(private readonly ctx: RepoContext) {}

  async append(input: AuditAppendInput): Promise<AuditEvent> {
    // Hash exactly what will be stored: details are normalised through JSON first.
    const normalizedDetails: unknown = JSON.parse(toJsonParam(input.details));
    const valid = validateInput(
      AppendSchema,
      { ...input, details: normalizedDetails },
      'audit event',
    );
    const occurredAt = valid.occurredAt
      ? normalizeInstant(valid.occurredAt, 'occurredAt')
      : nowIso(this.ctx);
    const { tenantId } = this.ctx.scope;

    return this.ctx.run(async (tx) => {
      if (this.ctx.kind === 'pg') {
        // One appender per tenant at a time; PGlite has a single connection so needs no lock.
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1::text))', [`audit:${tenantId}`]);
      }
      const last = await tx.query<{ sequence: number; hash: string }>(
        'SELECT sequence, hash FROM audit_events WHERE tenant_id = $1 ORDER BY sequence DESC LIMIT 1',
        [tenantId],
      );
      const previous = last.rows[0];
      const prevHash = previous?.hash ?? AUDIT_GENESIS_HASH;
      const unsigned: Omit<AuditEvent, 'hash'> = {
        id: this.ctx.newId('aud'),
        tenantId,
        sequence: (previous?.sequence ?? 0) + 1,
        occurredAt,
        actorId: valid.actorId,
        actorRole: valid.actorRole,
        action: valid.action,
        targetType: valid.targetType,
        targetId: valid.targetId,
        caseId: valid.caseId,
        outcome: valid.outcome,
        details: valid.details,
        correlationId: valid.correlationId,
        prevHash,
      };
      const event = validateInput(
        AuditEventSchema,
        { ...unsigned, hash: computeAuditHash(prevHash, unsigned) },
        'audit event',
      );
      await insertRows(tx, AUDIT_EVENTS, [event]);
      return event;
    });
  }

  async list(query: AuditQueryInput): Promise<Page<AuditEvent>> {
    const limit = normalizeLimit(query.limit);
    const cursor = decodeCursor('audit', query.cursor, ['int']);
    const q = new QueryBuilder();
    q.where(`tenant_id = ${q.bind(this.ctx.scope.tenantId)}`);
    if (query.action) q.where(`action = ${q.bind(query.action)}`);
    if (query.actorId) q.where(`actor_id = ${q.bind(query.actorId)}`);
    if (query.caseId) q.where(`case_id = ${q.bind(query.caseId)}`);
    if (query.outcome) q.where(`outcome = ${q.bind(query.outcome)}`);
    if (query.from)
      q.where(`occurred_at >= ${q.bind(normalizeInstant(query.from, 'from'))}::timestamptz`);
    if (query.to)
      q.where(`occurred_at <= ${q.bind(normalizeInstant(query.to, 'to'))}::timestamptz`);
    if (cursor) q.where(`sequence < ${q.bind(cursor[0])}::integer`);
    const limitParam = q.bind(limit + 1);
    const rows = await this.ctx.run(async (tx) => {
      const result = await tx.query<AuditRow>(
        `SELECT ${AUDIT_COLUMNS} FROM audit_events WHERE ${q.clause}
          ORDER BY sequence DESC LIMIT ${limitParam}::integer`,
        q.params,
      );
      return result.rows;
    });
    return toPage(
      rows,
      limit,
      (row) => parseStored(AuditEventSchema, rowToCandidate(row), 'audit event'),
      (row) => encodeCursor('audit', [row.sequence]),
    );
  }

  /**
   * Walks the whole chain in sequence order and reports the first sequence that is wrong: a gap or
   * reordering (the expected sequence is reported), a broken prevHash link, a hash that does not match
   * the recomputed one, or a row that no longer satisfies the audit schema. A DBA who deletes the tail
   * of a chain is not detectable without an externally anchored head hash.
   */
  async verify(): Promise<AuditVerification> {
    const checkedAt = nowIso(this.ctx);
    const { tenantId } = this.ctx.scope;
    return this.ctx.run(async (tx) => {
      let expectedSequence = 1;
      let prevHash = AUDIT_GENESIS_HASH;
      let checked = 0;
      let after = 0;
      const broken = (sequence: number, detail: string): AuditVerification =>
        AuditVerificationSchema.parse({
          valid: false,
          eventsChecked: checked,
          firstInvalidSequence: sequence,
          checkedAt,
          detail,
        });
      for (;;) {
        const batch = await tx.query<AuditRow>(
          `SELECT ${AUDIT_COLUMNS} FROM audit_events
            WHERE tenant_id = $1 AND sequence > $2::integer ORDER BY sequence LIMIT ${VERIFY_BATCH}`,
          [tenantId, after],
        );
        if (batch.rows.length === 0) break;
        for (const row of batch.rows) {
          if (row.sequence !== expectedSequence) {
            return broken(
              expectedSequence,
              `Sequence gap or reordering: expected ${expectedSequence}, found ${row.sequence}`,
            );
          }
          const parsed = AuditEventSchema.safeParse(rowToCandidate(row));
          if (!parsed.success)
            return broken(row.sequence, `Event ${row.sequence} violates the audit schema`);
          const event = parsed.data;
          if (event.prevHash !== prevHash) {
            return broken(
              row.sequence,
              `Event ${row.sequence} does not link to the previous event`,
            );
          }
          const { hash, ...unsigned } = event;
          if (computeAuditHash(prevHash, unsigned) !== hash) {
            return broken(
              row.sequence,
              `Event ${row.sequence} was modified: its hash does not match`,
            );
          }
          prevHash = hash;
          expectedSequence += 1;
          checked += 1;
          after = row.sequence;
        }
      }
      return AuditVerificationSchema.parse({
        valid: true,
        eventsChecked: checked,
        firstInvalidSequence: null,
        checkedAt,
        detail:
          checked === 0
            ? 'The audit chain is empty'
            : `Verified ${checked} audit events; the hash chain is intact`,
      });
    });
  }

  async listForExport(maxRecords: number): Promise<AuditEvent[]> {
    if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > MAX_EXPORT) {
      throw new ValidationFailedError(`maxRecords must be an integer between 1 and ${MAX_EXPORT}`, [
        { path: 'maxRecords', message: `Use a value between 1 and ${MAX_EXPORT}` },
      ]);
    }
    return this.ctx.run(async (tx) => {
      const result = await tx.query<AuditRow>(
        `SELECT ${AUDIT_COLUMNS} FROM audit_events WHERE tenant_id = $1
          ORDER BY sequence LIMIT $2::integer`,
        [this.ctx.scope.tenantId, maxRecords],
      );
      return result.rows.map((row) =>
        parseStored(AuditEventSchema, rowToCandidate(row), 'audit event'),
      );
    });
  }
}
