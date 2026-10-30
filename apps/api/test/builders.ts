import type {
  Case,
  CaseEvent,
  CaseParticipant,
  CaseResolution,
  CaseSource,
} from '@caseguard/schemas';
import { sha256Hex } from '../src/db/hash';
import type { IngestCaseInput } from '../src/db/repositories/types';
import { TENANT_A, T0, at, meta, pad } from './builders-common';

export * from './builders-common';
export * from './builders-analysis';
export * from './builders-ops';

export function buildParticipant(overrides: Partial<CaseParticipant> = {}): CaseParticipant {
  return {
    id: 'p_customer',
    role: 'customer_admin',
    alias: 'Customer Admin 1',
    eventCount: 1,
    firstSeenAt: T0,
    ...overrides,
  };
}

export function buildCaseEvent(overrides: Partial<CaseEvent> = {}): CaseEvent {
  const sequence = overrides.sequence ?? 0;
  return {
    ...meta(overrides.tenantId ?? TENANT_A, at(sequence * 10)),
    id: `evt_${pad(sequence + 1)}`,
    caseId: 'case_alpha',
    sourceId: 'src_case_alpha',
    sequence,
    timestamp: at(sequence * 10),
    participantId: 'p_customer',
    participantRole: 'customer_admin',
    participantAlias: 'Customer Admin 1',
    type: 'customer_email',
    channel: 'email',
    title: `Synthetic event ${sequence + 1}`,
    body: `Synthetic body of event ${sequence + 1}.`,
    action: null,
    inResponseTo: null,
    correlationIds: [],
    structured: null,
    ai: null,
    sourcePointer: `/events/${sequence}`,
    redaction: { redacted: false, categories: [] },
    immutable: true,
    ...overrides,
  };
}

export function buildCaseSource(overrides: Partial<CaseSource> = {}, payload = '{}'): CaseSource {
  const tenantId = overrides.tenantId ?? TENANT_A;
  const caseId = overrides.caseId ?? 'case_alpha';
  const id = overrides.id ?? `src_${caseId}`;
  return {
    ...meta(tenantId),
    id,
    caseId,
    kind: 'json_bundle',
    fileName: 'synthetic-bundle.json',
    mediaType: 'application/json',
    sizeBytes: payload.length,
    receivedSha256: sha256Hex(`received:${tenantId}:${caseId}`),
    storedSha256: sha256Hex(payload),
    storageRef: `${tenantId}/${caseId}/${id}.json`,
    redactionApplied: false,
    redactionReplacements: 0,
    synthetic: true,
    immutable: true,
    ...overrides,
  };
}

const DEFAULT_CASE_ID = 'case_alpha';

/**
 * The reference a built case gets when none is given. References are unique within a tenant, so it
 * follows the case id: `CG-1001` for the default case (what the tests of one case expect), and
 * `CG-<case id>` for every other.
 */
export function defaultReference(caseId: string): string {
  return caseId === DEFAULT_CASE_ID ? 'CG-1001' : `CG-${caseId}`;
}

export function buildCase(overrides: Partial<Case> = {}): Case {
  const tenantId = overrides.tenantId ?? TENANT_A;
  const id = overrides.id ?? DEFAULT_CASE_ID;
  return {
    ...meta(tenantId),
    id,
    reference: defaultReference(id),
    title: 'Synthetic sign-in failures for a multi-user tenant',
    product: 'Synthetic Collaboration Suite',
    workload: 'teams-authentication',
    severity: 'B',
    status: 'open',
    customerAlias: 'Contoso Synthetic Customer',
    openedAt: T0,
    closedAt: null,
    synthetic: true,
    tags: ['synthetic', 'sign-in'],
    eventCount: 0,
    firstEventAt: null,
    lastEventAt: null,
    sourceId: `src_${id}`,
    sourceKind: 'json_bundle',
    contentHash: sha256Hex(`received:${tenantId}:${id}`),
    redactionApplied: false,
    redactionReplacements: 0,
    injectionDetected: false,
    hasResolution: false,
    analysisState: 'not_analyzed',
    lastAnalysisRunId: null,
    analyzedAt: null,
    ...overrides,
  };
}

export function buildResolution(overrides: Partial<CaseResolution> = {}): CaseResolution {
  return {
    caseId: 'case_alpha',
    resolvedAt: at(70),
    summary: 'Synthetic resolution summary.',
    rootCause: 'Synthetic root cause: a stale proxy rule.',
    workaround: null,
    permanentFix: 'Update the synthetic proxy rule.',
    rootCauseHypothesisKey: 'hyp.proxy',
    validation: {
      validatedAt: at(80),
      method: 'Synthetic validation: sign-in retried by three users.',
      outcome: 'confirmed',
      evidenceEventIds: [],
    },
    ...overrides,
  };
}

