import type {
  AnalysisRun,
  CaseWarning,
  Claim,
  CoachingReport,
  DecisionFork,
  DiagnosticAction,
  DigitalTwin,
  Evidence,
  Hypothesis,
  HypothesisEvidenceLink,
  MetricEstimate,
  MissingEvidence,
  QualityAssessment,
} from '@caseguard/schemas';
import type { AnalysisSnapshot, IngestCaseInput } from '../src/db/repositories/types';
import { buildExecution } from './builders-ops';
import { TENANT_A, at, meta, pad } from './builders-common';

const DIMENSIONS = [
  ['evidence_integrity', 'Evidence integrity', 0.25],
  ['diagnostic_reasoning', 'Diagnostic reasoning', 0.2],
  ['scoping_completeness', 'Scoping completeness', 0.15],
  ['customer_communication', 'Customer communication', 0.15],
  ['resolution_validation', 'Resolution validation', 0.15],
  ['efficiency_proportionality', 'Efficiency and proportionality', 0.1],
] as const;

export function buildAnalysisRun(overrides: Partial<AnalysisRun> = {}): AnalysisRun {
  const caseId = overrides.caseId ?? 'case_alpha';
  return {
    ...meta(overrides.tenantId ?? TENANT_A, at(100)),
    id: `run_${caseId}_1`,
    caseId,
    status: 'succeeded',
    provider: 'deterministic',
    model: 'deterministic-knowledge-pack',
    simulated: true,
    knowledgePackId: 'synthetic-pack',
    knowledgePackVersion: '1.0.0',
    qualityConfigVersion: '1.0.0',
    actionValueConfigVersion: '1.0.0',
    inputHash: `hash-${caseId}-1`,
    startedAt: at(100),
    completedAt: at(101),
    counts: {
      events: 6,
      evidence: 3,
      claims: 3,
      hypotheses: 2,
      actions: 2,
      forks: 1,
      warnings: 2,
      modelExecutions: 2,
    },
    error: null,
    ...overrides,
  };
}

export function buildDigitalTwin(overrides: Partial<DigitalTwin> = {}): DigitalTwin {
  const caseId = overrides.caseId ?? 'case_alpha';
  return {
    caseId,
    analysisRunId: `run_${caseId}_1`,
    asOf: null,
    generatedAt: at(101),
    fields: [
      {
        id: `twin_${caseId}_problem`,
        section: 'problem_statement',
        label: 'Problem statement',
        value: 'Users cannot sign in.',
        display: 'Users cannot sign in.',
        sourceRefs: [{ eventId: 'evt_01' }],
        confidence: 0.9,
        method: 'derived',
        extractedAt: at(101),
        reviewStatus: 'pending',
        observedAt: at(0),
      },
    ],
    sectionCounts: { problem_statement: 1 },
    participants: [],
    withheldFutureEventCount: 0,
    ...overrides,
  };
}

export function buildHypothesis(overrides: Partial<Hypothesis> = {}): Hypothesis {
  const caseId = overrides.caseId ?? 'case_alpha';
  const key = overrides.key ?? 'hyp.proxy';
  return {
    ...meta(overrides.tenantId ?? TENANT_A, at(101)),
    id: `hyp_${caseId}_${key.replace(/[^a-z0-9]/gi, '_')}`,
    caseId,
    analysisRunId: `run_${caseId}_1`,
    key,
    name: 'Proxy rule blocks the sign-in endpoint',
    description: 'Synthetic hypothesis: a proxy rule blocks the authentication endpoint.',
    category: 'network',
    prior: 0.3,
    timeline: [],
    currentConfidence: 0.6,
    currentLow: 0.45,
    currentHigh: 0.75,
    currentStatus: 'leading',
    assumptions: ['Evidence signals are conditionally independent.'],
    engineerAnchoredAt: null,
    cheapestSafeAction: null,
    modelEstimate: true,
    ...overrides,
  };
}

