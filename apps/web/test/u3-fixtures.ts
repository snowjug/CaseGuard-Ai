import {
  AnalyticsOverviewSchema,
  CaseComparisonSchema,
  CaseWarningSchema,
  CoachingReportSchema,
  EfficiencyOverviewSchema,
  MetricEstimateSchema,
  ModelExecutionWithUsageSchema,
  QUALITY_DIMENSIONS,
  QUALITY_DIMENSION_LABELS,
  QualityAssessmentSchema,
  SkillApprovalSchema,
  SkillDetailSchema,
  SkillDiffSchema,
  SkillDnaSchema,
  SkillEffectivenessSchema,
  SkillMatchSchema,
  SkillPrecedentComparisonSchema,
  SkillValidationSchema,
  SkillVersionSchema,
  METRIC_DEFINITIONS,
  type AnalyticsOverview,
  type CaseComparison,
  type CaseWarning,
  type CoachingReport,
  type EfficiencyOverview,
  type MetricEstimate,
  type MetricKey,
  type ModelExecutionWithUsage,
  type QualityAssessment,
  type QualityDimension,
  type QualityDimensionKey,
  type SkillApproval,
  type SkillContent,
  type SkillDetail,
  type SkillDiff,
  type SkillDna,
  type SkillEffectiveness,
  type SkillMatch,
  type SkillPrecedentComparison,
  type SkillTransitionOption,
  type SkillValidation,
  type SkillVersion,
} from '@caseguard/schemas';
import { caseSummary, NOW } from './fixtures';

/**
 * Fixtures for the Quality Review, SkillDNA and Efficiency pages. Each factory validates its result with the real Zod
 * schema, so a fixture can never drift from the contract the UI consumes. Values mirror what the real API returns for
 * the two synthetic sample cases (Case One: poor quality, nine forks; Case Two: efficient).
 */

export const CASE_ID = 'case_1';
export const OTHER_CASE_ID = 'case_2';
export const RUN_ID = 'run_1';
export const SKILL_ID = 'skl_1';

const meta = {
  tenantId: 'tenant_demo',
  createdAt: NOW,
  updatedAt: NOW,
  createdBy: 'synthetic',
  version: 1,
};

// ---------------------------------------------------------------- quality index

const DIMENSION_NUMBERS: Record<
  QualityDimensionKey,
  [number, number, number, number, number, number]
> = {
  // weight, raw, penalty (dimension scale), score, low, high
  evidence_integrity: [0.25, 79.2, 56, 23.2, 19.2, 27.2],
  diagnostic_reasoning: [0.2, 56.3, 35, 21.3, 17.3, 25.3],
  scoping_completeness: [0.15, 66.8, 33.3, 33.5, 29.5, 37.5],
  customer_communication: [0.15, 49.3, 20, 29.3, 25.3, 33.3],
  resolution_validation: [0.15, 100, 0, 100, 96, 100],
  efficiency_proportionality: [0.1, 45, 30, 15, 11, 19],
};

export function dimension(
  key: QualityDimensionKey,
  overrides: Partial<QualityDimension> = {},
): QualityDimension {
  const [weight, rawScore, penaltyPoints, score, low, high] = DIMENSION_NUMBERS[key];
  return {
    key,
    label: QUALITY_DIMENSION_LABELS[key],
    weight,
    rawScore,
    penaltyPoints,
    score,
    low,
    high,
    subChecks: [
      {
        id: `${key}-1`,
        label: 'Contradicting evidence is acknowledged',
        score: 0.6,
        weight: 1,
        note: 'Two statements continued on a hypothesis that evidence on record contradicted.',
        evidence: [{ type: 'claim', id: 'clm_1', label: 'Resolver change was the cause' }],
        determinable: true,
      },
      {
        id: `${key}-2`,
        label: 'The recorded conclusion is supported',
        score: 1,
        weight: 1,
        note: 'Every closure statement was backed by validation evidence.',
        evidence: [],
        determinable: false,
      },
    ],
    rationale: 'Weakest check: Contradicting evidence is acknowledged (60%).',
    ...overrides,
  };
}

