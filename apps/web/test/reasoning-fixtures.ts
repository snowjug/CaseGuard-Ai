import {
  ActionOverrideRecordSchema,
  ActionRankingSchema,
  CaseDetailSchema,
  CounterfactualScenarioSchema,
  DiagnosticActionSchema,
  ForkListResponseSchema,
  HindsightCheckSchema,
  HypothesesResponseSchema,
  InvestigationGraphSchema,
  JobSchema,
  TimelineResponseSchema,
  type ActionOverrideRecord,
  type ActionRanking,
  type CaseDetail,
  type CounterfactualScenario,
  type DecisionFork,
  type DiagnosticAction,
  type ForkListResponse,
  type HindsightCheck,
  type HypothesesResponse,
  type InvestigationGraph,
  type Job,
  type TimelineResponse,
} from '@caseguard/schemas';

/**
 * Fixtures for the Hypothesis Arena and the Counterfactual Lab. They follow the shape (and the story) of the synthetic
 * Case One the API serves, in miniature, and every factory validates its result with the real Zod schema so a fixture
 * can never drift from the contract.
 */

export const CASE_ID = 'case_1';
export const RUN_ID = 'run_1';
export const FIRST_EVENT = '2026-03-09T09:12:00Z';
export const LAST_EVENT = '2026-03-12T10:20:00Z';
export const FORK_1_AT = '2026-03-09T09:41:00Z';
export const FORK_2_AT = '2026-03-09T12:25:00Z';

const meta = {
  tenantId: 'tenant_demo',
  createdAt: '2026-10-30T05:07:01.969Z',
  updatedAt: '2026-10-30T05:07:01.969Z',
  createdBy: 'system:analysis',
  version: 1,
};

export function caseDetail(overrides: Partial<CaseDetail> = {}): CaseDetail {
  return CaseDetailSchema.parse({
    ...meta,
    id: CASE_ID,
    reference: 'CG-SYN-1001',
    title: 'Intermittent Teams sign-in failures for about 140 branch users',
    product: 'Microsoft Teams',
    workload: 'teams-authentication',
    severity: 'A',
    status: 'resolved',
    customerAlias: 'Contoso Synthetic Ltd',
    openedAt: FIRST_EVENT,
    closedAt: LAST_EVENT,
    synthetic: true,
    tags: [],
    eventCount: 31,
    firstEventAt: FIRST_EVENT,
    lastEventAt: LAST_EVENT,
    sourceId: 'src_1',
    sourceKind: 'builtin_sample',
    contentHash: 'a'.repeat(64),
    redactionApplied: false,
    redactionReplacements: 0,
    injectionDetected: false,
    hasResolution: true,
    analysisState: 'analyzed',
    lastAnalysisRunId: RUN_ID,
    analyzedAt: '2026-10-30T05:07:08.283Z',
    participants: [],
    source: {
      id: 'src_1',
      kind: 'builtin_sample',
      fileName: null,
      mediaType: 'application/json',
      sizeBytes: 1000,
      receivedSha256: 'a'.repeat(64),
      storedSha256: 'b'.repeat(64),
      redactionApplied: false,
      redactionReplacements: 0,
      synthetic: true,
    },
    resolution: null,
    ...overrides,
  });
}

// ---------------------------------------------------------------- hypotheses

const evidenceRow = (
  id: string,
  label: string,
  eventId: string,
  observedAt: string,
  excerpt: string,
) => ({
  ...meta,
  id,
  caseId: CASE_ID,
  analysisRunId: RUN_ID,
  signalId: `sig.${id}`,
  label,
  summary: `${label}.`,
  kind: 'presence' as const,
  strength: 'strong' as const,
  category: 'diagnostic_evidence' as const,
  eventId,
  sourceRef: { eventId },
  excerpt,
  observedAt,
  confidence: 0.9,
  method: 'rule' as const,
});

const link = (
  id: string,
  hypothesisId: string,
  evidenceId: string,
  polarity: 'supports' | 'contradicts',
  effect: number,
  observedAt: string,
) => ({
  ...meta,
  id,
  caseId: CASE_ID,
  analysisRunId: RUN_ID,
  hypothesisId,
  evidenceId,
  polarity,
  likelihood: 0.8,
  logLikelihoodRatio: polarity === 'supports' ? 0.4 : -0.4,
  effectOnConfidence: effect,
  rationale: `Under this hypothesis the signal is expected about 80% of the time (${polarity}).`,
  observedAt,
});

const point = (
  at: string,
  eventId: string,
  confidence: number,
  low: number,
  high: number,
  status: 'active' | 'leading' | 'confirmed' | 'demoted' | 'ruled_out',
  delta: number,
  reason: string,
  action: string | null = 'act.request-recent-changes',
) => ({
  at,
  eventId,
  confidence,
  low,
  high,
  status,
  delta,
  reason,
  triggerEvidenceIds: [],
  supportingEvidenceIds: [],
  contradictingEvidenceIds: [],
  missingRequirementIds: ['req.network-path-check'],
  cheapestSafeActionKey: action,
  expectedInformationGainBits: action ? 0.24 : null,
});

const cheapestAction = {
  actionKey: 'act.request-recent-changes',
  label: 'Ask about recent identity, network or policy changes',
  rationale: 'Ask the customer which changes were made in the 48 hours before onset.',
  expectedInformationGainBits: 0.24,
  actionValue: 0.53,
  risk: 'low' as const,
  customerEffort: 'low' as const,
  tokenEstimate: 400,
  timeMinutes: 60,
};