export interface IngestOptions {
  tenantId?: string;
  caseId?: string;
  sourceId?: string;
  reference?: string;
  title?: string;
  workload?: string;
  eventCount?: number;
  withResolution?: boolean;
  /** Distinguishes the received-content hash (idempotency key) of otherwise identical bundles. */
  receivedSeed?: string;
  openedAt?: string;
  status?: Case['status'];
}

const EVENT_TYPES: Pick<
  CaseEvent,
  'type' | 'participantId' | 'participantRole' | 'participantAlias'
>[] = [
  {
    type: 'customer_email',
    participantId: 'p_customer',
    participantRole: 'customer_admin',
    participantAlias: 'Customer Admin 1',
  },
  {
    type: 'engineer_email',
    participantId: 'p_engineer',
    participantRole: 'support_engineer',
    participantAlias: 'Support Engineer 1',
  },
  {
    type: 'engineer_action',
    participantId: 'p_engineer',
    participantRole: 'support_engineer',
    participantAlias: 'Support Engineer 1',
  },
  {
    type: 'diagnostic_result',
    participantId: 'p_system',
    participantRole: 'system',
    participantAlias: 'System',
  },
  {
    type: 'customer_email',
    participantId: 'p_customer',
    participantRole: 'customer_admin',
    participantAlias: 'Customer Admin 1',
  },
  {
    type: 'engineer_action',
    participantId: 'p_engineer',
    participantRole: 'support_engineer',
    participantAlias: 'Support Engineer 1',
  },
];

/** A complete, internally consistent ingest request (case, source, participants, events, payload). */
export function buildIngestInput(options: IngestOptions = {}): IngestCaseInput {
  const tenantId = options.tenantId ?? TENANT_A;
  const caseId = options.caseId ?? DEFAULT_CASE_ID;
  const sourceId = options.sourceId ?? `src_${caseId}`;
  const eventCount = options.eventCount ?? 6;
  const withResolution = options.withResolution ?? false;

  const events: CaseEvent[] = Array.from({ length: eventCount }, (_, index) => {
    const shape = EVENT_TYPES[index % EVENT_TYPES.length] ?? EVENT_TYPES[0];
    const isAction = shape?.type === 'engineer_action';
    return buildCaseEvent({
      ...shape,
      tenantId,
      caseId,
      sourceId,
      sequence: index,
      timestamp: at(index * 10),
      createdAt: at(index * 10),
      updatedAt: at(index * 10),
      action: isAction
        ? {
            actionKey: index === 2 ? 'act.signin-log-correlation' : 'act.reset-client-state',
            label: index === 2 ? 'Correlate sign-in logs' : 'Reset client state',
            customerEffort: index === 2 ? 'none' : 'medium',
            destructive: false,
            durationMinutes: 15,
          }
        : null,
    });
  });
  const counts = new Map<string, number>();
  for (const event of events)
    counts.set(event.participantId, (counts.get(event.participantId) ?? 0) + 1);
  const participants: CaseParticipant[] = [
    buildParticipant({ id: 'p_customer', role: 'customer_admin', alias: 'Customer Admin 1' }),
    buildParticipant({ id: 'p_engineer', role: 'support_engineer', alias: 'Support Engineer 1' }),
    buildParticipant({ id: 'p_system', role: 'system', alias: 'System' }),
  ].map((participant) => ({
    ...participant,
    eventCount: counts.get(participant.id) ?? 0,
    firstSeenAt: events.find((event) => event.participantId === participant.id)?.timestamp ?? null,
  }));

  const storedPayload = JSON.stringify({
    synthetic: true,
    caseId,
    events: events.map((event) => ({ id: event.id, timestamp: event.timestamp, body: event.body })),
  });
  const receivedSha256 = sha256Hex(options.receivedSeed ?? `received:${tenantId}:${caseId}`);
  const source = buildCaseSource(
    { tenantId, caseId, id: sourceId, receivedSha256, sizeBytes: storedPayload.length },
    storedPayload,
  );
  const resolution = withResolution
    ? buildResolution({
        caseId,
        resolvedAt: at(eventCount * 10 + 10),
        validation: {
          validatedAt: at(eventCount * 10 + 20),
          method: 'Synthetic validation: sign-in retried by three users.',
          outcome: 'confirmed',
          evidenceEventIds: events.slice(-1).map((event) => event.id),
        },
      })
    : null;
  const caseRecord = buildCase({
    tenantId,
    id: caseId,
    sourceId,
    reference: options.reference ?? defaultReference(caseId),
    title: options.title ?? 'Synthetic sign-in failures for a multi-user tenant',
    workload: options.workload ?? 'teams-authentication',
    openedAt: options.openedAt ?? T0,
    status: options.status ?? (withResolution ? 'resolved' : 'open'),
    closedAt: null,
    eventCount,
    firstEventAt: events[0]?.timestamp ?? null,
    lastEventAt: events[events.length - 1]?.timestamp ?? null,
    contentHash: receivedSha256,
    hasResolution: withResolution,
  });
  return { case: caseRecord, source, participants, events, resolution, storedPayload };
}
