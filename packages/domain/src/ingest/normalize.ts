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
import { compareIso, isoFromMs, toMs } from '../util/time';

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

/** One problem found in a bundle, in the shape of the schema's own issues (`path` into the bundle). */
export interface BundleIssue {
  path: (string | number)[];
  message: string;
}

/** Thrown by `normalizeBundle` when a bundle must be rejected rather than persisted. */
export class BundleValidationError extends Error {
  readonly issues: readonly BundleIssue[];

  constructor(issues: readonly BundleIssue[]) {
    super(
      `Invalid case bundle: ${issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
    this.name = 'BundleValidationError';
    this.issues = issues;
  }
}

export const sha256Hex = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * One spelling per instant: whole seconds stay "…Z" (the form the parsers and the synthetic cases
 * use), anything finer is written as milliseconds ("….500Z"), so "…:00Z" and "…:00.000Z" become the
 * same string. Ordering must still be decided by instant (`compareIso`), never by string order.
 * Text that is not a timestamp is returned unchanged.
 */
export function canonicalTimestamp(iso: string): string {
  const ms = toMs(iso);
  return Number.isFinite(ms) ? isoFromMs(ms).replace('.000Z', 'Z') : iso;
}

/**
 * A reply or declared repeat must point at an event that comes strictly earlier in the order the
 * platform assigns (timestamp, then position in the file). Forward and self references would let a
 * later event change how an earlier one is classified. References to unknown ids are the bundle
 * schema's concern and are not reported here.
 */
function findNonCausalReferences(
  ordered: readonly { event: CaseBundle['events'][number]; index: number }[],
): BundleIssue[] {
  const position = new Map(ordered.map(({ event }, p) => [event.id, p]));
  const issues: BundleIssue[] = [];
  ordered.forEach(({ event, index }, p) => {
    const refs = [
      { ref: event.inResponseTo, field: 'inResponseTo', path: ['events', index, 'inResponseTo'] },
      {
        ref: event.action?.repeatOf,
        field: 'repeatOf',
        path: ['events', index, 'action', 'repeatOf'],
      },
    ];
    for (const { ref, field, path } of refs) {
      const target = ref === undefined || ref === null ? undefined : position.get(ref);
      if (target !== undefined && target >= p) {
        issues.push({
          path,
          message: `${field} must point at an earlier event, but "${ref}" is not earlier than "${event.id}"`,
        });
      }
    }
  });
  return issues;
}

/**
 * Turns a validated (and already redacted) bundle into the immutable records that are persisted.
 * Pure: ids, timestamps and hashes come from the context so tests are reproducible. Timestamps are
 * canonicalised; a bundle whose replies point at later events is rejected with a
 * `BundleValidationError`.
 */
export function normalizeBundle(bundle: CaseBundle, ctx: NormalizeContext): NormalizedCase {
  const participantById = new Map(bundle.participants.map((p) => [p.id, p]));
  const indexed = bundle.events.map((event, index) => ({ event, index }));
  indexed.sort((a, b) => compareIso(a.event.timestamp, b.event.timestamp) || a.index - b.index);
  const nonCausal = findNonCausalReferences(indexed);
  if (nonCausal.length > 0) throw new BundleValidationError(nonCausal);

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
      timestamp: canonicalTimestamp(event.timestamp),
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
        resolvedAt: canonicalTimestamp(bundle.resolution.resolvedAt),
        summary: bundle.resolution.summary,
        rootCause: bundle.resolution.rootCause,
        workaround: bundle.resolution.workaround ?? null,
        permanentFix: bundle.resolution.permanentFix ?? null,
        rootCauseHypothesisKey: bundle.resolution.rootCauseHypothesisKey ?? null,
        validation: bundle.resolution.validation
          ? {
              validatedAt: canonicalTimestamp(bundle.resolution.validation.validatedAt),
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
    openedAt: canonicalTimestamp(bundle.case.openedAt),
    closedAt: bundle.case.closedAt ? canonicalTimestamp(bundle.case.closedAt) : null,
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