export function buildEvidence(overrides: Partial<Evidence> = {}): Evidence {
  const caseId = overrides.caseId ?? 'case_alpha';
  const eventId = overrides.eventId ?? 'evt_02';
  return {
    ...meta(overrides.tenantId ?? TENANT_A, at(101)),
    id: `ev_${caseId}_${eventId}`,
    caseId,
    analysisRunId: `run_${caseId}_1`,
    signalId: 'sig.proxy-block',
    label: 'Proxy block observed',
    summary: 'The proxy log shows a block for the sign-in endpoint.',
    kind: 'presence',
    strength: 'strong',
    category: 'diagnostic_evidence',
    eventId,
    sourceRef: { eventId, pointer: '/events/1/body' },
    excerpt: 'Synthetic excerpt: proxy denied the request.',
    observedAt: at(10),
    confidence: 0.8,
    method: 'rule',
    ...overrides,
  };
}

export function buildLink(overrides: Partial<HypothesisEvidenceLink> = {}): HypothesisEvidenceLink {
  const caseId = overrides.caseId ?? 'case_alpha';
  const hypothesisId = overrides.hypothesisId ?? `hyp_${caseId}_hyp_proxy`;
  const evidenceId = overrides.evidenceId ?? `ev_${caseId}_evt_02`;
  return {
    ...meta(overrides.tenantId ?? TENANT_A, at(101)),
    id: `lnk_${hypothesisId}_${evidenceId}`,
    caseId,
    analysisRunId: `run_${caseId}_1`,
    hypothesisId,
    evidenceId,
    polarity: 'supports',
    likelihood: 0.7,
    logLikelihoodRatio: 1.2,
    effectOnConfidence: 0.15,
    rationale: 'Synthetic: the observation is more likely if the proxy rule exists.',
    observedAt: at(10),
    ...overrides,
  };
}

export function buildClaim(overrides: Partial<Claim> = {}): Claim {
  const caseId = overrides.caseId ?? 'case_alpha';
  const eventId = overrides.eventId === undefined ? 'evt_01' : overrides.eventId;
  return {
    ...meta(overrides.tenantId ?? TENANT_A, at(101)),
    id: `clm_${caseId}_${eventId ?? 'inferred'}`,
    caseId,
    analysisRunId: `run_${caseId}_1`,
    text: 'Users cannot sign in since Monday.',
    category: 'customer_reported',
    aiCategory: 'customer_reported',
    reviewedCategory: null,
    reviewState: 'pending',
    reviewReason: null,
    reviewedBy: null,
    reviewedAt: null,
    subject: 'affected_user_count',
    authorRole: 'customer_admin',
    eventId,
    sourceRef: eventId ? { eventId } : null,
    timestamp: at(0),
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
    relatedHypothesisIds: [],
    confidence: 0.8,
    explanation: 'Synthetic classification: a customer statement.',
    ruleId: 'rule.customer-statement',
    flags: [],
    method: 'rule',
    missingEvidenceId: null,
    simulated: false,
    ...overrides,
  };
}

export function buildMissingEvidence(overrides: Partial<MissingEvidence> = {}): MissingEvidence {
  return {
    id: 'miss_case_alpha_proxy_logs',
    requirementId: 'req.proxy-logs',
    label: 'Proxy logs',
    description: 'Proxy logs for the affected users are missing.',
    criticality: 'important',
    category: 'evidence',
    firstRelevantAt: at(20),
    resolvedAt: null,
    resolvedByEventId: null,
    neededFor: ['hyp.proxy'],
    askText: 'Please share the proxy logs for the affected users.',
    ...overrides,
  };
}

export function buildAction(overrides: Partial<DiagnosticAction> = {}): DiagnosticAction {
  const caseId = overrides.caseId ?? 'case_alpha';
  const sequence = overrides.sequence ?? 0;
  return {
    ...meta(overrides.tenantId ?? TENANT_A, at(101)),
    id: `act_${caseId}_${pad(sequence + 1)}`,
    caseId,
    analysisRunId: `run_${caseId}_1`,
    eventId: 'evt_03',
    sequence,
    actionKey: 'act.signin-log-correlation',
    label: 'Correlate sign-in logs',
    kind: 'log_query',
    executorRole: 'support_engineer',
    startedAt: at(20 + sequence * 30),
    durationMinutes: 15,
    customerEffort: 'none',
    customerEffortScore: 0,
    operationalRisk: 0.05,
    destructive: false,
    tokenEstimate: 400,
    computeUnits: 1,
    targetHypothesisIds: [],
    statedHypothesisId: null,
    realizedInformationGainBits: 0.6,
    informationGainClass: 'moderate',
    repeatOfActionId: null,
    isRepeat: false,
    lowValue: false,
    lowValueReasons: [],
    relativeValueAtDecision: 0.8,
    ...overrides,
  };
}