export function qualityAssessment(overrides: Partial<QualityAssessment> = {}): QualityAssessment {
  return QualityAssessmentSchema.parse({
    ...meta,
    id: 'qa_1',
    caseId: CASE_ID,
    analysisRunId: RUN_ID,
    asOf: null,
    compositeScore: 36,
    compositeLow: 32,
    compositeHigh: 39.4,
    band: 'poor',
    dimensions: QUALITY_DIMENSIONS.map((key) => dimension(key)),
    penalties: [
      {
        id: 'pen_1',
        key: 'unsupported_root_cause',
        label: 'Unsupported root-cause claim',
        points: 8,
        dimension: 'evidence_integrity',
        evidence: [{ type: 'claim', id: 'clm_1', label: 'Resolver change was the cause' }],
        rationale: '2 statements presented a cause as established without diagnostic evidence.',
      },
      {
        id: 'pen_2',
        key: 'ignored_contradiction',
        label: 'Ignored contradiction',
        points: 6,
        dimension: 'evidence_integrity',
        evidence: [{ type: 'fork', id: 'fork_1', label: 'Contradiction ignored' }],
        rationale: 'On 4 occasions work continued on a hypothesis the evidence contradicted.',
      },
    ],
    totalPenaltyPoints: 14,
    penaltyCapApplied: false,
    improvements: [
      {
        id: 'imp_1',
        title: 'Write causes as hypotheses until evidence supports them',
        description:
          'State the cause as a working hypothesis and cite the diagnostic evidence for it.',
        expectedScoreGain: 8,
        priority: 'critical',
        linkedPenaltyKey: 'unsupported_root_cause',
        linkedForkId: 'fork_1',
        evidence: [{ type: 'claim', id: 'clm_1', label: 'Resolver change was the cause' }],
      },
      {
        id: 'imp_2',
        title: 'Send proactive updates so the customer does not have to chase',
        description: 'Tell the customer what happens next in every message.',
        expectedScoreGain: 3.4,
        priority: 'medium',
        linkedPenaltyKey: null,
        linkedForkId: null,
        evidence: [],
      },
    ],
    estimatedScoreAfterImprovements: {
      score: 68.2,
      low: 52.1,
      high: 76.2,
      method:
        'Assumes each listed improvement is applied. 80% of that gain is assumed to materialise. An estimate for planning, not a prediction.',
    },
    configVersion: '1.0.0',
    weights: Object.fromEntries(QUALITY_DIMENSIONS.map((key) => [key, DIMENSION_NUMBERS[key][0]])),
    uncertaintyNote:
      'Model estimate from a rule-based analysis of the case record; the plausible range is 32–39.4. It is decision support for focusing a human review, never a verdict about a person.',
    estimated: true,
    ...overrides,
  });
}

/** The same assessment as scored inside a time window: resolution validation is not assessable yet (weight 0). */
export function qualityAsOf(asOf: string): QualityAssessment {
  const base = qualityAssessment();
  return qualityAssessment({
    asOf,
    compositeScore: 37.8,
    compositeLow: 21.6,
    compositeHigh: 47.3,
    dimensions: base.dimensions.map((d) =>
      d.key === 'resolution_validation'
        ? { ...d, weight: 0, rawScore: 50, score: 50, low: 0, high: 100, penaltyPoints: 0 }
        : d,
    ),
    uncertaintyNote:
      'Model estimate; the plausible range is 21.6–47.3. Not yet assessable and left out of the composite: Resolution validation. Scored as of 2026-03-09 12:30 UTC using only information available then.',
  });
}

// ---------------------------------------------------------------- metrics (incl. Avoidable Support Effort)

const ASE_COMPONENTS = [
  ['engineer_effort', 'Engineer effort', 'steps', 9, 1, 11.1, 0.1579],
  ['customer_effort', 'Customer effort', 'customer minutes', 410, 300, 73.2, 0.2105],
  ['waiting_time', 'Waiting time to diagnosis', 'minutes', 2994, 2548.95, 85.1, 0.2105],
  ['token_usage', 'Token usage', 'tokens', 40850, 32950, 80.7, 0.0526],
] as const;

export function metricEstimate(
  key: MetricKey,
  overrides: Partial<MetricEstimate> = {},
): MetricEstimate {
  const definition = METRIC_DEFINITIONS[key];
  const isAse = key === 'avoidable_support_effort';
  return MetricEstimateSchema.parse({
    ...meta,
    id: `met_${key}`,
    caseId: CASE_ID,
    analysisRunId: RUN_ID,
    key,
    label: definition.label,
    value: isAse ? 55.3 : 36,
    unit: definition.unit,
    display: isAse ? '55% (estimate)' : '36 / 100',
    low: isAse ? 43.6 : 32,
    high: isAse ? 83.2 : 39.4,
    confidence: isAse ? 'low' : 'high',
    status: 'poor',
    definition: definition.definition,
    method: isAse
      ? 'ASE = sum(weight x avoidable share) over the effort components that have data. Counterfactual paths are simulated from the knowledge pack using only information available at that moment, so every figure is an estimate.'
      : definition.formula,
    assumptions: isAse
      ? [
          'Outcome probabilities come from knowledge-pack likelihoods, not from the real environment.',
          'Every value shown is a simulated estimate, labelled as such wherever it appears.',
        ]
      : ['Weights and penalty points come from quality configuration 1.0.0.'],
    contributors: isAse
      ? [
          {
            label: 'Waiting time to diagnosis',
            value: 17.9,
            unit: 'percentage points',
            share: 0.324,
            evidence: [{ type: 'scenario', id: 'scn_1', label: 'Lowest customer effort' }],
          },
          {
            label: 'Customer effort',
            value: 15.4,
            unit: 'percentage points',
            share: 0.279,
            evidence: [{ type: 'fork', id: 'fork_1', label: 'Heavy customer request' }],
          },
        ]
      : [],
    comparison: isAse
      ? {
          actual: 100,
          counterfactual: 44.7,
          counterfactualLow: 16.8,
          counterfactualHigh: 56.4,
          scenarioId: 'scn_1',
        }
      : null,
    ase: isAse
      ? {
          method:
            'ASE = sum(weight x avoidable share) over the effort components that have data. Every figure is an estimate.',
          counterfactual: {
            scenarioId: 'scn_1',
            actualPct: 100,
            counterfactualPct: 44.7,
            counterfactualLowPct: 16.8,
            counterfactualHighPct: 56.4,
          },
          components: ASE_COMPONENTS.map(([k, label, unit, total, avoidable, pct, weight]) => ({
            key: k,
            label,
            unit,
            total,
            avoidable,
            avoidablePct: pct,
            weight,
            assumption: `${label} is counted from the real path; the alternative is the simulated median.`,
            evidence: [{ type: 'scenario', id: 'scn_1', label: 'Lowest customer effort' }],
          })),
        }
      : null,
    estimated: true,
    synthetic: true,
    ...overrides,
  });
}