export const HYP_DNS = 'hyp_dns';
export const HYP_PROXY = 'hyp_proxy';
export const HYP_CA = 'hyp_ca';

const hypothesisRow = (
  id: string,
  key: string,
  name: string,
  category: 'network' | 'identity',
  timeline: ReturnType<typeof point>[],
  extra: Record<string, unknown> = {},
) => {
  const last = timeline[timeline.length - 1];
  return {
    ...meta,
    id,
    caseId: CASE_ID,
    analysisRunId: RUN_ID,
    key,
    name,
    description: `${name}: a candidate explanation for the failures.`,
    category,
    prior: 0.1,
    timeline,
    currentConfidence: last?.confidence ?? 0.1,
    currentLow: last?.low ?? 0.05,
    currentHigh: last?.high ?? 0.2,
    currentStatus: last?.status ?? 'active',
    assumptions: ['Affected clients alternate between at least two resolvers.'],
    engineerAnchoredAt: null,
    cheapestSafeAction: cheapestAction,
    modelEstimate: true as const,
    ...extra,
  };
};

/** Three competing hypotheses after the customer's first reply, with evidence both ways and one missing item. */
export function hypothesesResponse(
  overrides: Partial<HypothesesResponse> = {},
): HypothesesResponse {
  return HypothesesResponseSchema.parse({
    caseId: CASE_ID,
    asOf: null,
    items: [
      hypothesisRow(
        HYP_DNS,
        'hyp.dns-resolution',
        'DNS resolution failure for sign-in endpoints',
        'network',
        [
          point(
            '2026-03-09T09:12:00Z',
            'e01',
            0.18,
            0.11,
            0.25,
            'active',
            0.08,
            'Rose from 10% to 18%.',
          ),
          point(
            '2026-03-09T11:05:00Z',
            'e04',
            0.73,
            0.55,
            0.84,
            'leading',
            0.55,
            'Rose from 18% to 73%; status changed from active to leading. Supported by “Client reports a name-resolution failure”.',
          ),
        ],
      ),
      hypothesisRow(
        HYP_PROXY,
        'hyp.proxy-egress',
        'Egress proxy or TLS-inspection node failure',
        'network',
        [
          point(
            '2026-03-09T09:12:00Z',
            'e01',
            0.19,
            0.09,
            0.25,
            'active',
            0.09,
            'Rose from 10% to 19%. Supported by “Failures are intermittent”.',
          ),
          point(
            '2026-03-09T11:05:00Z',
            'e04',
            0.18,
            0.06,
            0.33,
            'active',
            -0.01,
            'No material change (18%).',
          ),
        ],
        { engineerAnchoredAt: '2026-03-09T09:30:00Z' },
      ),
      hypothesisRow(
        HYP_CA,
        'hyp.conditional-access',
        'Conditional Access or MFA policy enforcement',
        'identity',
        [
          point(
            '2026-03-09T09:12:00Z',
            'e01',
            0.15,
            0.08,
            0.23,
            'active',
            0.05,
            'Rose from 10% to 15%.',
            'act.review-ca-policy-config',
          ),
          point(
            '2026-03-09T11:05:00Z',
            'e04',
            0.02,
            0.01,
            0.03,
            'ruled_out',
            -0.13,
            'Fell from 15% to 2%; status changed from active to ruled out. Contradicted by “Policy events do not coincide”.',
            null,
          ),
        ],
        { cheapestSafeAction: null },
      ),
    ],
    links: [
      link('hel_1', HYP_DNS, 'evd_name', 'supports', 0.403, '2026-03-09T11:05:00Z'),
      link('hel_2', HYP_DNS, 'evd_sites', 'supports', 0.144, '2026-03-09T11:05:00Z'),
      link('hel_3', HYP_CA, 'evd_policy', 'contradicts', -0.13, '2026-03-09T11:05:00Z'),
      link('hel_4', HYP_PROXY, 'evd_flaky', 'supports', 0.044, '2026-03-09T09:12:00Z'),
    ],
    evidence: [
      evidenceRow(
        'evd_name',
        'Client reports a name-resolution failure',
        'e04',
        '2026-03-09T11:05:00Z',
        'ERR_NAME_NOT_RESOLVED for aadcdn.msftauth.net on the affected devices.',
      ),
      evidenceRow(
        'evd_sites',
        'Failures concentrate at specific sites or networks',
        'e04',
        '2026-03-09T11:05:00Z',
        'Failures are much worse at the Pune office than at Leeds.',
      ),
      evidenceRow(
        'evd_policy',
        'Policy-related log events do not coincide with the failures',
        'e05',
        '2026-03-09T11:41:00Z',
        'No Conditional Access changes in the audit log in the last 14 days.',
      ),
      evidenceRow(
        'evd_flaky',
        'Failures are intermittent',
        'e01',
        '2026-03-09T09:12:00Z',
        'Teams sign-in failing intermittently for branch users since about 08:50 UTC this morning.',
      ),
    ],
    missing: [
      {
        id: 'mis_1',
        requirementId: 'req.network-path-check',
        label: 'Network path check (DNS or proxy) from an affected site',
        description: 'Shows whether name resolution or the proxy path is failing.',
        criticality: 'critical',
        category: 'troubleshooting',
        firstRelevantAt: '2026-03-09T09:12:00Z',
        resolvedAt: null,
        resolvedByEventId: null,
        neededFor: [
          'DNS resolution failure for sign-in endpoints',
          'Egress proxy or TLS-inspection node failure',
        ],
        askText: 'Could you run nslookup against each resolver from an affected site?',
      },
      {
        id: 'mis_2',
        requirementId: 'req.error-code',
        label: 'Exact client error code or text',
        description: 'The on-screen error narrows the cause.',
        criticality: 'important',
        category: 'evidence',
        firstRelevantAt: '2026-03-09T09:12:00Z',
        resolvedAt: '2026-03-09T11:05:00Z',
        resolvedByEventId: 'e04',
        neededFor: ['DNS resolution failure for sign-in endpoints'],
        askText: 'What exact error appears?',
      },
    ],
    notice:
      'Confidence values are model estimates computed from the knowledge pack and the evidence on record. They are not statistical probabilities.',
    ...overrides,
  });
}