export function buildFork(overrides: Partial<DecisionFork> = {}): DecisionFork {
  const caseId = overrides.caseId ?? 'case_alpha';
  return {
    ...meta(overrides.tenantId ?? TENANT_A, at(101)),
    id: `fork_${caseId}_1`,
    caseId,
    analysisRunId: `run_${caseId}_1`,
    sequence: 0,
    timestamp: at(50),
    eventId: 'evt_06',
    title: 'Client reset requested before scoping',
    summary: 'The engineer asked for a client reset before scoping the failure.',
    category: 'low_value_action',
    additionalCategories: [],
    severity: 'medium',
    impactScore: 0.5,
    isEarliestMeaningful: true,
    ruleIds: ['rule.low-value'],
    actual: {
      actionKey: 'act.reset-client-state',
      label: 'Reset client state',
      kind: 'client_diagnostic',
      eventId: 'evt_06',
      customerEffort: 'medium',
      operationalRisk: 0.1,
      destructive: false,
      actionValue: 0.2,
      relativeValue: 0.3,
    },
    informationAvailable: {
      eventIds: ['evt_01', 'evt_02'],
      evidenceIds: [],
      claimIds: [],
      summary: 'Two events were available.',
    },
    informationUnavailable: ['Proxy logs had not been requested yet.'],
    posteriorAtDecision: [],
    alternatives: [],
    consequences: {
      actual: {
        timeToUsefulEvidenceMinutes: { low: 30, mid: 60, high: 120 },
        customerEffortScore: 0.5,
        tokenEstimate: 800,
        riskLevel: 'low',
        estimated: true,
      },
      bestAlternative: null,
      deltaSummary: 'Synthetic estimate only.',
    },
    uncertainty: { level: 'medium', score: 0.4, rationale: 'Synthetic.', rankStability: 0.7 },
    risk: 'low',
    eligibility: { eligible: true, boundary: at(50), checks: [], reasons: [] },
    retrospective: null,
    reviewState: 'pending',
    reviewReason: null,
    ...overrides,
  };
}

export function buildQuality(overrides: Partial<QualityAssessment> = {}): QualityAssessment {
  const caseId = overrides.caseId ?? 'case_alpha';
  return {
    ...meta(overrides.tenantId ?? TENANT_A, at(101)),
    id: `qa_${caseId}_1`,
    caseId,
    analysisRunId: `run_${caseId}_1`,
    asOf: null,
    compositeScore: 72,
    compositeLow: 65,
    compositeHigh: 79,
    band: 'adequate',
    dimensions: DIMENSIONS.map(([key, label, weight]) => ({
      key,
      label,
      weight,
      rawScore: 75,
      penaltyPoints: 3,
      score: 72,
      low: 65,
      high: 79,
      subChecks: [],
      rationale: `Synthetic rationale for ${label}.`,
    })),
    penalties: [],
    totalPenaltyPoints: 0,
    penaltyCapApplied: false,
    improvements: [],
    estimatedScoreAfterImprovements: {
      score: 80,
      low: 72,
      high: 86,
      method: 'Synthetic estimate.',
    },
    configVersion: '1.0.0',
    weights: Object.fromEntries(DIMENSIONS.map(([key, , weight]) => [key, weight])),
    uncertaintyNote: 'Synthetic estimate; not a measurement.',
    estimated: true,
    ...overrides,
  };
}