export function metricEstimates(): MetricEstimate[] {
  return [
    metricEstimate('case_quality_index'),
    metricEstimate('evidence_integrity', {
      value: 23.2,
      display: '23 / 100',
      low: 19.2,
      high: 27.2,
    }),
    metricEstimate('avoidable_support_effort'),
    metricEstimate('reasoning_efficiency', {
      value: 30.8,
      display: '31 / 100',
      low: 20.8,
      high: 40.8,
      confidence: 'medium',
    }),
    metricEstimate('customer_effort', {
      value: 430,
      display: '430 min (estimated)',
      unit: 'minutes',
      low: 301,
      high: 602,
      confidence: 'medium',
    }),
    metricEstimate('resolution_confidence', {
      value: 92.6,
      display: '93% (model estimate)',
      unit: 'percent',
      low: 92.6,
      high: 92.6,
      status: 'good',
    }),
    metricEstimate('token_efficiency', {
      value: 0.029,
      display: '0.029 bits per 1k tokens (simulated telemetry)',
      unit: 'bits_per_1k_tokens',
      low: 0.026,
      high: 0.032,
      confidence: 'medium',
    }),
  ];
}

/** The metrics as computed inside a time window: Avoidable Support Effort cannot be estimated there. */
export function metricEstimatesAsOf(): MetricEstimate[] {
  return metricEstimates().map((m) =>
    m.key === 'avoidable_support_effort'
      ? {
          ...m,
          value: null,
          display: 'Not available',
          low: null,
          high: null,
          status: 'unknown',
          comparison: null,
          ase: {
            ...(m.ase ?? { method: '', counterfactual: null }),
            components: [],
            counterfactual: null,
          },
        }
      : m,
  );
}

// ---------------------------------------------------------------- live warnings

export function warning(overrides: Partial<CaseWarning> = {}): CaseWarning {
  return CaseWarningSchema.parse({
    ...meta,
    id: 'wrn_1',
    caseId: CASE_ID,
    analysisRunId: RUN_ID,
    ruleId: 'LQ-TRB-03',
    category: 'troubleshooting',
    priority: 'critical',
    rank: 1,
    title: 'Disruptive change made before the cause was established',
    message: 'Sessions were revoked before the working hypothesis had supporting evidence.',
    suggestedAction: 'Hold disruptive changes until a diagnostic test supports the cause.',
    evidence: [
      { type: 'event', id: 'e09', label: 'Revoke sign-in sessions' },
      { type: 'fork', id: 'fork_1', label: 'Disruptive change' },
    ],
    fingerprint: 'LQ-TRB-03:e09',
    raisedAt: '2026-03-09T12:25:00Z',
    resolvedAt: null,
    resolvedReason: null,
    state: 'open',
    dismissal: null,
    ...overrides,
  });
}

export function warningList(): CaseWarning[] {
  return [
    warning(),
    warning({
      id: 'wrn_2',
      ruleId: 'LQ-EVD-02',
      category: 'evidence',
      priority: 'high',
      rank: 2,
      title: 'Root cause stated without supporting evidence',
      message: 'The cause was written as established fact before diagnostic evidence existed.',
      suggestedAction: 'Word it as a hypothesis and cite the evidence that would confirm it.',
      evidence: [{ type: 'claim', id: 'clm_1', label: 'Resolver change was the cause' }],
      fingerprint: 'LQ-EVD-02:clm_1',
      raisedAt: '2026-03-09T12:10:00Z',
    }),
    warning({
      id: 'wrn_3',
      ruleId: 'LQ-COM-01',
      category: 'communication',
      priority: 'medium',
      rank: 3,
      title: 'The customer is waiting for a reply',
      message: 'No reply has been sent for more than 12 hours.',
      suggestedAction: 'Send a short update that says what happens next.',
      evidence: [{ type: 'event', id: 'e12', label: 'Customer message' }],
      fingerprint: 'LQ-COM-01:e12',
      raisedAt: '2026-03-09T21:45:00Z',
      resolvedAt: '2026-03-10T17:45:00Z',
      resolvedReason: 'The customer was answered (as of 2026-03-10 17:45 UTC).',
      state: 'resolved',
    }),
  ];
}

// ---------------------------------------------------------------- coaching