// ---------------------------------------------------------------- actions and ranking

export function recordedAction(overrides: Record<string, unknown> = {}): DiagnosticAction {
  return DiagnosticActionSchema.parse({
    ...meta,
    id: 'act_1',
    caseId: CASE_ID,
    analysisRunId: RUN_ID,
    eventId: 'e03',
    sequence: 2,
    actionKey: 'act.request-har-capture',
    label: 'Request HAR and Fiddler traces, full user list and Conditional Access export',
    kind: 'customer_request',
    executorRole: 'support_engineer',
    startedAt: FORK_1_AT,
    durationMinutes: 10,
    customerEffort: 'very_high',
    customerEffortScore: 1,
    operationalRisk: 0.02,
    destructive: false,
    tokenEstimate: 2550,
    computeUnits: 2,
    targetHypothesisIds: [HYP_DNS],
    statedHypothesisId: null,
    realizedInformationGainBits: 1.2,
    informationGainClass: 'high',
    repeatOfActionId: null,
    isRepeat: false,
    lowValue: true,
    lowValueReasons: ['Scored 16% of the best safe action available at that moment.'],
    relativeValueAtDecision: 0.158,
    ...overrides,
  });
}

/** The recorded path after the fork: three actions then the diagnosis (the API's own count for it is 3). */
export function recordedActions(): DiagnosticAction[] {
  return [
    recordedAction(),
    recordedAction({
      id: 'act_2',
      eventId: 'e05',
      sequence: 4,
      actionKey: 'act.signin-log-correlation',
      label: 'Query Entra sign-in failures for the three sample users',
      kind: 'log_query',
      startedAt: '2026-03-09T11:40:00Z',
      lowValue: false,
      lowValueReasons: [],
      relativeValueAtDecision: 0.7,
      customerEffort: 'none',
      customerEffortScore: 0,
    }),
    recordedAction({
      id: 'act_3',
      eventId: 'e09',
      sequence: 8,
      actionKey: 'act.revoke-sessions',
      label: 'Revoke sign-in sessions for the affected users',
      kind: 'remediation',
      startedAt: '2026-03-09T12:31:00Z',
      destructive: true,
      lowValue: false,
      lowValueReasons: [],
      relativeValueAtDecision: 0.1,
    }),
    recordedAction({
      id: 'act_after',
      eventId: 'e25',
      sequence: 24,
      actionKey: 'act.workaround',
      label: 'Recommend removing the failing resolver (after the diagnosis)',
      kind: 'remediation',
      startedAt: '2026-03-11T11:50:00Z',
      lowValue: false,
      lowValueReasons: [],
      relativeValueAtDecision: 0.8,
    }),
  ];
}

const breakdown = (
  actionKey: string,
  label: string,
  rank: number,
  score: number,
  extra: Record<string, unknown> = {},
) => ({
  actionKey,
  label,
  kind: 'customer_request' as const,
  inputs: {
    expectedInformationGainBits: 0.53,
    relevance: 1,
    confidence: 0.9,
    timeMinutes: 90,
    tokens: 600,
    customerEffort: 0.2,
    operationalRisk: 0,
  },
  normalized: {
    information: 0.265,
    relevance: 1,
    confidence: 0.9,
    time: 0.188,
    token: 0.03,
    customer: 0.2,
    risk: 0,
  },
  numerator: 0.2387,
  denominator: 0.1793,
  score,
  relativeScore: Math.min(1, score / 1.33),
  rank,
  safety: { allowed: true, blockedReasons: [] },
  sensitivity: {
    minRank: rank,
    maxRank: rank,
    rankStable: true,
    scenarios: [
      { label: 'Equal weights', rank, score },
      { label: 'time weight +25%', rank, score: score * 0.9 },
    ],
  },
  requiresFirst: [],
  explanation: `Expected information gain 0.53 bits. Rank ${rank}.`,
  override: null,
  ...extra,
});

