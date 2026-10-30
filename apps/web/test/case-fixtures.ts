import {
  AnalysisRunSchema,
  CaseDetailSchema,
  ClaimSchema,
  DigitalTwinSchema,
  EventDetailSchema,
  EvidenceLedgerResponseSchema,
  EvidenceSchema,
  ExampleInfoSchema,
  HypothesesResponseSchema,
  HypothesisSchema,
  IngestResultSchema,
  IngestionPreviewSchema,
  JobSchema,
  MissingEvidenceSchema,
  SampleBundleInfoSchema,
  TimelineEventSchema,
  TimelineResponseSchema,
  type AnalysisRun,
  type CaseDetail,
  type Claim,
  type DigitalTwin,
  type EventDetail,
  type Evidence,
  type EvidenceLedgerResponse,
  type ExampleInfo,
  type HypothesesResponse,
  type Hypothesis,
  type IngestResult,
  type IngestionPreview,
  type Job,
  type MissingEvidence,
  type SampleBundleInfo,
  type TimelineEvent,
  type TimelineResponse,
} from '@caseguard/schemas';
import { ApiError } from '../src/lib/api/errors';
import { NOW, caseSummary } from './fixtures';

/**
 * Fixtures for the case pages (cases, ingestion, overview, timeline, ledger). Each factory validates its result with
 * the real Zod schema, so a fixture can never drift from the contract the UI consumes.
 */

export const CASE_ID = 'case_1';
export const RUN_ID = 'run_1';

/**
 * The 409 the API answers for a view of a case that has never been analysed, as the API sends it: `code: conflict` with
 * the stable `reason: not_analysed` (docs/API.md, reason tokens), and the sentence in `detail` (the error's message).
 */
export function notAnalysedError(): ApiError {
  return new ApiError({
    status: 409,
    code: 'conflict',
    reason: 'not_analysed',
    title: 'Conflict',
    message: 'This case has not been analysed yet. Start an analysis first.',
    correlationId: 'req_not_analysed',
  });
}

const meta = {
  tenantId: 'tenant_demo',
  createdAt: NOW,
  updatedAt: NOW,
  createdBy: 'synthetic',
  version: 1,
};

export function caseDetail(overrides: Partial<CaseDetail> = {}): CaseDetail {
  const base = {
    ...meta,
    id: CASE_ID,
    reference: 'CG-SYN-1001',
    title: 'Intermittent Teams sign-in failures for about 140 branch users',
    product: 'Microsoft Teams',
    workload: 'teams-authentication',
    severity: 'A',
    status: 'resolved',
    customerAlias: 'Contoso Synthetic Ltd',
    openedAt: '2026-03-09T09:12:00Z',
    closedAt: '2026-03-12T10:20:00Z',
    synthetic: true,
    tags: ['synthetic', 'authentication'],
    eventCount: 31,
    firstEventAt: '2026-03-09T09:12:00Z',
    lastEventAt: '2026-03-12T10:20:00Z',
    sourceId: 'src_1',
    sourceKind: 'builtin_sample',
    contentHash: 'a'.repeat(64),
    redactionApplied: false,
    redactionReplacements: 0,
    injectionDetected: false,
    hasResolution: true,
    analysisState: 'analyzed',
    lastAnalysisRunId: RUN_ID,
    analyzedAt: NOW,
    participants: [
      {
        id: 'p-cust',
        role: 'customer_admin',
        alias: 'Customer IT Admin 1',
        eventCount: 6,
        firstSeenAt: '2026-03-09T09:12:00Z',
      },
    ],
    source: {
      id: 'src_1',
      kind: 'builtin_sample',
      fileName: 'case-one.json',
      mediaType: 'application/json',
      sizeBytes: 22769,
      receivedSha256: 'b'.repeat(64),
      storedSha256: 'b'.repeat(64),
      redactionApplied: false,
      redactionReplacements: 0,
      synthetic: true,
    },
    resolution: {
      caseId: CASE_ID,
      resolvedAt: '2026-03-12T10:05:00Z',
      summary: 'A DNS policy update on one resolver blocked a CDN host.',
      rootCause: 'The DNS security policy on resolver 10.20.1.11 blocked the CDN category.',
      workaround: 'Removed the resolver from the DHCP scopes.',
      permanentFix: 'Added a DNS exception for Microsoft 365 endpoints.',
      rootCauseHypothesisKey: 'hyp.dns-resolution',
      validation: {
        validatedAt: '2026-03-12T09:40:00Z',
        method: '200 consecutive queries per resolver succeeded.',
        outcome: 'confirmed',
        evidenceEventIds: ['e28'],
      },
    },
    ...overrides,
  };
  return CaseDetailSchema.parse(base);
}