export function coachingReport(overrides: Partial<CoachingReport> = {}): CoachingReport {
  return CoachingReportSchema.parse({
    caseId: CASE_ID,
    analysisRunId: RUN_ID,
    generatedAt: NOW,
    summary:
      'This is a supportive, estimate-based review of how the case unfolded, written to help with reflection; it is not a rating of a person.',
    wentWell: [
      {
        title: 'A well-chosen test at the decisive moment',
        detail: 'The DNS resolver comparison was the highest-value safe step at that point.',
        evidence: [{ type: 'event', id: 'e24', label: 'Resolver comparison' }],
        skillId: null,
      },
    ],
    missedOpportunity: {
      title: 'Hold disruptive changes until the cause is supported',
      detail:
        'In hindsight, revoking sessions did not help. At the time the record showed 8 events and a leading hypothesis of 73%.',
      evidence: [{ type: 'fork', id: 'fork_1', label: 'Disruptive change' }],
      skillId: null,
    },
    evidenceQuality: [
      {
        title: 'Keep hypotheses worded as hypotheses',
        detail: 'Cite the evidence that would confirm the cause.',
        evidence: [],
        skillId: null,
      },
    ],
    reasoningImprovements: [
      {
        title: 'Check the record before repeating',
        detail: 'The same query ran twice.',
        evidence: [],
        skillId: null,
      },
    ],
    communicationImprovements: [
      {
        title: 'Say what happens next in every message',
        detail: 'Customers wait less when they know the plan.',
        evidence: [],
        skillId: null,
      },
    ],
    customerEffortImprovements: [
      {
        title: 'Start with the lightest request',
        detail: 'Ask for the minimum data first.',
        evidence: [],
        skillId: null,
      },
    ],
    recommendedNextAction: {
      title: 'For the next similar case: write causes as hypotheses',
      detail: 'State the cause as a working hypothesis and cite the evidence.',
      evidence: [],
      skillId: SKILL_ID,
    },
    relevantSkills: [
      { skillId: SKILL_ID, name: 'Isolate a pre-authentication failure', matchScore: 0.75 },
    ],
    confidence: {
      level: 'medium',
      rationale: 'Based on 31 recorded events and 9 decision points.',
    },
    limitations: [
      'Scores and comparisons are model estimates, not measurements.',
      'This case is synthetic; figures demonstrate the method.',
    ],
    notice:
      'Supportive decision support, not a performance rating. It must not be used to rank, rate or discipline individual employees.',
    ...overrides,
  });
}

// ---------------------------------------------------------------- skills

export function skillContent(overrides: Partial<SkillContent> = {}): SkillContent {
  return {
    name: 'Isolate a pre-authentication failure before pursuing identity policy',
    description:
      'Collect the minimum scoping data, rule out cheap global causes, prove whether the failing attempts reached the identity service, then isolate the failing hop.',
    product: 'Microsoft Teams',
    workload: 'teams-authentication',
    triggerConditions: [
      {
        id: 'trg-intermittent',
        description: 'Failures are intermittent',
        kind: 'signal',
        weight: 0.25,
        required: true,
      },
      {
        id: 'trg-dns',
        description: 'Client reports a name-resolution failure (hindsight-informed)',
        kind: 'signal',
        weight: 0.246,
        required: false,
      },
    ],
    exclusions: [],
    requiredInputs: [
      {
        key: 'failure-timestamps',
        label: 'Failure timestamps',
        description: 'Exact UTC times.',
        required: true,
      },
    ],
    minimumEvidence: [
      {
        requirementId: 'req_error',
        label: 'Exact client error code',
        description: 'The text or code shown.',
      },
    ],
    decisionSequence: [
      {
        id: 'step-1',
        order: 1,
        title: 'Ask for minimal scoping data',
        instruction: 'Ask for three read-only items so customer effort stays low.',
        actionKey: 'act.request-minimal-scoping',
        expectedInformationGainBits: 0.531,
        requiresInputs: [],
        branches: [
          {
            condition: 'Error tag indicates name resolution failure',
            next: 'step-2',
            rationale: 'Points at DNS before identity policy.',
            probability: 0.196,
            hindsightProbability: 0.871,
          },
        ],
      },
      {
        id: 'step-2',
        order: 2,
        title: 'Compare name resolution across each DNS resolver',
        instruction: 'Run the read-only query from an affected site.',
        actionKey: 'act.dns-resolver-comparison',
        expectedInformationGainBits: 0.438,
        requiresInputs: [],
        branches: [],
      },
    ],
    candidateActions: [
      {
        actionKey: 'act.request-minimal-scoping',
        label: 'Ask for minimal scoping data',
        whenToUse: 'First request to the customer.',
        risk: 'low',
        customerEffort: 'low',
        requiresApproval: false,
      },
    ],
    stopConditions: ['A matching incident is active.'],
    successConditions: ['One resolver fails while others answer.'],
    escalationConditions: ['Evidence points at a platform fault.'],
    safetyConstraints: ['Never run a remediation step before the cause is confirmed.'],
    queryTemplates: [
      {
        id: 'tpl-dns',
        language: 'powershell',
        title: 'Compare name resolution across each DNS resolver (PowerShell)',
        description: 'Read-only DNS queries.',
        template: 'Resolve-DnsName -Name {{hostname}} -Server {{resolver}}',
        parameters: [{ name: 'hostname', description: 'A sign-in endpoint host' }],
        safetyNote: 'Read-only.',
      },
    ],
    knownFailureModes: ['DNS security policy blocks a CDN category.'],
    sourceCases: [{ caseId: CASE_ID, reference: 'CG-SYN-1001', role: 'origin' }],
    confidence: {
      score: 0.6,
      rationale: 'Model estimate, capped at 60% because one source case supports it.',
    },
    validationCriteria: [
      'Replaying the skill on its source case reaches a confirmed diagnosis sooner.',
    ],
    applicability: {
      scope: 'Microsoft Teams: failures are intermittent and affect several users.',
      validatedOnCases: 1,
      limitations: ['Distilled from one synthetic source case.'],
    },
    expectedBenefit: {
      estimated: true,
      simulated: true,
      basis: 'Replay at the source decision point, compared with the recorded path of CG-SYN-1001.',
      timeSavedMinutes: { low: 2641.5, mid: 2799, high: 2879.2 },
      customerEffortSavedMinutes: { low: 390, mid: 390, high: 390 },
      tokensSaved: { low: 35550, mid: 35550, high: 35550 },
      caveats: ['Estimated, not measured: nothing was executed.'],
    },
    provenance: {
      caseId: CASE_ID,
      caseReference: 'CG-SYN-1001',
      forkId: 'fork_1',
      scenarioId: 'scn_1',
      analysisRunId: RUN_ID,
      strategy: 'balanced',
      extractedAt: NOW,
      hindsight: {
        used: true,
        resolutionHypothesisKey: 'hyp.dns-resolution',
        parts: ['triggerConditions.trg-dns', 'decisionSequence.*.branches.hindsightProbability'],
        notice:
          'Parts listed as hindsight were derived with knowledge of the recorded resolution. Trigger conditions among them count towards matching; branch probabilities do not.',
      },
      decisionTimeParts: [
        'triggerConditions.trg-intermittent',
        'decisionSequence.*.branches.probability',
      ],
      labels: { simulated: true, estimated: true, synthetic: true },
    },
    ...overrides,
  };
}