/** The ranking just before the earliest fork: ask for minimal scoping data first; the heavy request the engineer chose ranks lower. */
export function actionRanking(overrides: Partial<ActionRanking> = {}): ActionRanking {
  return ActionRankingSchema.parse({
    caseId: CASE_ID,
    asOf: '2026-03-09T09:40:59Z',
    configVersion: '1.0.0',
    formula:
      'Action value = (Expected information gain x Relevance x Confidence) / (epsilon + w_time x Time + w_token x Tokens + w_customer x Customer effort + w_risk x Operational risk).',
    notice:
      'Scores come from a configurable decision-support heuristic, not a scientific measurement. Actions blocked by the safety policy are never recommended, whatever their score.',
    posterior: [
      {
        hypothesisId: HYP_PROXY,
        key: 'hyp.proxy-egress',
        name: 'Egress proxy or TLS-inspection node failure',
        confidence: 0.187,
      },
      {
        hypothesisId: HYP_DNS,
        key: 'hyp.dns-resolution',
        name: 'DNS resolution failure for sign-in endpoints',
        confidence: 0.178,
      },
    ],
    candidates: [
      breakdown('act.request-minimal-scoping', 'Ask for minimal scoping data', 1, 1.3319),
      breakdown(
        'act.request-recent-changes',
        'Ask about recent identity, network or policy changes',
        2,
        0.5304,
      ),
      breakdown(
        'act.request-har-capture',
        'Request HAR / Fiddler traces from end users',
        3,
        0.2102,
        {
          sensitivity: {
            minRank: 3,
            maxRank: 4,
            rankStable: false,
            scenarios: [{ label: 'Equal weights', rank: 3, score: 0.21 }],
          },
        },
      ),
    ],
    blocked: [
      breakdown('act.remove-resolver-from-service', 'Remove the resolver from service', 1, 0, {
        safety: {
          allowed: false,
          blockedReasons: [
            'Remediation, not a diagnostic step: the targeted hypothesis stands at 18% (needs at least 60% with confirmation evidence).',
          ],
        },
      }),
    ],
    // The API always sends both: the overrides this view may show, and how many a window cannot.
    reviewerOverrides: [],
    withheldOverrides: 0,
    ...overrides,
  });
}

/**
 * A reviewer's override as the ranking lists it. About the ranking at `instant` (09:30, the last event before the first
 * fork, by default), decided at `at`; the API names the action with the pack's label.
 */
export function reviewerOverride(overrides: Record<string, unknown> = {}): ActionOverrideRecord {
  return ActionOverrideRecordSchema.parse({
    instant: '2026-03-09T09:30:00.000Z',
    actionKey: 'act.request-recent-changes',
    actionName: 'Ask about recent identity, network or policy changes',
    rank: 1,
    reason: 'The customer mentioned a deployment, so ask about changes first.',
    by: 'user_riley_reviewer',
    at: '2026-10-30T09:29:00.000Z',
    ...overrides,
  });
}

/**
 * The ranking at the last event of a resolved case: nothing left to learn, so every score is zero. The API still names
 * the candidates (four of them for Case One); none is a recommendation.
 */
export function zeroScoreRanking(overrides: Partial<ActionRanking> = {}): ActionRanking {
  const zero = (actionKey: string, label: string, rank: number) =>
    breakdown(actionKey, label, rank, 0, {
      inputs: {
        expectedInformationGainBits: 0,
        relevance: 0.02,
        confidence: 0.7,
        timeMinutes: 90,
        tokens: 800,
        customerEffort: 0.5,
        operationalRisk: 0.02,
      },
      relativeScore: 0,
      numerator: 0,
      explanation: `Expected information gain 0 bits (0% of the 2-bit scale). Rank ${rank}.`,
    });
  return actionRanking({
    asOf: LAST_EVENT,
    candidates: [
      zero(
        'act.review-federation-health',
        'Review federation server health, certificates and clocks',
        1,
      ),
      zero('act.check-m365-health', 'Check Microsoft 365 service health', 2),
      zero('act.escalate-identity', 'Escalate to the identity backend team', 3),
    ],
    ...overrides,
  });
}

// ---------------------------------------------------------------- forks

const alternative = (
  actionKey: string,
  label: string,
  relativeValue: number,
  extra: Record<string, unknown> = {},
) => ({
  actionKey,
  label,
  kind: 'customer_request' as const,
  rationale: `${label}: ask the customer for the exact client error text and three failing sample users.`,
  supportingEvidenceIds: ['evd_flaky'],
  expectedInformationGainBits: 0.531,
  relevance: 1,
  actionValue: 1.33 * relativeValue,
  relativeValue,
  timeMinutes: 90,
  customerEffort: 'low' as const,
  operationalRisk: 0,
  tokenEstimate: 600,
  safe: true,
  blockedReasons: [],
  requiresFirst: [],
  ...extra,
});

const consequence = (mid: number, effort: number, tokens: number) => ({
  timeToUsefulEvidenceMinutes: { low: mid / 2, mid, high: mid * 2 },
  customerEffortScore: effort,
  tokenEstimate: tokens,
  riskLevel: 'low' as const,
  estimated: true as const,
});

