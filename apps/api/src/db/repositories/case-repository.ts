import {
  AnalysisStateSchema,
  CaseEventSchema,
  CaseParticipantSchema,
  CaseResolutionSchema,
  CaseSchema,
  CaseSourceSchema,
  type AnalysisState,
  type Case,
  type CaseEvent,
  type CaseParticipant,
  type CaseResolution,
  type CaseSource,
  type Page,
} from '@caseguard/schemas';
import { z } from 'zod';
import { ValidationFailedError } from '../../errors';
import { decodeCursor, encodeCursor, normalizeLimit, toPage } from '../cursor';
import { sha256Hex } from '../hash';
import { purgeCaseResponses } from './idempotency-repository';
import {
  CASES,
  CASE_EVENTS,
  CASE_PARTICIPANTS,
  CASE_RESOLUTIONS,
  CASE_SOURCES,
} from './table-specs';
import {
  QueryBuilder,
  assertTenant,
  insertRows,
  normalizeInstant,
  nowIso,
  parseStored,
  readCount,
  requireFound,
  updateRow,
  validateInput,
  withErasure,
  type DataRow,
  type RepoContext,
} from './support';
import type {
  CaseCounts,
  CaseListItem,
  CaseListQuery,
  CaseRepository,
  EventQuery,
  IngestCaseInput,
} from './types';

/** Hard cap shared with the database (`cases_event_count_chk`, `case_events_sequence_chk`). */
export const MAX_EVENTS_PER_CASE = 2000;

const IndexRowSchema = z.object({
  id: z.string(),
  reference: z.string(),
  title: z.string(),
  product: z.string(),
  workload: z.string(),
});

/** What can be looked up as a reference: any text a case could carry, minus control characters. */
const ReferenceLookupSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !/\p{Cc}/u.test(value), 'Control characters are not allowed');

interface PreparedIngest {
  caseRecord: Case;
  source: CaseSource;
  participants: CaseParticipant[];
  events: CaseEvent[];
  resolution: CaseResolution | null;
  storedPayload: string;
}

function toListItem(record: Case): CaseListItem {
  return {
    id: record.id,
    reference: record.reference,
    title: record.title,
    product: record.product,
    workload: record.workload,
    severity: record.severity,
    status: record.status,
    customerAlias: record.customerAlias,
    openedAt: record.openedAt,
    closedAt: record.closedAt,
    synthetic: record.synthetic,
    eventCount: record.eventCount,
    analysisState: record.analysisState,
    analyzedAt: record.analyzedAt,
    hasResolution: record.hasResolution,
    injectionDetected: record.injectionDetected,
  };
}

function fail(path: string, message: string): never {
  throw new ValidationFailedError(`Invalid case ingest input: ${message}`, [{ path, message }]);
}

export class CaseRepositoryImpl implements CaseRepository {
  constructor(private readonly ctx: RepoContext) {}