/** What the API says about the comparison with the case the skill came from (`basis` is fixed wording of the aggregator). */
export const PRECEDENT_BASIS =
  'Compared with the recorded path of the case the skill came from (1 earlier case); different cases, no control group: an estimate, not a measurement.';

/** The note the API adds to `effectiveness.notes` when both comparisons are shown. */
export const TWO_BASES_NOTE =
  'Two bases are shown, and both are estimates: a seeded simulation of the knowledge-pack policy without the skill (it has no waiting between steps, so recorded times read longer than it by construction) and the recorded path of the case the skill came from (a different case, with no control group).';

/** The like-for-like comparison with the numbers of the demo: Case Two (183 min) against the Case One it came from (2,994 min). */
export function skillPrecedent(
  overrides: Partial<SkillPrecedentComparison> = {},
): SkillPrecedentComparison {
  return SkillPrecedentComparisonSchema.parse({
    cases: 1,
    references: ['CG-SYN-1001'],
    avgTimeToDiagnosisMinutes: 183,
    precedentAvgTimeToDiagnosisMinutes: 2994,
    tokenChangePct: -79.5,
    evidenceCompletenessPoints: 0,
    basis: PRECEDENT_BASIS,
    ...overrides,
  });
}

/**
 * The effectiveness of the demo skill. The simulated baseline reads "longer" and "830% more tokens" by construction
 * (it has no waiting between steps); the precedent is the like-for-like comparison. Pass `precedent: undefined` for a
 * record that has none.
 */
export function skillEffectiveness(
  overrides: Partial<SkillEffectiveness> = {},
): SkillEffectiveness {
  return SkillEffectivenessSchema.parse({
    applications: 1,
    matchedCases: 1,
    avgTimeToDiagnosisMinutes: 183,
    baselineAvgTimeToDiagnosisMinutes: 122.3,
    conformanceAvg: 1,
    estimatedTokenSavingsPct: -830,
    notes: [
      'Estimated from 1 recorded application; figures are model estimates, not measurements.',
      TWO_BASES_NOTE,
      'No engineer-level data is used: usage is aggregated per skill.',
    ],
    synthetic: true,
    estimated: true,
    precedent: skillPrecedent(),
    ...overrides,
  });
}

export function skillDna(overrides: Partial<SkillDna> = {}): SkillDna {
  return SkillDnaSchema.parse({
    ...meta,
    version: 9,
    id: SKILL_ID,
    key: 'isolate-a-pre-authentication-failure',
    name: 'Isolate a pre-authentication failure before pursuing identity policy',
    description: 'Distilled from CG-SYN-1001 (synthetic).',
    workload: 'teams-authentication',
    product: 'Microsoft Teams',
    lifecycle: 'published',
    currentVersionId: 'skv_1',
    currentVersion: '1.0.0',
    owner: 'user_ava_engineer',
    reviewer: 'user_riley_reviewer',
    validationStatus: 'validated',
    lastValidatedAt: NOW,
    confidence: 0.6,
    sourceCaseIds: [CASE_ID],
    effectiveness: skillEffectiveness(),
    hasProposedMutation: true,
    synthetic: true,
    createdBy: 'user_ava_engineer',
    ...overrides,
  });
}

export function skillVersion(overrides: Partial<SkillVersion> = {}): SkillVersion {
  return SkillVersionSchema.parse({
    ...meta,
    id: 'skv_1',
    skillId: SKILL_ID,
    version: '1.0.0',
    sequence: 1,
    parentVersionId: null,
    changeType: 'initial',
    changeSummary:
      'Extracted from CG-SYN-1001. Starts as Discovered: every lifecycle gate still needs a human.',
    state: 'active',
    lifecycleAtCreation: 'discovered',
    content: skillContent(),
    contentHash: 'c'.repeat(64),
    createdBy: 'user_ava_engineer',
    ...overrides,
  });
}