export function fork(overrides: Record<string, unknown> = {}): DecisionFork {
  const base = {
    ...meta,
    id: 'fork_1',
    caseId: CASE_ID,
    analysisRunId: RUN_ID,
    sequence: 0,
    timestamp: FORK_1_AT,
    eventId: 'e03',
    title: 'Heavy customer request when a lighter ask was available',
    summary:
      '“Request HAR and Fiddler traces” asked the customer for substantial effort (about 180 customer minutes, estimated). “Ask for minimal scoping data” promised comparable information for 80% less customer effort.',
    category: 'disproportionate_customer_effort',
    additionalCategories: ['low_value_action'],
    severity: 'medium',
    impactScore: 0.571,
    isEarliestMeaningful: true,
    ruleIds: ['FORK-R6-disproportionate-effort'],
    actual: {
      actionKey: 'act.request-har-capture',
      label: 'Request HAR and Fiddler traces, full user list and Conditional Access export',
      kind: 'customer_request',
      eventId: 'e03',
      customerEffort: 'very_high',
      operationalRisk: 0.02,
      destructive: false,
      actionValue: 0.2102,
      relativeValue: 0.158,
    },
    informationAvailable: {
      eventIds: ['e01', 'e02'],
      evidenceIds: ['evd_flaky'],
      claimIds: ['clm_1'],
      summary:
        '2 events and 1 evidence item were on record. Leading hypothesis: “Egress proxy or TLS-inspection node failure” (19% model estimate).',
    },
    informationUnavailable: [
      'Exact client error code or text (not yet collected)',
      'The final root cause and resolution (not known at this point)',
    ],
    posteriorAtDecision: [
      {
        hypothesisId: HYP_PROXY,
        key: 'hyp.proxy-egress',
        name: 'Egress proxy or TLS-inspection node failure',
        confidence: 0.187,
      },
    ],
    alternatives: [
      alternative('act.request-minimal-scoping', 'Ask for minimal scoping data', 1),
      alternative(
        'act.request-recent-changes',
        'Ask about recent identity, network or policy changes',
        0.398,
      ),
    ],
    consequences: {
      actual: consequence(240, 0.8, 6000),
      bestAlternative: consequence(90, 0.2, 600),
      deltaSummary:
        'Estimated, not measured: “Ask for minimal scoping data” would have been about 150 minutes faster, 60% less customer effort than the step taken.',
    },
    uncertainty: {
      level: 'low',
      score: 0.244,
      rationale: 'Best alternative stays in the top two in 100% of weight-perturbation scenarios.',
      rankStability: 1,
    },
    risk: 'low',
    eligibility: {
      eligible: true,
      boundary: FORK_1_AT,
      checks: [
        {
          id: 'boundary-excludes-future',
          passed: true,
          detail: 'The analysis window contains 2 events recorded before the decision.',
        },
        {
          id: 'resolution-excluded',
          passed: true,
          detail: 'The final resolution and root cause are excluded from the window.',
        },
      ],
      reasons: [],
    },
    retrospective: {
      realizedInformationGainBits: 1.222,
      outcomeSummary: 'Hindsight: the responses that followed produced four observations.',
      usedHindsight: true,
    },
    reviewState: 'pending',
    reviewReason: null,
    ...overrides,
  };
  return ForkListResponseSchema.shape.items.element.parse(base);
}

export function forkList(overrides: Partial<ForkListResponse> = {}): ForkListResponse {
  return ForkListResponseSchema.parse({
    items: [
      fork(),
      fork({
        id: 'fork_2',
        sequence: 1,
        timestamp: FORK_2_AT,
        eventId: 'e08',
        title: 'Disruptive change made before the cause was established',
        summary:
          'Asking the customer to exclude all users from the MFA policy was disruptive and premature.',
        category: 'premature_destructive_action',
        additionalCategories: [],
        severity: 'high',
        impactScore: 0.768,
        isEarliestMeaningful: false,
        retrospective: null,
        eligibility: {
          eligible: true,
          boundary: FORK_2_AT,
          checks: [
            {
              id: 'boundary-excludes-future',
              passed: true,
              detail: 'The window contains 6 events.',
            },
          ],
          reasons: [],
        },
      }),
    ],
    earliestMeaningfulForkId: 'fork_1',
    ...overrides,
  });
}

// ---------------------------------------------------------------- scenarios

const range = (low: number, mid: number, high: number) => ({ low, mid, high });
const fixed = (value: number) => range(value, value, value);

const metrics = (spec: {
  actions: number;
  interactions: number;
  useful: number;
  diagnosis: number;
  tokens: number;
  effort: number;
  risk: number;
  gain: number;
  unsupported: number;
}) => ({
  actionCount: fixed(spec.actions),
  customerInteractions: fixed(spec.interactions),
  timeToUsefulEvidenceMinutes: fixed(spec.useful),
  timeToDiagnosisMinutes: fixed(spec.diagnosis),
  diagnosticVolume: fixed(14),
  tokenEstimate: fixed(spec.tokens),
  customerEffortMinutes: fixed(spec.effort),
  operationalRisk: spec.risk,
  informationGainBits: fixed(spec.gain),
  unsupportedBranches: spec.unsupported,
});

const step = (
  id: string,
  scenarioId: string,
  index: number,
  label: string,
  offset: number,
  evidenceUsedIds: string[],
  priorStepIds: string[],
) => ({
  id,
  scenarioId,
  index,
  offsetMinutes: range(offset * 0.6, offset, offset * 1.8),
  simulatedAt: new Date(Date.parse(FORK_1_AT) + offset * 60_000).toISOString(),
  actionKey: `act.step-${index}`,
  label,
  kind: 'customer_request' as const,
  executor: index === 0 ? ('customer_admin' as const) : ('engineer' as const),
  rationale: `Rank 1 under “Balanced path” at this point. Expected information 0.5 bits for about ${offset} minutes.`,
  evidenceUsedIds,
  priorStepIds,
  predictedOutcome: {
    outcomeId: `outcome-${index}`,
    label: index === 0 ? 'Error tag is other or not available' : 'Matching failure records exist',
    probability: 0.605,
    simulatedResult:
      'Customer supplies sample users and failure times; the on-screen error is generic.',
    alternatives: [
      {
        outcomeId: 'tag-timeout',
        label: 'Error tag indicates a connection timeout',
        probability: 0.25,
      },
    ],
  },
  expectedInformationGainBits: 0.531,
  posteriorAfter: [
    {
      hypothesisId: HYP_CA,
      key: 'hyp.conditional-access',
      name: 'Conditional Access or MFA policy enforcement',
      confidence: 0.372,
    },
    {
      hypothesisId: HYP_DNS,
      key: 'hyp.dns-resolution',
      name: 'DNS resolution failure for sign-in endpoints',
      confidence: 0.209,
    },
  ],
  customerEffort: index === 0 ? ('low' as const) : ('none' as const),
  operationalRisk: 0,
  tokenEstimate: 600,
  safe: true,
  safetyNotes: ['Read-only step.'],
  assumptions: ['The predicted outcome is simulated from knowledge-pack likelihoods.'],
  supported: true,
  unsupportedReasons: [],
  uncertainty: 'medium' as const,
  simulated: true as const,
});