export function analysisRun(overrides: Partial<AnalysisRun> = {}): AnalysisRun {
  return AnalysisRunSchema.parse({
    ...meta,
    id: RUN_ID,
    caseId: CASE_ID,
    status: 'succeeded',
    provider: 'deterministic',
    model: 'deterministic-knowledge-pack',
    simulated: true,
    knowledgePackId: 'kp.teams-authentication',
    knowledgePackVersion: '1.0.0',
    qualityConfigVersion: '1.0.0',
    actionValueConfigVersion: '1.0.0',
    inputHash: 'c'.repeat(64),
    startedAt: NOW,
    completedAt: NOW,
    counts: {
      events: 31,
      evidence: 26,
      claims: 61,
      hypotheses: 9,
      actions: 11,
      forks: 9,
      warnings: 14,
      modelExecutions: 6,
    },
    error: null,
    ...overrides,
  });
}

export function job(overrides: Partial<Job> = {}): Job {
  const stages = [
    { id: 'load', label: 'Load the case record', status: 'done' },
    { id: 'analyse', label: 'Classify evidence and rank hypotheses', status: 'running' },
    { id: 'save', label: 'Save results', status: 'pending' },
  ].map((stage) => ({
    ...stage,
    startedAt: null,
    completedAt: stage.status === 'done' ? NOW : null,
    detail: null,
  }));
  return JobSchema.parse({
    id: 'job_1',
    tenantId: 'tenant_demo',
    kind: 'case_analysis',
    status: 'running',
    caseId: CASE_ID,
    targetId: null,
    progress: { percent: 40, stage: 'analyse', stages },
    error: null,
    resultRef: null,
    idempotencyKey: null,
    createdAt: NOW,
    startedAt: NOW,
    completedAt: null,
    createdBy: 'user_ava_engineer',
    cancellable: true,
    ...overrides,
  });
}

/** A finished job: every stage done, 100 percent. */
export function finishedJob(overrides: Partial<Job> = {}): Job {
  const base = job();
  return job({
    status: 'succeeded',
    completedAt: NOW,
    cancellable: false,
    resultRef: { type: 'analysis_run', id: RUN_ID },
    progress: {
      percent: 100,
      stage: 'save',
      stages: base.progress.stages.map((stage) => ({ ...stage, status: 'done', completedAt: NOW })),
    },
    ...overrides,
  });
}

export function sample(overrides: Partial<SampleBundleInfo> = {}): SampleBundleInfo {
  return SampleBundleInfoSchema.parse({
    id: 'case-one-teams-signin-dns',
    title: 'Intermittent Teams sign-in failures for about 140 branch users',
    description: 'Synthetic multi-site incident with a DNS root cause.',
    reference: 'CG-SYN-1001',
    workload: 'teams-authentication',
    eventCount: 31,
    synthetic: true,
    role: 'primary',
    ...overrides,
  });
}

export function example(overrides: Partial<ExampleInfo> = {}): ExampleInfo {
  return ExampleInfoSchema.parse({
    id: 'minimal-bundle',
    title: 'Minimal case bundle (JSON)',
    description: 'The smallest valid bundle.',
    fileName: 'minimal-case-bundle.json',
    kind: 'case_bundle',
    sizeBytes: 1200,
    synthetic: true,
    ...overrides,
  });
}