export function proposedVersion(overrides: Partial<SkillVersion> = {}): SkillVersion {
  return skillVersion({
    id: 'skv_2',
    version: '1.1.0',
    sequence: 2,
    parentVersionId: 'skv_1',
    changeType: 'mutation',
    changeSummary:
      'Proposed from CG-SYN-1002: Add trigger condition “Client reports a connection timeout”.',
    state: 'proposed',
    lifecycleAtCreation: 'published',
    contentHash: 'd'.repeat(64),
    createdBy: 'user_casey_curator',
    ...overrides,
  });
}

export function skillValidation(overrides: Partial<SkillValidation> = {}): SkillValidation {
  return SkillValidationSchema.parse({
    ...meta,
    id: 'skval_1',
    skillId: SKILL_ID,
    versionId: 'skv_1',
    kind: 'simulation_test',
    outcome: 'passed',
    caseId: CASE_ID,
    scope: 'full',
    checks: [
      {
        id: 'reaches-diagnosis',
        passed: true,
        detail: 'The replay reached a confirmed diagnosis.',
      },
      { id: 'no-more-effort', passed: true, detail: 'Estimated customer effort did not increase.' },
    ],
    executedBy: 'user_riley_reviewer',
    executedAt: NOW,
    synthetic: true,
    ...overrides,
  });
}

export function skillApproval(overrides: Partial<SkillApproval> = {}): SkillApproval {
  return SkillApprovalSchema.parse({
    ...meta,
    id: 'skp_1',
    skillId: SKILL_ID,
    versionId: 'skv_1',
    fromState: 'expert_reviewed',
    toState: 'pilot',
    decision: 'approved',
    approver: 'user_casey_curator',
    requestedBy: 'user_ava_engineer',
    reason: 'Approved for a pilot on the related follow-up case.',
    decidedAt: NOW,
    ...overrides,
  });
}

export function transitionOption(
  overrides: Partial<SkillTransitionOption> = {},
): SkillTransitionOption {
  return {
    toState: 'deprecated',
    allowed: true,
    reason: null,
    requiredPermission: 'skill:retire',
    requiresDistinctApprover: false,
    gate: null,
    ...overrides,
  };
}

const VersionSummarySchema = SkillVersionSchema.omit({ content: true });

/** A version as the detail's `versions` list carries it: the same record without its content. */
export function versionSummary(version: SkillVersion): SkillDetail['versions'][number] {
  return VersionSummarySchema.parse(version);
}

export function skillDetail(overrides: Partial<SkillDetail> = {}): SkillDetail {
  const current = skillVersion();
  const proposed = proposedVersion();
  return SkillDetailSchema.parse({
    skill: skillDna(),
    currentVersion: current,
    proposedVersion: proposed,
    versions: [versionSummary(current), versionSummary(proposed)],
    validations: [
      skillValidation(),
      skillValidation({ id: 'skval_2', kind: 'regression', caseId: null }),
      skillValidation({
        id: 'skval_3',
        versionId: 'skv_2',
        outcome: 'inconclusive',
        scope: 'case',
      }),
    ],
    approvals: [
      skillApproval({ id: 'skp_0', fromState: 'discovered', toState: 'draft' }),
      skillApproval(),
    ],
    matches: [
      {
        caseId: OTHER_CASE_ID,
        caseReference: 'CG-SYN-1002',
        score: 0.754,
        applicability: 'applies',
        applied: true,
      },
    ],
    transitions: [transitionOption()],
    notices: [
      'An AI-generated skill is never published automatically: every lifecycle step needs a person with the right permission.',
      'Confidence, branch probabilities and effectiveness are model estimates, not measurements.',
    ],
    ...overrides,
  });
}

export function skillDiff(overrides: Partial<SkillDiff> = {}): SkillDiff {
  return SkillDiffSchema.parse({
    skillId: SKILL_ID,
    fromVersion: '1.0.0',
    toVersion: '1.1.0',
    changes: [
      {
        section: 'triggerConditions',
        type: 'added',
        path: 'triggerConditions[trg-timeout]',
        before: null,
        after: 'Client reports a connection timeout',
        summary: 'Added trigger condition: Client reports a connection timeout',
      },
      {
        section: 'confidence',
        type: 'modified',
        path: 'confidence',
        before: '0.6',
        after: '0.7',
        summary: 'Changed confidence estimate 0.6 → 0.7',
      },
    ],
    summaryLines: [
      '2 changes between 1.0.0 and 1.1.0.',
      'Added trigger condition: Client reports a connection timeout',
    ],
    ...overrides,
  });
}

export function skillMatch(overrides: Partial<SkillMatch> = {}): SkillMatch {
  return SkillMatchSchema.parse({
    ...meta,
    id: 'smt_1',
    caseId: OTHER_CASE_ID,
    skillId: SKILL_ID,
    versionId: 'skv_1',
    skillName: 'Isolate a pre-authentication failure before pursuing identity policy',
    skillVersion: '1.0.0',
    lifecycle: 'published',
    asOf: '2026-04-14T07:35:00Z',
    score: 0.754,
    applicability: 'applies',
    matchedTriggers: [
      {
        id: 'trg-intermittent',
        description: 'Failures are intermittent',
        weight: 0.25,
        evidenceIds: ['evd_1'],
      },
      {
        id: 'trg-dns',
        description: 'A DNS change was deployed shortly before onset (hindsight-informed)',
        weight: 0.146,
        evidenceIds: ['evd_2'],
      },
    ],
    unmatchedTriggers: [
      { id: 'trg-name', description: 'Client reports a name-resolution failure', weight: 0.246 },
    ],
    exclusionsHit: [],
    rationale:
      'Applies (score 75%): 4 of 5 trigger conditions hold using only evidence available at 2026-04-14T07:35:00Z. The score is a model estimate, not a measurement.',
    recommendedSteps: [
      {
        stepId: 'step-1',
        title: 'Ask for minimal scoping data',
        instruction: 'Ask for three read-only items.',
        actionKey: 'act.request-minimal-scoping',
        status: 'recommended_next',
        rationale: 'Highest value safe step now.',
        actionValue: null,
      },
      {
        stepId: 'step-2',
        title: 'Compare name resolution across each DNS resolver',
        instruction: 'Run the read-only query.',
        actionKey: null,
        status: 'pending',
        rationale: 'After the scoping data arrives.',
        actionValue: null,
      },
    ],
    conformance: null,
    applied: false,
    appliedAt: null,
    appliedBy: null,
    ...overrides,
  });
}