export function buildMetric(overrides: Partial<MetricEstimate> = {}): MetricEstimate {
  const caseId = overrides.caseId ?? 'case_alpha';
  const key = overrides.key ?? 'case_quality_index';
  return {
    ...meta(overrides.tenantId ?? TENANT_A, at(101)),
    id: `met_${caseId}_${key}`,
    caseId,
    analysisRunId: `run_${caseId}_1`,
    key,
    label: 'Case Quality Index',
    value: 72,
    unit: 'score',
    display: '72 / 100',
    low: 65,
    high: 79,
    confidence: 'medium',
    status: 'watch',
    definition: 'Weighted composite of six quality dimensions.',
    method: 'Synthetic estimate.',
    assumptions: [],
    contributors: [],
    comparison: null,
    ase: null,
    estimated: true,
    synthetic: true,
    ...overrides,
  };
}

export function buildWarning(overrides: Partial<CaseWarning> = {}): CaseWarning {
  const caseId = overrides.caseId ?? 'case_alpha';
  const ruleId = overrides.ruleId ?? 'rule.missing-scope';
  return {
    ...meta(overrides.tenantId ?? TENANT_A, at(101)),
    id: `warn_${caseId}_${ruleId.replace(/[^a-z0-9]/gi, '_')}`,
    caseId,
    analysisRunId: `run_${caseId}_1`,
    ruleId,
    category: 'scoping',
    priority: 'high',
    rank: 1,
    title: 'Scope of impact is not established',
    message: 'The number of affected users was never confirmed.',
    suggestedAction: 'Ask how many users are affected.',
    evidence: [],
    fingerprint: `${ruleId}:scope`,
    raisedAt: at(20),
    resolvedAt: null,
    resolvedReason: null,
    state: 'open',
    dismissal: null,
    ...overrides,
  };
}

export function buildCoaching(overrides: Partial<CoachingReport> = {}): CoachingReport {
  const caseId = overrides.caseId ?? 'case_alpha';
  return {
    caseId,
    analysisRunId: `run_${caseId}_1`,
    generatedAt: at(101),
    summary: 'Synthetic coaching summary.',
    wentWell: [],
    missedOpportunity: null,
    evidenceQuality: [],
    reasoningImprovements: [],
    communicationImprovements: [],
    customerEffortImprovements: [],
    recommendedNextAction: null,
    relevantSkills: [],
    confidence: { level: 'medium', rationale: 'Synthetic.' },
    limitations: ['Synthetic data only.'],
    notice: 'Supportive decision support, not a performance rating.',
    ...overrides,
  };
}

export interface SnapshotOptions {
  runId?: string;
  inputHash?: string;
  /** Replaces generated warnings (e.g. to give them stable fingerprints across re-runs). */
  warnings?: CaseWarning[];
}

/**
 * A full, internally consistent analysis snapshot for an ingested case: two hypotheses, three
 * pieces of evidence cited from real events, their links, three claims, one fork, a six-dimension
 * quality assessment, two metrics, two warnings and two model executions.
 */