export const SCENARIO_ID = 'scn_1';
export const STEP_1 = 'cfs_1';
export const STEP_2 = 'cfs_2';
export const STEP_3 = 'cfs_3';

/** A balanced path for fork 1: three steps, the first citing evidence and the third citing none. */
export function scenario(overrides: Record<string, unknown> = {}): CounterfactualScenario {
  const id = (overrides.id as string | undefined) ?? SCENARIO_ID;
  const base = {
    ...meta,
    id,
    caseId: CASE_ID,
    forkId: 'fork_1',
    analysisRunId: RUN_ID,
    modelExecutionId: null,
    status: 'completed',
    strategy: 'balanced',
    label: 'Balanced path',
    summary:
      'From 2026-03-09 09:41 UTC, the “Balanced path” strategy would take 3 steps and is simulated to reach a diagnosis in about 7 h 24 min. Simulated estimate, not a measurement.',
    boundary: {
      asOf: FORK_1_AT,
      eventIds: ['e01', 'e02'],
      evidenceIds: ['evd_flaky'],
      eventCount: 2,
      leakCheck: {
        passed: true,
        checkedAt: '2026-10-30T05:07:01.969Z',
        futureReferencesFound: 0,
        resolutionExcluded: true,
        details: [
          '2 events inside the boundary; 29 later events withheld.',
          'No identifier that first appears after the boundary was used.',
          'All cited evidence was observed before the boundary.',
        ],
      },
    },
    steps: [
      step(STEP_1, id, 0, 'Ask for minimal scoping data', 90, ['evd_flaky'], []),
      step(
        STEP_2,
        id,
        1,
        'Correlate failing attempts with Entra sign-in logs',
        115,
        ['evd_flaky'],
        [STEP_1],
      ),
      step(STEP_3, id, 2, 'Review Conditional Access configuration', 135, [], [STEP_1, STEP_2]),
    ],
    branchNotes: [
      {
        afterStepIndex: 0,
        condition:
          'If the result is “Error tag indicates a connection timeout” (25%) instead of “Error tag is other or not available”',
        thenAction: 'Next: Correlate failing attempts with Entra sign-in logs',
        probability: 0.25,
      },
    ],
    assumptions: [
      'Outcome probabilities come from knowledge-pack likelihoods, not from the real environment.',
    ],
    rollouts: {
      count: 200,
      seed: 'seed|fork_1|balanced',
      modalPathShare: 0.18,
      diagnosisReachedShare: 0.575,
    },
    actualMetrics: metrics({
      actions: 3,
      interactions: 2,
      useful: 84,
      diagnosis: 2994,
      tokens: 40850,
      effort: 410,
      risk: 0.8,
      gain: 1.35,
      unsupported: 3,
    }),
    counterfactualMetrics: {
      ...metrics({
        actions: 3,
        interactions: 2,
        useful: 101,
        diagnosis: 444,
        tokens: 7900,
        effort: 110,
        risk: 0.08,
        gain: 1.42,
        unsupported: 0,
      }),
      timeToDiagnosisMinutes: range(197, 444, 649),
    },
    improvements: {
      timeToDiagnosisMinutes: 2550,
      timeToDiagnosisMinutesPct: 0.852,
      customerEffortMinutesPct: 0.732,
      tokenEstimatePct: 0.807,
      operationalRiskPct: 0.9,
      timeToUsefulEvidenceMinutesPct: -0.208,
    },
    comparisonConfidence: {
      level: 'low',
      score: 0.247,
      rationale:
        'Diagnosis reached in 57% of 200 rollouts; time-to-diagnosis spread 100% of its median.',
    },
    validity: {
      valid: true,
      checks: [
        {
          id: 'boundary-respected',
          passed: true,
          detail: 'Generation used only events recorded before the decision instant.',
        },
        {
          id: 'resolution-excluded',
          passed: true,
          detail: 'The final resolution and root cause were not available to generation.',
        },
      ],
    },
    labels: { simulated: true, estimated: true },
    reviewState: 'pending',
    reviewReason: null,
    reviewedBy: null,
    reviewedAt: null,
    ...overrides,
  };
  return CounterfactualScenarioSchema.parse(base);
}

export function scenarioList(): { items: CounterfactualScenario[] } {
  return {
    items: [
      scenario(),
      scenario({
        id: 'scn_2',
        strategy: 'fastest_diagnosis',
        label: 'Fastest to diagnosis',
        steps: scenario().steps.map((s) => ({ ...s, scenarioId: 'scn_2', id: `${s.id}_b` })),
      }),
      scenario({
        id: 'scn_3',
        forkId: 'fork_2',
        steps: scenario()
          .steps.slice(0, 1)
          .map((s) => ({ ...s, scenarioId: 'scn_3', id: 'cfs_f2' })),
      }),
    ],
  };
}