export function preview(overrides: Partial<IngestionPreview> = {}): IngestionPreview {
  return IngestionPreviewSchema.parse({
    ok: true,
    sourceKind: 'builtin_sample',
    contentHash: 'd'.repeat(64),
    sizeBytes: 22769,
    synthetic: true,
    issues: [],
    redaction: { applied: false, totalReplacements: 0, findings: [] },
    injection: { detected: false, highestSeverity: 'none', findings: [] },
    summary: {
      reference: 'CG-SYN-1001',
      title: 'Intermittent Teams sign-in failures for about 140 branch users',
      product: 'Microsoft Teams',
      workload: 'teams-authentication',
      eventCount: 31,
      participantCount: 6,
      firstEventAt: '2026-03-09T09:12:00Z',
      lastEventAt: '2026-03-12T10:20:00Z',
      hasResolution: true,
      durationHours: 73.1,
    },
    eventsPreview: [
      {
        id: 'e01',
        timestamp: '2026-03-09T09:12:00Z',
        type: 'customer_email',
        participantRole: 'customer_admin',
        title: 'Teams sign-in failing intermittently',
        bodyExcerpt: 'Since about 08:50 UTC roughly 140 users cannot sign in.',
      },
    ],
    alreadyIngestedCaseId: null,
    ...overrides,
  });
}

export function ingestResult(overrides: Partial<IngestResult> = {}): IngestResult {
  return IngestResultSchema.parse({
    case: caseSummary({
      id: CASE_ID,
      reference: 'CG-SYN-1001',
      title: 'Intermittent Teams sign-in failures for about 140 branch users',
      analysisState: 'queued',
      analyzedAt: null,
      qualityIndex: null,
      avoidableEffortPct: null,
      leadingHypothesis: null,
      openWarningCount: 0,
    }),
    sourceId: 'src_1',
    eventCount: 31,
    created: true,
    preview: {
      redaction: { applied: false, totalReplacements: 0, findings: [] },
      injection: { detected: false, highestSeverity: 'none', findings: [] },
      issues: [],
    },
    analysisJob: job({
      status: 'queued',
      progress: { percent: 0, stage: 'load', stages: job().progress.stages },
    }),
    ...overrides,
  });
}

// ---------------------------------------------------------------- timeline

export function timelineEvent(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return TimelineEventSchema.parse({
    id: 'e01',
    sequence: 0,
    timestamp: '2026-03-09T09:12:00Z',
    type: 'customer_email',
    participantRole: 'customer_admin',
    participantAlias: 'Customer IT Admin 1',
    title: 'Teams sign-in failing intermittently',
    bodyExcerpt: 'Since about 08:50 UTC roughly 140 users cannot sign in to Teams.',
    bodyTruncated: false,
    actionKey: null,
    actionLabel: null,
    actionKind: null,
    customerEffort: null,
    destructive: false,
    gapMinutes: null,
    isDelay: false,
    isRepeatedDiagnostic: false,
    forkIds: [],
    claimIds: [],
    evidenceIds: [],
    categories: [],
    hypothesisEffects: [],
    aiTokens: null,
    simulated: false,
    ...overrides,
  });
}

/** Three recorded events: a customer email, an engineer request that is a decision fork, and a late reply (a delay). */
export function threeEvents(): TimelineEvent[] {
  return [
    timelineEvent({ categories: ['customer_reported'] }),
    timelineEvent({
      id: 'e03',
      sequence: 1,
      timestamp: '2026-03-09T09:41:00Z',
      type: 'engineer_email',
      participantRole: 'support_engineer',
      participantAlias: 'Support Engineer 1',
      title: 'Teams sign-in - information needed',
      bodyExcerpt: 'Please send a HAR capture and a Fiddler trace.',
      actionKey: 'act.request-har-capture',
      actionLabel: 'Request HAR and Fiddler traces',
      actionKind: 'customer_request',
      customerEffort: 'very_high',
      gapMinutes: 29,
      forkIds: ['fork_1'],
      hypothesisEffects: [{ hypothesisId: 'hyp_1', delta: -0.107 }],
    }),
    timelineEvent({
      id: 'e05',
      sequence: 2,
      timestamp: '2026-03-10T08:55:00Z',
      type: 'engineer_action',
      participantRole: 'support_engineer',
      participantAlias: 'Support Engineer 1',
      title: 'Repeat sign-in log query',
      bodyExcerpt: 'Ran the same query again with a wider window.',
      actionKey: 'act.signin-log-correlation',
      actionLabel: 'Sign-in log correlation',
      actionKind: 'log_query',
      customerEffort: 'none',
      gapMinutes: 1394,
      isDelay: true,
      isRepeatedDiagnostic: true,
    }),
  ];
}