// ---------------------------------------------------------------- compare, analytics

export function caseComparison(overrides: Partial<CaseComparison> = {}): CaseComparison {
  const one = caseSummary({
    id: CASE_ID,
    reference: 'CG-SYN-1001',
    qualityIndex: 36,
    avoidableEffortPct: 55.3,
  });
  const two = caseSummary({
    id: OTHER_CASE_ID,
    reference: 'CG-SYN-1002',
    title: 'Intermittent Teams sign-in failures at the Rotterdam site',
    qualityIndex: 99.1,
    avoidableEffortPct: 0,
  });
  return CaseComparisonSchema.parse({
    generatedAt: NOW,
    cases: [one, two],
    rows: [
      {
        metric: 'case_quality_index',
        label: 'Case Quality Index',
        unit: 'score',
        values: [
          { caseId: CASE_ID, value: 36, display: '36 / 100' },
          { caseId: OTHER_CASE_ID, value: 99.1, display: '99 / 100' },
        ],
        betterCaseId: OTHER_CASE_ID,
        deltaPct: 175.3,
        note: 'Higher is better. Both values are estimates.',
      },
      {
        metric: 'customer_effort',
        label: 'Customer Effort',
        unit: 'minutes',
        values: [
          { caseId: CASE_ID, value: 430, display: '430 min (estimated)' },
          { caseId: OTHER_CASE_ID, value: 50, display: '50 min (estimated)' },
        ],
        betterCaseId: OTHER_CASE_ID,
        deltaPct: -88.4,
        note: 'Lower is better. Both values are estimates.',
      },
      {
        metric: 'resolution_confidence',
        label: 'Resolution Confidence',
        unit: 'percent',
        values: [
          { caseId: CASE_ID, value: 92.6, display: '93% (model estimate)' },
          { caseId: OTHER_CASE_ID, value: 92.6, display: '93% (model estimate)' },
        ],
        betterCaseId: null,
        deltaPct: 0,
        note: 'Higher is better. Both values are estimates.',
      },
    ],
    narrative: [
      'CG-SYN-1002 shows the stronger estimate on 2 of the 3 metrics where both cases have a value and differ.',
      'All figures are model estimates, not measurements.',
    ],
    skillReuse: {
      skillId: SKILL_ID,
      skillName: 'Isolate a pre-authentication failure before pursuing identity policy',
      skillVersion: '1.0.0',
      matchScore: 0.754,
      conformance: 1,
      stepsFollowed: 4,
      stepsTotal: 4,
    },
    notice:
      'Differences between two cases are model estimates from the written record. They do not show cause and effect; use them to start a conversation, not to rate anyone.',
    labels: { synthetic: true, estimated: true },
    ...overrides,
  });
}

export function analyticsOverview(overrides: Partial<AnalyticsOverview> = {}): AnalyticsOverview {
  return AnalyticsOverviewSchema.parse({
    generatedAt: NOW,
    cohort: {
      caseCount: 2,
      analyzedCaseCount: 2,
      syntheticCaseCount: 2,
      note: 'n=2: with so few analysed cases, trends and averages are illustrative only.',
    },
    qualityTrend: [
      { period: '2026-03', caseCount: 1, avgQuality: 36, avgEvidenceIntegrity: 23.2 },
      { period: '2026-04', caseCount: 1, avgQuality: 99.1, avgEvidenceIntegrity: 100 },
    ],
    forkCategories: [
      { category: 'disproportionate_customer_effort', count: 2, share: 0.222 },
      { category: 'premature_destructive_action', count: 2, share: 0.222 },
      { category: 'assumption_as_fact', count: 1, share: 0.111 },
    ],
    missingEvidence: [
      { requirementId: 'req_trace', label: 'Client trace from an affected device', count: 1 },
    ],
    avoidableEffortPatterns: [
      { component: 'escalations', label: 'Escalations', avgAvoidablePct: 100, caseCount: 1 },
      {
        component: 'waiting_time',
        label: 'Waiting time to diagnosis',
        avgAvoidablePct: 85.1,
        caseCount: 1,
      },
    ],
    skillAdoption: {
      totalSkills: 1,
      published: 1,
      pilotOrValidated: 0,
      matchedCases: 1,
      appliedCases: 1,
    },
    skillEffectiveness: [
      {
        skillId: SKILL_ID,
        name: 'Isolate a pre-authentication failure',
        applications: 1,
        // Case Two (183 min) against the Case One the skill came from (2,994 min): (2994 - 183) / 2994.
        timeToDiagnosisDeltaPct: 93.9,
        timeToDiagnosisBasis: 'earlier_case',
        synthetic: true,
      },
    ],
    tokenEfficiency: { avgBitsPer1kTokens: 0.1, avgEstimatedSavingsPct: 91.1 },
    counterfactualAcceptance: { reviewed: 1, accepted: 1, rejected: 0, rate: 1 },
    reviewerDisagreement: { reviewedClaims: 0, corrected: 0, rate: null },
    frequentUnsupportedAssumptions: [
      { subject: 'Cause stated as established without supporting evidence', count: 2 },
    ],
    responsibleUseNotice:
      'CaseGuard AI supports quality review and coaching. It must not be used to rank, rate or discipline individual employees, and it never closes cases automatically.',
    privacyNotes: [
      'Only counts, averages and knowledge-pack labels are shown: no case text, customer names or participant identities.',
      'All quality scores and effort figures are model estimates, not measurements.',
    ],
    ...overrides,
  });
}