  /** Validates the bundle as a whole before anything is written (nothing partial is ever stored). */
  private prepareIngest(input: IngestCaseInput): PreparedIngest {
    if (input.events.length > MAX_EVENTS_PER_CASE) {
      fail('events', `A case may contain at most ${MAX_EVENTS_PER_CASE} events`);
    }
    const caseRecord = validateInput(CaseSchema, input.case, 'case');
    const source = validateInput(CaseSourceSchema, input.source, 'case source');
    const participants = validateInput(
      z.array(CaseParticipantSchema),
      input.participants,
      'participants',
    );
    const events = validateInput(z.array(CaseEventSchema), input.events, 'events');
    const resolution =
      input.resolution === null
        ? null
        : validateInput(CaseResolutionSchema, input.resolution, 'case resolution');

    assertTenant(this.ctx, caseRecord.tenantId);
    assertTenant(this.ctx, source.tenantId);
    events.forEach((event) => assertTenant(this.ctx, event.tenantId));

    if (source.caseId !== caseRecord.id)
      fail('source.caseId', 'The source belongs to another case');
    if (caseRecord.sourceId !== source.id)
      fail('case.sourceId', 'The case points at another source');
    if (caseRecord.eventCount !== events.length) {
      fail('case.eventCount', 'eventCount does not match the number of events');
    }
    if (caseRecord.hasResolution !== (resolution !== null)) {
      fail('case.hasResolution', 'hasResolution does not match the resolution');
    }
    if (resolution && resolution.caseId !== caseRecord.id) {
      fail('resolution.caseId', 'The resolution belongs to another case');
    }
    const participantIds = new Set<string>();
    for (const participant of participants) {
      if (participantIds.has(participant.id))
        fail('participants', `Duplicate participant ${participant.id}`);
      participantIds.add(participant.id);
    }
    const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
    const eventIds = new Set<string>();
    ordered.forEach((event, index) => {
      if (event.caseId !== caseRecord.id)
        fail(`events.${index}.caseId`, 'The event belongs to another case');
      if (event.sourceId !== source.id)
        fail(`events.${index}.sourceId`, 'The event points at another source');
      if (event.sequence !== index)
        fail(`events.${index}.sequence`, 'Sequences must be zero-based and gap-free');
      if (eventIds.has(event.id)) fail(`events.${index}.id`, `Duplicate event ${event.id}`);
      eventIds.add(event.id);
      if (!participantIds.has(event.participantId)) {
        fail(`events.${index}.participantId`, `Unknown participant ${event.participantId}`);
      }
      const previous = ordered[index - 1];
      if (previous && Date.parse(previous.timestamp) > Date.parse(event.timestamp)) {
        fail(`events.${index}.timestamp`, 'Events must be ordered by timestamp, then source order');
      }
    });
    if (sha256Hex(input.storedPayload) !== source.storedSha256) {
      fail('source.storedSha256', 'storedSha256 does not match the SHA-256 of storedPayload');
    }
    return {
      caseRecord,
      source,
      participants,
      events: ordered,
      resolution,
      storedPayload: input.storedPayload,
    };
  }