export function timelineResponse(overrides: Partial<TimelineResponse> = {}): TimelineResponse {
  const events = threeEvents();
  return TimelineResponseSchema.parse({
    caseId: CASE_ID,
    asOf: null,
    openedAt: '2026-03-09T09:12:00Z',
    events,
    nextCursor: null,
    total: events.length,
    simulatedEvents: [],
    delays: [
      {
        fromEventId: 'e03',
        toEventId: 'e05',
        minutes: 1394,
        reason: 'The customer waited 23 h 14 min for a reply.',
      },
    ],
    repeats: [{ eventId: 'e05', repeatOfEventId: 'e03', actionKey: 'act.signin-log-correlation' }],
    hypothesisSeries: [
      {
        hypothesisId: 'hyp_1',
        key: 'hyp.dns-resolution',
        name: 'DNS resolution failure for sign-in endpoints',
        points: [
          { at: '2026-03-09T09:12:00Z', confidence: 0.18 },
          { at: '2026-03-09T09:41:00Z', confidence: 0.72 },
          { at: '2026-03-10T08:55:00Z', confidence: 0.83 },
        ],
      },
      {
        hypothesisId: 'hyp_2',
        key: 'hyp.proxy',
        name: 'Egress proxy or TLS-inspection node failure',
        points: [
          { at: '2026-03-09T09:12:00Z', confidence: 0.1 },
          { at: '2026-03-10T08:55:00Z', confidence: 0.06 },
        ],
      },
    ],
    withheldFutureEventCount: 0,
    knownAtAsOf: {
      evidenceCount: 26,
      claimCount: 61,
      criticalMissingCount: 0,
      openWarningCount: 0,
    },
    ...overrides,
  });
}

/** `count` generic events one hour apart, for virtualisation tests. */
export function manyEvents(count: number): TimelineEvent[] {
  return Array.from({ length: count }, (_, index) =>
    timelineEvent({
      id: `ev${String(index + 1).padStart(4, '0')}`,
      sequence: index,
      timestamp: new Date(Date.parse('2026-03-09T00:00:00Z') + index * 3_600_000).toISOString(),
      title: `Event number ${index + 1}`,
      bodyExcerpt: `Body of event ${index + 1}.`,
      gapMinutes: index === 0 ? null : 60,
    }),
  );
}

export function hypothesis(overrides: Partial<Hypothesis> = {}): Hypothesis {
  return HypothesisSchema.parse({
    ...meta,
    id: 'hyp_1',
    caseId: CASE_ID,
    analysisRunId: RUN_ID,
    key: 'hyp.dns-resolution',
    name: 'DNS resolution failure for sign-in endpoints',
    description: 'A resolver fails to resolve the sign-in CDN host.',
    category: 'network',
    prior: 0.1,
    timeline: [
      {
        at: '2026-03-09T09:12:00Z',
        eventId: 'e01',
        confidence: 0.18,
        low: 0.1,
        high: 0.25,
        status: 'active',
        delta: 0.08,
        reason: 'Rose from 10% to 18%.',
        triggerEvidenceIds: [],
        supportingEvidenceIds: [],
        contradictingEvidenceIds: [],
        missingRequirementIds: [],
        cheapestSafeActionKey: null,
        expectedInformationGainBits: null,
      },
      {
        at: '2026-03-09T09:41:00Z',
        eventId: 'e03',
        confidence: 0.72,
        low: 0.6,
        high: 0.8,
        status: 'leading',
        delta: 0.54,
        reason: 'Rose from 18% to 72%.',
        triggerEvidenceIds: [],
        supportingEvidenceIds: [],
        contradictingEvidenceIds: [],
        missingRequirementIds: [],
        cheapestSafeActionKey: null,
        expectedInformationGainBits: null,
      },
      {
        at: '2026-03-10T08:55:00Z',
        eventId: 'e05',
        confidence: 0.83,
        low: 0.7,
        high: 0.9,
        status: 'leading',
        delta: 0.11,
        reason: 'Rose from 72% to 83%.',
        triggerEvidenceIds: [],
        supportingEvidenceIds: [],
        contradictingEvidenceIds: [],
        missingRequirementIds: [],
        cheapestSafeActionKey: null,
        expectedInformationGainBits: null,
      },
    ],
    currentConfidence: 0.83,
    currentLow: 0.7,
    currentHigh: 0.9,
    currentStatus: 'leading',
    assumptions: [],
    engineerAnchoredAt: null,
    cheapestSafeAction: null,
    modelEstimate: true,
    ...overrides,
  });
}