export function hindsightCheck(overrides: Partial<HindsightCheck> = {}): HindsightCheck {
  return HindsightCheckSchema.parse({
    scenarioId: SCENARIO_ID,
    caseId: CASE_ID,
    computedAt: '2026-10-30T06:00:00.000Z',
    usedFinalResolution: true,
    notice:
      'Hindsight check: this comparison uses the final resolution of the case. It was computed after the path was generated and never fed generation.',
    resolutionHypothesisKey: 'hyp.dns-resolution',
    leadingHypothesisAtEndOfPath: {
      key: 'hyp.conditional-access',
      name: 'Conditional Access or MFA policy enforcement',
      confidence: 0.66,
    },
    consistentWithResolution: false,
    simulatedTimeToDiagnosisMinutes: range(197, 444, 649),
    actualTimeToDiagnosisMinutes: 2994,
    explanation:
      'The simulated path ends leaning towards Conditional Access, which the recorded resolution does not support.',
    ...overrides,
  });
}

// ---------------------------------------------------------------- graph and jobs

const graphNode = (
  id: string,
  kind:
    | 'problem'
    | 'evidence'
    | 'hypothesis'
    | 'action'
    | 'fork'
    | 'outcome'
    | 'counterfactual_step'
    | 'skill',
  lane: 'problem' | 'evidence' | 'hypothesis' | 'actual' | 'counterfactual' | 'outcome' | 'skill',
  order: number,
  label: string,
  timestamp: string | null,
  extra: Record<string, unknown> = {},
) => ({
  id,
  kind,
  lane,
  label,
  detail: `${label}. “Case text is shown as plain text.”`,
  order,
  timestamp,
  status: 'uncertain' as const,
  simulated: lane === 'counterfactual',
  confidence: null,
  refs: [] as { type: string; id: string }[],
  textAlternative: `${label}.`,
  ...extra,
});

const graphEdge = (
  from: string,
  to: string,
  kind:
    'actual' | 'counterfactual' | 'supports' | 'contradicts' | 'informs' | 'branches' | 'extracts',
  simulated = false,
  label: string | null = null,
) => ({ id: `${kind}:${from}>${to}`, from, to, kind, label, simulated, strength: null });

/** A graph in the API's shape (lane-local `order`, timestamps, an unflagged "decision point" link, one scenario). */
export function investigationGraph(
  overrides: Partial<InvestigationGraph> = {},
): InvestigationGraph {
  return InvestigationGraphSchema.parse({
    caseId: CASE_ID,
    scenarioId: SCENARIO_ID,
    asOf: null,
    generatedAt: '2026-10-30T06:00:00.000Z',
    nodes: [
      graphNode(
        'problem:case',
        'problem',
        'problem',
        0,
        'Intermittent Teams sign-in failures',
        FIRST_EVENT,
        { status: 'neutral' },
      ),
      graphNode(
        'hypothesis:hyp.dns-resolution',
        'hypothesis',
        'hypothesis',
        0,
        'DNS resolution failure',
        null,
        {
          confidence: 0.73,
          status: 'productive',
          refs: [{ type: 'hypothesis', id: HYP_DNS }],
        },
      ),
      graphNode(
        'evidence:evd_name',
        'evidence',
        'evidence',
        0,
        'Client reports a name-resolution failure',
        '2026-03-09T11:05:00Z',
        {
          refs: [
            { type: 'evidence', id: 'evd_name' },
            { type: 'event', id: 'e04' },
          ],
        },
      ),
      graphNode(
        'action:act_1',
        'action',
        'actual',
        0,
        'Request HAR and Fiddler traces',
        FORK_1_AT,
        {
          status: 'unsupported',
          refs: [
            { type: 'action', id: 'act_1' },
            { type: 'event', id: 'e03' },
          ],
        },
      ),
      graphNode(
        'fork:fork_1',
        'fork',
        'actual',
        1,
        'Heavy customer request when a lighter ask was available',
        FORK_1_AT,
        {
          refs: [
            { type: 'fork', id: 'fork_1' },
            { type: 'event', id: 'e03' },
          ],
        },
      ),
      graphNode(
        `step:${STEP_1}`,
        'counterfactual_step',
        'counterfactual',
        0,
        'Ask for minimal scoping data',
        '2026-03-09T11:11:00.000Z',
        {
          status: 'productive',
          refs: [
            { type: 'step', id: STEP_1 },
            { type: 'scenario', id: SCENARIO_ID },
          ],
        },
      ),
      graphNode(
        `outcome:sim:${SCENARIO_ID}`,
        'outcome',
        'outcome',
        1,
        'Simulated diagnosis',
        '2026-03-09T11:11:00.000Z',
        {
          simulated: true,
          refs: [{ type: 'scenario', id: SCENARIO_ID }],
        },
      ),
      graphNode(
        'outcome:actual',
        'outcome',
        'outcome',
        0,
        'Actual: DNS resolution failure',
        LAST_EVENT,
        { status: 'productive' },
      ),
      graphNode(
        'skill:skl_1',
        'skill',
        'skill',
        0,
        'Isolate a pre-authentication failure first',
        null,
        {
          status: 'productive',
          refs: [{ type: 'skill', id: 'skl_1' }],
        },
      ),
    ],
    edges: [
      graphEdge('problem:case', 'action:act_1', 'actual'),
      graphEdge('action:act_1', 'fork:fork_1', 'branches', false, 'decision point'),
      graphEdge('action:act_1', 'evidence:evd_name', 'informs'),
      graphEdge('evidence:evd_name', 'hypothesis:hyp.dns-resolution', 'supports'),
      graphEdge('fork:fork_1', `step:${STEP_1}`, 'branches', true, 'what if'),
      graphEdge(`step:${STEP_1}`, `outcome:sim:${SCENARIO_ID}`, 'counterfactual', true),
      graphEdge('action:act_1', 'outcome:actual', 'actual'),
      graphEdge('fork:fork_1', 'skill:skl_1', 'extracts', false, 'extracts'),
    ],
    lanes: [
      { id: 'problem', label: 'Problem' },
      { id: 'evidence', label: 'Evidence' },
      { id: 'hypothesis', label: 'Hypotheses' },
      { id: 'actual', label: 'Actual path' },
      { id: 'counterfactual', label: 'Counterfactual (simulated)' },
      { id: 'outcome', label: 'Outcome' },
      { id: 'skill', label: 'Skills' },
    ],
    summary:
      'Investigation graph with 9 nodes and 8 connections. Counterfactual nodes are simulated estimates and are always labelled as such.',
    truncated: false,
    nodeLimit: 160,
    ...overrides,
  });
}