// ---------------------------------------------------------------- efficiency

export function efficiencyOverview(
  overrides: Partial<EfficiencyOverview> = {},
): EfficiencyOverview {
  return EfficiencyOverviewSchema.parse({
    generatedAt: NOW,
    totals: {
      executions: 12,
      promptTokens: 98562,
      completionTokens: 21136,
      cachedTokens: 0,
      totalTokens: 119698,
      estimatedCostUsd: null,
      avgLatencyMs: 67.8,
      cacheHitRate: 0,
      failureRate: 0,
    },
    byAgent: [
      {
        agent: 'quality_judge',
        executions: 2,
        promptTokens: 21615,
        completionTokens: 2618,
        cachedTokens: 0,
        avgLatencyMs: 81,
        cacheHitRate: 0,
        failures: 0,
        estimatedSavingsTokens: 0,
        budgetUtilization: 0.900625,
      },
      {
        agent: 'timeline_analyzer',
        executions: 2,
        promptTokens: 7607,
        completionTokens: 1577,
        cachedTokens: 0,
        avgLatencyMs: 75.5,
        cacheHitRate: 0,
        failures: 0,
        estimatedSavingsTokens: 0,
        budgetUtilization: 0.4754375,
      },
    ],
    byModel: [
      {
        model: 'deterministic-knowledge-pack',
        provider: 'deterministic',
        executions: 12,
        totalTokens: 119698,
        avgLatencyMs: 67.8,
      },
    ],
    savings: {
      contextCompressionTokens: 0,
      duplicateRemovalTokens: 0,
      cacheHitTokens: 0,
      earlyStopTokens: 0,
      totalTokens: 0,
      estimatedQualityImpact:
        'No context trimming, cache reuse or early stopping has saved tokens yet, so there is no quality impact to assess.',
    },
    budgets: {
      perRequestMaxTokens: 24000,
      perCaseMaxTokens: null,
      perDayMaxTokens: null,
      consumedToday: 119698,
      costLimitUsdPerDay: null,
    },
    circuitBreakers: [],
    caseProcess: {
      actualTokens: 40850,
      counterfactualTokens: 7900,
      estimatedSavingsPct: 80.7,
      caseId: null,
    },
    labels: { simulated: true, estimated: true },
    notes: [
      'Token counts and latencies come from the deterministic offline provider (simulated). Token figures are estimates, not Azure OpenAI usage.',
      'Cost is unknown: no unit prices are configured, and prices are never hard-coded.',
    ],
    ...overrides,
  });
}

export function modelExecution(overrides: Record<string, unknown> = {}): ModelExecutionWithUsage {
  return ModelExecutionWithUsageSchema.parse({
    ...meta,
    id: 'exec_1',
    caseId: CASE_ID,
    analysisRunId: RUN_ID,
    agent: 'quality_judge',
    promptVersionId: 'prompt_quality_judge_1.0.0',
    promptVersion: '1.0.0',
    provider: 'deterministic',
    model: 'deterministic-knowledge-pack',
    status: 'succeeded',
    attempts: 1,
    latencyMs: 51,
    startedAt: '2026-10-30T07:24:06.595Z',
    completedAt: '2026-10-30T07:24:06.646Z',
    inputEvidenceIds: ['evd_1'],
    validation: {
      schemaValid: true,
      citationsValid: true,
      policyValid: true,
      temporalValid: true,
      issues: [],
    },
    error: null,
    simulated: true,
    tokenUsageId: 'usage_1',
    resultSource: 'deterministic',
    retries: 0,
    repairAttempts: 0,
    usage: {
      ...meta,
      id: 'usage_1',
      modelExecutionId: 'exec_1',
      caseId: CASE_ID,
      agent: 'quality_judge',
      provider: 'deterministic',
      model: 'deterministic-knowledge-pack',
      promptTokens: 8058,
      completionTokens: 164,
      cachedTokens: 0,
      totalTokens: 8222,
      estimatedCostUsd: null,
      contextTokensBefore: 8058,
      contextTokensAfter: 8058,
      compressionRatio: 0,
      cacheHit: false,
      earlyStopped: false,
      estimatedSavingsTokens: 0,
      estimatedQualityImpact: { level: 'none', note: 'No compression was applied.' },
      latencyMs: 10,
      simulated: true,
      estimated: true,
      tokenSource: 'estimated',
    },
    ...overrides,
  });
}