export function hypothesesResponse(
  overrides: Partial<HypothesesResponse> = {},
): HypothesesResponse {
  return HypothesesResponseSchema.parse({
    caseId: CASE_ID,
    asOf: null,
    items: [
      hypothesis(),
      hypothesis({
        id: 'hyp_2',
        key: 'hyp.proxy',
        name: 'Egress proxy or TLS-inspection node failure',
      }),
    ],
    links: [],
    evidence: [],
    missing: [],
    notice: 'Confidence values are model estimates.',
    ...overrides,
  });
}

export function eventDetail(overrides: Partial<EventDetail> = {}): EventDetail {
  return EventDetailSchema.parse({
    event: {
      ...meta,
      id: 'e03',
      caseId: CASE_ID,
      sourceId: 'src_1',
      sequence: 1,
      timestamp: '2026-03-09T09:41:00Z',
      participantId: 'p-eng',
      participantRole: 'support_engineer',
      participantAlias: 'Support Engineer 1',
      type: 'engineer_email',
      channel: 'email',
      title: 'Teams sign-in - information needed',
      body: 'Hello,\n\nPlease send a HAR capture and a Fiddler trace from three affected users.\n\nRegards',
      action: {
        actionKey: 'act.request-har-capture',
        label: 'Request HAR and Fiddler traces',
        customerEffort: 'very_high',
        destructive: false,
        durationMinutes: 10,
      },
      inResponseTo: null,
      correlationIds: [],
      structured: null,
      ai: { model: 'gpt-synthetic-4', promptTokens: 2100, completionTokens: 450 },
      sourcePointer: '/events/2',
      redaction: { redacted: false, categories: [] },
      immutable: true,
    },
    claims: [claim({ id: 'clm_e03', eventId: 'e03', text: 'Customer must send a HAR capture.' })],
    evidence: [],
    inResponseTo: null,
    responses: [
      {
        id: 'e04',
        timestamp: '2026-03-09T11:05:00Z',
        type: 'customer_email',
        title: 'Re: Teams sign-in - information needed',
      },
    ],
    ...overrides,
  });
}

// ---------------------------------------------------------------- evidence ledger

export function claim(overrides: Partial<Claim> = {}): Claim {
  return ClaimSchema.parse({
    ...meta,
    id: 'clm_1',
    caseId: CASE_ID,
    analysisRunId: RUN_ID,
    text: 'Root cause is the Conditional Access policy that forces interactive MFA.',
    category: 'engineer_assumption',
    aiCategory: 'engineer_assumption',
    reviewedCategory: null,
    reviewState: 'pending',
    reviewReason: null,
    reviewedBy: null,
    reviewedAt: null,
    subject: 'root_cause',
    authorRole: 'support_engineer',
    eventId: 'e03',
    sourceRef: { eventId: 'e03', excerpt: 'Root cause is the Conditional Access policy' },
    timestamp: '2026-03-09T09:41:00Z',
    supportingEvidenceIds: ['evd_1'],
    contradictingEvidenceIds: ['evd_2'],
    relatedHypothesisIds: ['hyp.dns-resolution'],
    confidence: 0.8,
    explanation: 'Stated as established, but the evidence for it is weak.',
    ruleId: 'statement.engineer_assumption',
    flags: ['assumption_as_fact'],
    method: 'rule',
    missingEvidenceId: null,
    simulated: false,
    ...overrides,
  });
}