/** What `timeline.get?asOf=…&limit=1` returns: how many later events are withheld and what was known by then. */
export function timelineWindow(asOf: string | null, withheld: number): TimelineResponse {
  return TimelineResponseSchema.parse({
    caseId: CASE_ID,
    asOf,
    openedAt: FIRST_EVENT,
    events: [],
    nextCursor: null,
    total: 2,
    simulatedEvents: [],
    delays: [],
    repeats: [],
    hypothesisSeries: [],
    withheldFutureEventCount: withheld,
    knownAtAsOf: { evidenceCount: 2, claimCount: 10, criticalMissingCount: 3, openWarningCount: 0 },
  });
}

/**
 * Every event instant of the case, ascending: the time cursor lands on these (nothing changes between two events).
 * The customer's second message at 09:30 is the last event before the first decision fork (09:41).
 */
export const EVENT_INSTANTS = [
  FIRST_EVENT,
  '2026-03-09T09:30:00Z',
  FORK_1_AT,
  '2026-03-09T11:05:00Z',
  '2026-03-09T11:40:00Z',
  FORK_2_AT,
  '2026-03-09T12:31:00Z',
  '2026-03-11T11:50:00Z',
  LAST_EVENT,
] as const;

/** The last event before the first fork: where "just before the decision" lands. */
export const BEFORE_FORK_EVENT = '2026-03-09T09:30:00Z';

/** What `timeline.get` (the whole record, no `asOf`) returns: the events the cursor reads its instants from. */
export function wholeTimeline(): TimelineResponse {
  const events = EVENT_INSTANTS.map((timestamp, index) => ({
    id: `e${String(index + 1).padStart(2, '0')}`,
    sequence: index,
    timestamp,
    type: 'customer_email' as const,
    participantRole: 'customer_admin' as const,
    participantAlias: 'Customer IT Admin 1',
    title: `Event ${index + 1}`,
    bodyExcerpt: 'Synthetic case text.',
    bodyTruncated: false,
    actionKey: null,
    actionLabel: null,
    actionKind: null,
    customerEffort: null,
    destructive: false,
    gapMinutes: index === 0 ? null : 30,
    isDelay: false,
    isRepeatedDiagnostic: false,
    forkIds: [],
    claimIds: [],
    evidenceIds: [],
    categories: [],
    hypothesisEffects: [],
    aiTokens: null,
    simulated: false as const,
  }));
  return TimelineResponseSchema.parse({
    caseId: CASE_ID,
    asOf: null,
    openedAt: FIRST_EVENT,
    events,
    nextCursor: null,
    total: events.length,
    simulatedEvents: [],
    delays: [],
    repeats: [],
    hypothesisSeries: [],
    withheldFutureEventCount: 0,
    knownAtAsOf: {
      evidenceCount: 26,
      claimCount: 61,
      criticalMissingCount: 0,
      openWarningCount: 0,
    },
  });
}

export function job(overrides: Record<string, unknown> = {}): Job {
  return JobSchema.parse({
    id: 'job_1',
    tenantId: 'tenant_demo',
    kind: 'counterfactual',
    status: 'succeeded',
    caseId: CASE_ID,
    targetId: 'fork_1',
    progress: {
      percent: 100,
      stage: 'save',
      stages: [
        {
          id: 'load',
          label: 'Load the analysis and the decision moment',
          status: 'done',
          startedAt: null,
          completedAt: null,
          detail: null,
        },
        {
          id: 'simulate',
          label: 'Simulate alternative paths from the decision moment',
          status: 'done',
          startedAt: null,
          completedAt: null,
          detail: null,
        },
        {
          id: 'save',
          label: 'Save the scenarios',
          status: 'done',
          startedAt: null,
          completedAt: null,
          detail: null,
        },
      ],
    },
    error: null,
    resultRef: { type: 'fork', id: 'fork_1' },
    idempotencyKey: null,
    createdAt: '2026-10-30T06:00:00.000Z',
    startedAt: '2026-10-30T06:00:00.000Z',
    completedAt: '2026-10-30T06:00:01.000Z',
    createdBy: 'user_ava_engineer',
    cancellable: false,
    ...overrides,
  });
}
