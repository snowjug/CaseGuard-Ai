import { createHash } from 'node:crypto';
import type {
  Case,
  CaseBundle,
  CaseEvent,
  CaseParticipant,
  CaseResolution,
  CaseSource,
  RedactionCategory,
  SourceKind,
} from '@caseguard/schemas';
import { compareIso } from '../util/time';

export interface NormalizeContext {
  tenantId: string;
  caseId: string;
  sourceId: string;
  createdBy: string;
  now: string;
  sourceKind: SourceKind;
  /** The redacted payload exactly as it will be stored. */
  storedPayload: string;
  /** SHA-256 of the payload as received (pre-redaction); defaults to the stored hash. */
  receivedSha256?: string;
  fileName?: string | null;
  mediaType?: string;
  storageRef?: string;
  redactionReplacements: number;
  redactionByEventId?: Record<string, { redacted: boolean; categories: RedactionCategory[] }>;
  injectionDetected?: boolean;
}

export interface NormalizedCase {
  case: Case;
  source: CaseSource;
  participants: CaseParticipant[];
  events: CaseEvent[];
  resolution: CaseResolution | null;
}

export const sha256Hex = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Turns a validated (and already redacted) bundle into the immutable records that are persisted.
 * Pure: ids, timestamps and hashes come from the context so tests are reproducible.
 */
export function normalizeBundle(bundle: CaseBundle, ctx: NormalizeContext): NormalizedCase {
  const participantById = new Map(bundle.participants.map((p) => [p.id, p]));
  const indexed = bundle.events.map((event, index) => ({ event, index }));
  indexed.sort((a, b) => compareIso(a.event.timestamp, b.event.timestamp) || a.index - b.index);

  const meta = {
    tenantId: ctx.tenantId,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    createdBy: ctx.createdBy,
    version: 1,
  };

  const events: CaseEvent[] = indexed.map(({ event, index }, sequence) => {
    const participant = participantById.get(event.participantId);
    return {
      ...meta,
      id: event.id,
      caseId: ctx.caseId,
      sourceId: ctx.sourceId,
      sequence,
      timestamp: event.timestamp,
      participantId: event.participantId,
      participantRole: participant?.role ?? 'system',
      participantAlias: participant?.alias ?? 'Unknown participant',
      type: event.type,
      channel: event.channel ?? null,
      title: event.title ?? null,
      body: event.body,
      action: event.action ?? null,
      inResponseTo: event.inResponseTo ?? null,
      correlationIds: event.correlationIds,
      structured: event.structured ?? null,
      ai: event.ai ?? null,
      sourcePointer: `/events/${index}`,
      redaction: ctx.redactionByEventId?.[event.id] ?? { redacted: false, categories: [] },
      immutable: true,
    };
  });

  const participantCounts = new Map<string, { count: number; first: string | null }>();
  for (const e of events) {
    const entry = participantCounts.get(e.participantId) ?? { count: 0, first: null };
    entry.count += 1;
    entry.first = entry.first ?? e.timestamp;
    participantCounts.set(e.participantId, entry);
  }
  const participants: CaseParticipant[] = bundle.participants.map((p) => ({
    id: p.id,
    role: p.role,
    alias: p.alias,
    eventCount: participantCounts.get(p.id)?.count ?? 0,
    firstSeenAt: participantCounts.get(p.id)?.first ?? null,
  }));

  const payload = ctx.storedPayload;
  const storedHash = sha256Hex(payload);
  const source: CaseSource = {
    ...meta,
    id: ctx.sourceId,
    caseId: ctx.caseId,
    kind: ctx.sourceKind,
    fileName: ctx.fileName ?? null,
    mediaType: ctx.mediaType ?? 'application/json',
    sizeBytes: Buffer.byteLength(payload, 'utf8'),
    receivedSha256: ctx.receivedSha256 ?? storedHash,
    storedSha256: storedHash,
    storageRef: ctx.storageRef ?? `${ctx.tenantId}/${ctx.caseId}/${ctx.sourceId}.json`,
    redactionApplied: ctx.redactionReplacements > 0,
    redactionReplacements: ctx.redactionReplacements,
    synthetic: bundle.synthetic,
    immutable: true,
  };

  const resolution: CaseResolution | null = bundle.resolution
    ? {
        caseId: ctx.caseId,
        resolvedAt: bundle.resolution.resolvedAt,
        summary: bundle.resolution.summary,
        rootCause: bundle.resolution.rootCause,
        workaround: bundle.resolution.workaround ?? null,
        permanentFix: bundle.resolution.permanentFix ?? null,
        rootCauseHypothesisKey: bundle.resolution.rootCauseHypothesisKey ?? null,
        validation: bundle.resolution.validation
          ? {
              validatedAt: bundle.resolution.validation.validatedAt,
              method: bundle.resolution.validation.method,
              outcome: bundle.resolution.validation.outcome,
              evidenceEventIds: bundle.resolution.validation.evidenceEventIds,
            }
          : null,
      }
    : null;

  const caseRecord: Case = {
    ...meta,
    id: ctx.caseId,
    reference: bundle.case.reference,
    title: bundle.case.title,
    product: bundle.case.product,
    workload: bundle.case.workload,
    severity: bundle.case.severity,
    status: bundle.case.status,
    customerAlias: bundle.case.customerAlias,
    openedAt: bundle.case.openedAt,
    closedAt: bundle.case.closedAt ?? null,
    synthetic: bundle.synthetic,
    tags: bundle.case.tags,
    eventCount: events.length,
    firstEventAt: events[0]?.timestamp ?? null,
    lastEventAt: events[events.length - 1]?.timestamp ?? null,
    sourceId: ctx.sourceId,
    sourceKind: ctx.sourceKind,
    contentHash: source.receivedSha256,
    redactionApplied: ctx.redactionReplacements > 0,
    redactionReplacements: ctx.redactionReplacements,
    injectionDetected: ctx.injectionDetected ?? false,
    hasResolution: resolution !== null,
    analysisState: 'not_analyzed',
    lastAnalysisRunId: null,
    analyzedAt: null,
  };

  return { case: caseRecord, source, participants, events, resolution };
}