export function buildSnapshot(
  input: IngestCaseInput,
  options: SnapshotOptions = {},
): AnalysisSnapshot {
  const tenantId = input.case.tenantId;
  const caseId = input.case.id;
  const runId = options.runId ?? `run_${caseId}_1`;
  const eventIds = input.events.map((event) => event.id);
  const eventAt = (index: number): string => input.events[index]?.timestamp ?? at(index * 10);
  const eventId = (index: number): string =>
    eventIds[Math.min(index, eventIds.length - 1)] ?? 'evt_01';
  const common = { tenantId, caseId, analysisRunId: runId };

  const hypotheses = [
    buildHypothesis({
      ...common,
      key: 'hyp.proxy',
      id: `hyp_${caseId}_proxy`,
      currentConfidence: 0.6,
    }),
    buildHypothesis({
      ...common,
      key: 'hyp.identity',
      id: `hyp_${caseId}_identity`,
      name: 'Identity provider outage',
      currentConfidence: 0.25,
      currentStatus: 'active',
    }),
  ];
  const evidence = [1, 2, 3].map((index) =>
    buildEvidence({
      ...common,
      eventId: eventId(index),
      id: `ev_${caseId}_${index}`,
      observedAt: eventAt(index),
      signalId: `sig.synthetic-${index}`,
    }),
  );
  const links = hypotheses.flatMap((hypothesis) =>
    evidence.map((item) =>
      buildLink({
        ...common,
        id: `lnk_${hypothesis.id}_${item.id}`,
        hypothesisId: hypothesis.id,
        evidenceId: item.id,
        observedAt: item.observedAt,
      }),
    ),
  );
  const claims = [0, 1, 2].map((index) =>
    buildClaim({
      ...common,
      id: `clm_${caseId}_${index + 1}`,
      eventId: eventId(index),
      timestamp: eventAt(index),
      text: `Synthetic claim ${index + 1} from event ${eventId(index)}.`,
      relatedHypothesisIds: index === 0 ? [hypotheses[0]?.id ?? ''] : [],
      flags: index === 2 ? ['assumption_as_fact'] : [],
      category: index === 2 ? 'engineer_assumption' : 'customer_reported',
      aiCategory: index === 2 ? 'engineer_assumption' : 'customer_reported',
    }),
  );
  const run = buildAnalysisRun({
    tenantId,
    caseId,
    id: runId,
    inputHash: options.inputHash ?? `hash-${caseId}-${runId}`,
    counts: {
      events: input.events.length,
      evidence: evidence.length,
      claims: claims.length,
      hypotheses: hypotheses.length,
      actions: 2,
      forks: 1,
      warnings: 2,
      modelExecutions: 2,
    },
  });
  const warnings = options.warnings ?? [
    buildWarning({
      ...common,
      id: `warn_${caseId}_scope`,
      ruleId: 'rule.missing-scope',
      rank: 1,
      fingerprint: 'rule.missing-scope:scope',
    }),
    buildWarning({
      ...common,
      id: `warn_${caseId}_logs`,
      ruleId: 'rule.missing-logs',
      rank: 2,
      priority: 'medium',
      category: 'evidence',
      fingerprint: 'rule.missing-logs:proxy',
      raisedAt: eventAt(2),
    }),
  ];
  return {
    run,
    twin: buildDigitalTwin({ caseId, analysisRunId: runId, participants: input.participants }),
    evidence,
    links,
    claims,
    missing: [buildMissingEvidence({ id: `miss_${caseId}_proxy_logs` })],
    hypotheses,
    actions: [
      buildAction({
        ...common,
        id: `act_${caseId}_1`,
        sequence: 0,
        eventId: eventId(2),
        startedAt: eventAt(2),
      }),
      buildAction({
        ...common,
        id: `act_${caseId}_2`,
        sequence: 1,
        eventId: eventId(5),
        startedAt: eventAt(5),
        actionKey: 'act.reset-client-state',
        label: 'Reset client state',
        kind: 'client_diagnostic',
      }),
    ],
    forks: [
      buildFork({ ...common, id: `fork_${caseId}_1`, eventId: eventId(5), timestamp: eventAt(5) }),
    ],
    quality: buildQuality({ ...common, id: `qa_${caseId}_${runId}` }),
    metrics: [
      buildMetric({ ...common, key: 'case_quality_index', id: `met_${caseId}_cqi` }),
      buildMetric({
        ...common,
        key: 'avoidable_support_effort',
        id: `met_${caseId}_ase`,
        label: 'Avoidable Support Effort',
        value: 31,
        unit: 'percent',
        display: '31%',
        ase: {
          components: [
            {
              key: 'engineer_effort',
              label: 'Engineer effort',
              unit: 'minutes',
              total: 120,
              avoidable: 40,
              avoidablePct: 33,
              weight: 1,
              assumption: 'Synthetic assumption.',
              evidence: [],
            },
          ],
          method: 'Synthetic estimate.',
          counterfactual: null,
        },
      }),
    ],
    warnings,
    coaching: buildCoaching({ caseId, analysisRunId: runId }),
    skillMatches: [],
    executions: [
      buildExecution({
        tenantId,
        caseId,
        analysisRunId: runId,
        id: `exe_${caseId}_${runId}_1`,
        agent: 'evidence_classifier',
      }),
      buildExecution({
        tenantId,
        caseId,
        analysisRunId: runId,
        id: `exe_${caseId}_${runId}_2`,
        agent: 'hypothesis_generator',
      }),
    ],
  };
}