  async ingest(input: IngestCaseInput): Promise<{ case: Case; created: boolean }> {
    const prepared = this.prepareIngest(input);
    const { tenantId } = this.ctx.scope;
    return this.ctx.run(async (tx) => {
      if (this.ctx.kind === 'pg') {
        // Serialises concurrent ingests of the same content so the idempotency check cannot race.
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1::text))', [
          `ingest:${tenantId}:${prepared.source.receivedSha256}`,
        ]);
      }
      const existing = await tx.query<DataRow>(
        `SELECT c.data FROM case_sources s
           JOIN cases c ON c.tenant_id = s.tenant_id AND c.id = s.case_id
          WHERE s.tenant_id = $1 AND s.received_sha256 = $2`,
        [tenantId, prepared.source.receivedSha256],
      );
      const found = existing.rows[0];
      if (found) return { case: parseStored(CaseSchema, found.data, 'case'), created: false };

      const createdAt = prepared.caseRecord.createdAt;
      await insertRows(tx, CASES, [prepared.caseRecord]);
      await insertRows(tx, CASE_SOURCES, [
        { source: prepared.source, payload: prepared.storedPayload },
      ]);
      await insertRows(
        tx,
        CASE_PARTICIPANTS,
        prepared.participants.map((participant) => ({
          tenantId,
          caseId: prepared.caseRecord.id,
          participant,
          createdAt,
        })),
      );
      await insertRows(tx, CASE_EVENTS, prepared.events);
      if (prepared.resolution) {
        await insertRows(tx, CASE_RESOLUTIONS, [
          {
            tenantId,
            resolution: prepared.resolution,
            createdAt,
            createdBy: prepared.caseRecord.createdBy,
          },
        ]);
      }
      return { case: prepared.caseRecord, created: true };
    });
  }

  async findByContentHash(contentHash: string): Promise<Case | null> {
    const { tenantId } = this.ctx.scope;
    return this.ctx.run(async (tx) => {
      const result = await tx.query<DataRow>(
        `SELECT data FROM cases WHERE tenant_id = $1 AND content_hash = $2
          ORDER BY created_at, id LIMIT 1`,
        [tenantId, contentHash],
      );
      const row = result.rows[0];
      if (row) return parseStored(CaseSchema, row.data, 'case');
      const bySource = await tx.query<DataRow>(
        `SELECT c.data FROM case_sources s
           JOIN cases c ON c.tenant_id = s.tenant_id AND c.id = s.case_id
          WHERE s.tenant_id = $1 AND s.received_sha256 = $2`,
        [tenantId, contentHash],
      );
      const sourceRow = bySource.rows[0];
      return sourceRow ? parseStored(CaseSchema, sourceRow.data, 'case') : null;
    });
  }

  async findByReference(reference: string): Promise<Case | null> {
    const exact = validateInput(ReferenceLookupSchema, reference, 'case reference');
    return this.ctx.run(async (tx) => {
      const result = await tx.query<DataRow>(
        'SELECT data FROM cases WHERE tenant_id = $1 AND reference = $2',
        [this.ctx.scope.tenantId, exact],
      );
      const row = result.rows[0];
      return row ? parseStored(CaseSchema, row.data, 'case') : null;
    });
  }

  async list(query: CaseListQuery): Promise<Page<CaseListItem>> {
    const limit = normalizeLimit(query.limit);
    const cursor = decodeCursor('cases', query.cursor, ['timestamp', 'text']);
    const q = new QueryBuilder();
    q.where(`tenant_id = ${q.bind(this.ctx.scope.tenantId)}`);
    if (query.status) q.where(`status = ${q.bind(query.status)}`);
    if (query.workload) q.where(`workload = ${q.bind(query.workload)}`);
    if (query.analysisState) {
      q.where(
        `analysis_state = ${q.bind(validateInput(AnalysisStateSchema, query.analysisState, 'analysisState'))}`,
      );
    }
    const needle = query.q?.trim();
    if (needle) {
      const p = q.bind(needle);
      q.where(
        `(strpos(lower(title), lower(${p}::text)) > 0 OR strpos(lower(reference), lower(${p}::text)) > 0
          OR strpos(lower(product), lower(${p}::text)) > 0 OR strpos(lower(customer_alias), lower(${p}::text)) > 0
          OR strpos(lower(workload), lower(${p}::text)) > 0)`,
      );
    }
    if (cursor) {
      q.where(`(opened_at, id) < (${q.bind(cursor[0])}::timestamptz, ${q.bind(cursor[1])}::text)`);
    }
    const limitParam = q.bind(limit + 1);
    const rows = await this.ctx.run(async (tx) => {
      const result = await tx.query<DataRow & { sort_ts: string; id: string }>(
        `SELECT data, opened_at AS sort_ts, id FROM cases WHERE ${q.clause}
          ORDER BY opened_at DESC, id DESC LIMIT ${limitParam}::integer`,
        q.params,
      );
      return result.rows;
    });
    return toPage(
      rows,
      limit,
      (row) => toListItem(parseStored(CaseSchema, row.data, 'case')),
      (row) => encodeCursor('cases', [row.sort_ts, row.id]),
    );
  }

  async get(caseId: string): Promise<Case | null> {
    return this.ctx.run(async (tx) => {
      const result = await tx.query<DataRow>(
        'SELECT data FROM cases WHERE tenant_id = $1 AND id = $2',
        [this.ctx.scope.tenantId, caseId],
      );
      const row = result.rows[0];
      return row ? parseStored(CaseSchema, row.data, 'case') : null;
    });
  }

  async getSource(caseId: string): Promise<CaseSource | null> {
    return this.ctx.run(async (tx) => {
      const result = await tx.query<DataRow>(
        'SELECT data FROM case_sources WHERE tenant_id = $1 AND case_id = $2',
        [this.ctx.scope.tenantId, caseId],
      );
      const row = result.rows[0];
      return row ? parseStored(CaseSourceSchema, row.data, 'case source') : null;
    });
  }

  async getParticipants(caseId: string): Promise<CaseParticipant[]> {
    return this.ctx.run(async (tx) => {
      const result = await tx.query<DataRow>(
        `SELECT data FROM case_participants WHERE tenant_id = $1 AND case_id = $2
          ORDER BY first_seen_at NULLS LAST, id`,
        [this.ctx.scope.tenantId, caseId],
      );
      return result.rows.map((row) =>
        parseStored(CaseParticipantSchema, row.data, 'case participant'),
      );
    });
  }

  async getResolution(caseId: string): Promise<CaseResolution | null> {
    return this.ctx.run(async (tx) => {
      const result = await tx.query<DataRow>(
        'SELECT data FROM case_resolutions WHERE tenant_id = $1 AND case_id = $2',
        [this.ctx.scope.tenantId, caseId],
      );
      const row = result.rows[0];
      return row ? parseStored(CaseResolutionSchema, row.data, 'case resolution') : null;
    });
  }

  async listEvents(
    caseId: string,
    query: EventQuery & { limit: number },
  ): Promise<Page<CaseEvent>> {
    const limit = normalizeLimit(query.limit);
    const cursor = decodeCursor('events', query.cursor, ['timestamp', 'int']);
    const q = new QueryBuilder();
    q.where(`tenant_id = ${q.bind(this.ctx.scope.tenantId)}`);
    q.where(`case_id = ${q.bind(caseId)}`);
    if (query.asOf)
      q.where(`event_ts <= ${q.bind(normalizeInstant(query.asOf, 'asOf'))}::timestamptz`);
    if (query.from)
      q.where(`event_ts >= ${q.bind(normalizeInstant(query.from, 'from'))}::timestamptz`);
    if (query.to) q.where(`event_ts <= ${q.bind(normalizeInstant(query.to, 'to'))}::timestamptz`);
    if (cursor) {
      q.where(
        `(event_ts, sequence) > (${q.bind(cursor[0])}::timestamptz, ${q.bind(cursor[1])}::integer)`,
      );
    }
    const limitParam = q.bind(limit + 1);
    const rows = await this.ctx.run(async (tx) => {
      const result = await tx.query<DataRow & { sort_ts: string; sequence: number }>(
        `SELECT data, event_ts AS sort_ts, sequence FROM case_events WHERE ${q.clause}
          ORDER BY event_ts, sequence LIMIT ${limitParam}::integer`,
        q.params,
      );
      return result.rows;
    });
    return toPage(
      rows,
      limit,
      (row) => parseStored(CaseEventSchema, row.data, 'case event'),
      (row) => encodeCursor('events', [row.sort_ts, row.sequence]),
    );
  }

  async getAllEvents(
    caseId: string,
    query: { asOf?: string | undefined } = {},
  ): Promise<CaseEvent[]> {
    const q = new QueryBuilder();
    q.where(`tenant_id = ${q.bind(this.ctx.scope.tenantId)}`);
    q.where(`case_id = ${q.bind(caseId)}`);
    if (query.asOf)
      q.where(`event_ts <= ${q.bind(normalizeInstant(query.asOf, 'asOf'))}::timestamptz`);
    return this.ctx.run(async (tx) => {
      const result = await tx.query<DataRow>(
        `SELECT data FROM case_events WHERE ${q.clause} ORDER BY event_ts, sequence LIMIT ${MAX_EVENTS_PER_CASE}`,
        q.params,
      );
      return result.rows.map((row) => parseStored(CaseEventSchema, row.data, 'case event'));
    });
  }

  async getEvent(caseId: string, eventId: string): Promise<CaseEvent | null> {
    return this.ctx.run(async (tx) => {
      const result = await tx.query<DataRow>(
        'SELECT data FROM case_events WHERE tenant_id = $1 AND case_id = $2 AND id = $3',
        [this.ctx.scope.tenantId, caseId, eventId],
      );
      const row = result.rows[0];
      return row ? parseStored(CaseEventSchema, row.data, 'case event') : null;
    });
  }

  async countEventsAfter(caseId: string, asOf: string): Promise<number> {
    const boundary = normalizeInstant(asOf, 'asOf');
    return this.ctx.run((tx) =>
      readCount(
        tx,
        `SELECT count(*)::int AS n FROM case_events
          WHERE tenant_id = $1 AND case_id = $2 AND event_ts > $3::timestamptz`,
        [this.ctx.scope.tenantId, caseId, boundary],
      ),
    );
  }

  async counts(): Promise<CaseCounts> {
    return this.ctx.run(async (tx) => {
      const result = await tx.query<{ analysis_state: string; n: number; synthetic_n: number }>(
        `SELECT analysis_state, count(*)::int AS n, (count(*) FILTER (WHERE synthetic))::int AS synthetic_n
           FROM cases WHERE tenant_id = $1 GROUP BY analysis_state`,
        [this.ctx.scope.tenantId],
      );
      const byAnalysisState = Object.fromEntries(
        AnalysisStateSchema.options.map((state) => [state, 0]),
      ) as Record<AnalysisState, number>;
      let total = 0;
      let synthetic = 0;
      for (const row of result.rows) {
        byAnalysisState[parseStored(AnalysisStateSchema, row.analysis_state, 'analysis state')] +=
          row.n;
        total += row.n;
        synthetic += row.synthetic_n;
      }
      return { total, synthetic, byAnalysisState };
    });
  }

  async setAnalysisState(
    caseId: string,
    state: AnalysisState,
    extra: { runId?: string | undefined; analyzedAt?: string | undefined } = {},
  ): Promise<void> {
    const nextState = validateInput(AnalysisStateSchema, state, 'analysis state');
    const analyzedAt = extra.analyzedAt
      ? normalizeInstant(extra.analyzedAt, 'analyzedAt')
      : undefined;
    await this.ctx.run(async (tx) => {
      const result = await tx.query<DataRow & { version: number }>(
        'SELECT data, version FROM cases WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
        [this.ctx.scope.tenantId, caseId],
      );
      const row = requireFound(result.rows[0], 'Case', caseId);
      const current = parseStored(CaseSchema, row.data, 'case');
      const next = CaseSchema.parse({
        ...current,
        analysisState: nextState,
        lastAnalysisRunId: extra.runId ?? current.lastAnalysisRunId,
        analyzedAt: analyzedAt ?? current.analyzedAt,
        updatedAt: nowIso(this.ctx),
        version: row.version + 1,
      });
      await updateRow(tx, CASES, next, {
        columns: [
          'analysis_state',
          'last_analysis_run_id',
          'analyzed_at',
          'updated_at',
          'version',
          'data',
        ],
      });
    });
  }

  async delete(caseId: string): Promise<boolean> {
    const { tenantId } = this.ctx.scope;
    return this.ctx.run((tx) =>
      withErasure(tx, async () => {
        // The cascade also removes the idempotent responses linked to the case (migration 0011).
        const result = await tx.query('DELETE FROM cases WHERE tenant_id = $1 AND id = $2', [
          tenantId,
          caseId,
        ]);
        const erased = result.rowCount > 0;
        // Responses stored without a link are found by content: a retry with the same
        // Idempotency-Key must never replay an erased case.
        if (erased) await purgeCaseResponses(tx, tenantId, caseId);
        return erased;
      }),
    );
  }

  async listForIndexing(
    limit: number,
  ): Promise<
    { id: string; reference: string; title: string; product: string; workload: string }[]
  > {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
      throw new ValidationFailedError('limit must be an integer between 1 and 10000', [
        { path: 'limit', message: 'Use a value between 1 and 10000' },
      ]);
    }
    return this.ctx.run(async (tx) => {
      const result = await tx.query(
        `SELECT id, reference, title, product, workload FROM cases WHERE tenant_id = $1
          ORDER BY opened_at DESC, id DESC LIMIT $2::integer`,
        [this.ctx.scope.tenantId, limit],
      );
      return result.rows.map((row) => parseStored(IndexRowSchema, row, 'case index row'));
    });
  }
}