export function evidenceItem(overrides: Partial<Evidence> = {}): Evidence {
  return EvidenceSchema.parse({
    ...meta,
    id: 'evd_1',
    caseId: CASE_ID,
    analysisRunId: RUN_ID,
    signalId: 'sig.intermittent-failures',
    label: 'Failures are intermittent',
    summary: 'A retry sometimes succeeds.',
    kind: 'presence',
    strength: 'moderate',
    category: 'customer_reported',
    eventId: 'e01',
    sourceRef: { eventId: 'e01', excerpt: 'A retry sometimes works' },
    excerpt: 'A retry sometimes works and sometimes does not.',
    observedAt: '2026-03-09T09:12:00Z',
    confidence: 0.71,
    method: 'pattern',
    ...overrides,
  });
}

export function missingEvidence(overrides: Partial<MissingEvidence> = {}): MissingEvidence {
  return MissingEvidenceSchema.parse({
    id: 'mis_1',
    requirementId: 'req.network-path-check',
    label: 'Network path check from an affected site',
    description: 'Shows whether name resolution works from the affected network.',
    criticality: 'critical',
    category: 'evidence',
    firstRelevantAt: '2026-03-09T09:12:00Z',
    resolvedAt: null,
    resolvedByEventId: null,
    neededFor: ['DNS resolution failure for sign-in endpoints'],
    askText: 'Please run Resolve-DnsName from an affected device.',
    ...overrides,
  });
}

export function ledger(overrides: Partial<EvidenceLedgerResponse> = {}): EvidenceLedgerResponse {
  const items = [
    claim(),
    claim({
      id: 'clm_2',
      text: 'The customer reported that failures are intermittent.',
      category: 'customer_reported',
      aiCategory: 'customer_reported',
      authorRole: 'customer_admin',
      eventId: 'e01',
      timestamp: '2026-03-09T09:12:00Z',
      supportingEvidenceIds: [],
      contradictingEvidenceIds: [],
      flags: [],
      relatedHypothesisIds: [],
    }),
  ];
  return EvidenceLedgerResponseSchema.parse({
    items,
    nextCursor: null,
    asOf: null,
    counts: {
      confirmed_fact: 0,
      customer_reported: 1,
      engineer_assumption: 1,
      diagnostic_evidence: 0,
      ai_inference: 0,
      conflicting_evidence: 0,
      missing_evidence: 0,
      simulated_outcome: 0,
    },
    evidence: [
      evidenceItem(),
      evidenceItem({
        id: 'evd_2',
        label: 'Excluding users from the MFA policy did not help',
        summary: 'The failure continued after the exclusion.',
        kind: 'absence',
        eventId: 'e10',
        excerpt: 'Excluding users from the MFA policy did not help.',
      }),
    ],
    missing: [missingEvidence()],
    ...overrides,
  });
}

// ---------------------------------------------------------------- twin

export function twin(overrides: Partial<DigitalTwin> = {}): DigitalTwin {
  return DigitalTwinSchema.parse({
    caseId: CASE_ID,
    analysisRunId: RUN_ID,
    asOf: null,
    generatedAt: NOW,
    fields: [
      {
        id: 'twf_1',
        section: 'problem_statement',
        label: 'Reported problem',
        value: 'About 140 users cannot sign in to Teams.',
        display: 'About 140 users cannot sign in to Teams.',
        sourceRefs: [{ eventId: 'e01', excerpt: '140 users' }],
        confidence: 0.9,
        method: 'rule',
        extractedAt: NOW,
        reviewStatus: 'pending',
        observedAt: '2026-03-09T09:12:00Z',
      },
      {
        id: 'twf_2',
        section: 'scope',
        label: 'Affected users',
        value: 'Number of affected users: 140',
        display: 'Number of affected users: 140',
        sourceRefs: [{ eventId: 'e10' }],
        confidence: 0.8,
        method: 'pattern',
        extractedAt: NOW,
        reviewStatus: 'confirmed',
        observedAt: '2026-03-09T13:30:00Z',
      },
    ],
    sectionCounts: { problem_statement: 1, scope: 1, participants: 1 },
    participants: [
      {
        id: 'p-cust',
        role: 'customer_admin',
        alias: 'Customer IT Admin 1',
        eventCount: 6,
        firstSeenAt: '2026-03-09T09:12:00Z',
      },
    ],
    withheldFutureEventCount: 0,
    ...overrides,
  });
}
