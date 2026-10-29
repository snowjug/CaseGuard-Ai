import type {
  CounterfactualScenario,
  CounterfactualStep,
  Job,
  ModelExecutionWithUsage,
  PromptVersion,
  ReviewDecision,
  SkillApproval,
  SkillContent,
  SkillDna,
  SkillMatch,
  SkillValidation,
  SkillVersion,
  User,
} from '@caseguard/schemas';
import { sha256Hex } from '../src/db/hash';
import type { AuditAppendInput } from '../src/db/repositories/types';
import { ACTOR, TENANT_A, at, meta } from './builders-common';

const range = (value: number) => ({ low: value * 0.8, mid: value, high: value * 1.2 });

export function buildExecution(
  overrides: Partial<ModelExecutionWithUsage> = {},
): ModelExecutionWithUsage {
  const tenantId = overrides.tenantId ?? TENANT_A;
  const id = overrides.id ?? 'exe_1';
  const agent = overrides.agent ?? 'evidence_classifier';
  const startedAt = overrides.startedAt ?? at(100);
  const latencyMs = overrides.latencyMs ?? 12;
  return {
    ...meta(tenantId, startedAt),
    id,
    caseId: 'case_alpha',
    analysisRunId: 'run_case_alpha_1',
    agent,
    promptVersionId: `pv_${agent}_1_0_0`,
    promptVersion: '1.0.0',
    provider: 'deterministic',
    model: 'deterministic-knowledge-pack',
    status: 'succeeded',
    attempts: 1,
    latencyMs,
    startedAt,
    completedAt: new Date(Date.parse(startedAt) + latencyMs).toISOString(),
    inputEvidenceIds: [],
    validation: {
      schemaValid: true,
      citationsValid: true,
      policyValid: true,
      temporalValid: true,
      issues: [],
    },
    error: null,
    simulated: true,
    tokenUsageId: `tok_${id}`,
    usage: {
      ...meta(tenantId, startedAt),
      id: `tok_${id}`,
      modelExecutionId: id,
      caseId: overrides.caseId === undefined ? 'case_alpha' : overrides.caseId,
      agent,
      provider: 'deterministic',
      model: 'deterministic-knowledge-pack',
      promptTokens: 1000,
      completionTokens: 200,
      cachedTokens: 0,
      totalTokens: 1200,
      estimatedCostUsd: null,
      contextTokensBefore: 1200,
      contextTokensAfter: 1000,
      compressionRatio: 0.17,
      cacheHit: false,
      earlyStopped: false,
      estimatedSavingsTokens: 200,
      estimatedQualityImpact: { level: 'negligible', note: 'Synthetic estimate.' },
      latencyMs,
      simulated: true,
      estimated: true,
    },
    ...overrides,
  };
}

export function buildPromptVersion(overrides: Partial<PromptVersion> = {}): PromptVersion {
  const template = overrides.template ?? 'Synthetic prompt template.';
  return {
    ...meta(overrides.tenantId ?? TENANT_A),
    id: 'pv_evidence_classifier_1_0_0',
    agent: 'evidence_classifier',
    version: '1.0.0',
    templateHash: sha256Hex(template),
    template,
    outputSchemaId: 'evidence-classifier.v1',
    status: 'active',
    changeNote: 'Initial synthetic prompt.',
    ...overrides,
  };
}

export function buildSkillContent(overrides: Partial<SkillContent> = {}): SkillContent {
  return {
    name: 'Proxy-blocked sign-in diagnosis',
    description: 'Synthetic skill: diagnose sign-in failures caused by a proxy rule.',
    product: 'Synthetic Collaboration Suite',
    workload: 'teams-authentication',
    triggerConditions: [
      {
        id: 'trg_multi_user',
        description: 'Several users fail to sign in',
        kind: 'signal',
        signalId: 'sig.multi-user-failure',
        weight: 0.7,
        required: true,
      },
    ],
    exclusions: [],
    requiredInputs: [],
    minimumEvidence: [],
    decisionSequence: [
      {
        id: 'step_logs',
        order: 1,
        title: 'Correlate sign-in logs',
        instruction: 'Correlate sign-in logs with the proxy log for the failing users.',
        actionKey: 'act.signin-log-correlation',
        expectedInformationGainBits: 0.8,
        requiresInputs: [],
        branches: [
          { condition: 'A block is visible', next: 'success', rationale: 'Confirms the proxy.' },
        ],
      },
    ],
    candidateActions: [],
    stopConditions: [],
    successConditions: [],
    escalationConditions: [],
    safetyConstraints: ['Never change production configuration without approval.'],
    queryTemplates: [],
    knownFailureModes: [],
    sourceCases: [],
    confidence: { score: 0.6, rationale: 'Synthetic confidence.' },
    ...overrides,
  };
}

export function buildSkillVersion(overrides: Partial<SkillVersion> = {}): SkillVersion {
  const content = overrides.content ?? buildSkillContent();
  return {
    ...meta(overrides.tenantId ?? TENANT_A),
    version: '1.0.0',
    id: 'skillv_proxy_1',
    skillId: 'skill_proxy',
    sequence: 1,
    parentVersionId: null,
    changeType: 'initial',
    changeSummary: 'Initial synthetic version.',
    state: 'active',
    lifecycleAtCreation: 'draft',
    content,
    contentHash: sha256Hex(JSON.stringify(content)),
    ...overrides,
  };
}

export function buildSkill(overrides: Partial<SkillDna> = {}): SkillDna {
  return {
    ...meta(overrides.tenantId ?? TENANT_A),
    id: 'skill_proxy',
    key: 'proxy-blocked-signin',
    name: 'Proxy-blocked sign-in diagnosis',
    description: 'Synthetic skill: diagnose sign-in failures caused by a proxy rule.',
    workload: 'teams-authentication',
    product: 'Synthetic Collaboration Suite',
    lifecycle: 'draft',
    currentVersionId: 'skillv_proxy_1',
    currentVersion: '1.0.0',
    owner: 'user_casey_curator',
    reviewer: null,
    validationStatus: 'unvalidated',
    lastValidatedAt: null,
    confidence: 0.6,
    sourceCaseIds: [],
    effectiveness: {
      applications: 0,
      matchedCases: 0,
      avgTimeToDiagnosisMinutes: null,
      baselineAvgTimeToDiagnosisMinutes: null,
      conformanceAvg: null,
      estimatedTokenSavingsPct: null,
      notes: [],
      synthetic: true,
      estimated: true,
    },
    hasProposedMutation: false,
    synthetic: true,
    ...overrides,
  };
}

export function buildSkillMatch(overrides: Partial<SkillMatch> = {}): SkillMatch {
  const caseId = overrides.caseId ?? 'case_alpha';
  const skillId = overrides.skillId ?? 'skill_proxy';
  return {
    ...meta(overrides.tenantId ?? TENANT_A, at(105)),
    id: `match_${caseId}_${skillId}`,
    caseId,
    skillId,
    versionId: 'skillv_proxy_1',
    skillName: 'Proxy-blocked sign-in diagnosis',
    skillVersion: '1.0.0',
    lifecycle: 'pilot',
    asOf: at(50),
    score: 0.7,
    applicability: 'applies',
    matchedTriggers: [
      {
        id: 'trg_multi_user',
        description: 'Several users fail to sign in',
        weight: 0.7,
        evidenceIds: [],
      },
    ],
    unmatchedTriggers: [],
    exclusionsHit: [],
    rationale: 'Synthetic rationale.',
    recommendedSteps: [],
    conformance: null,
    applied: false,
    appliedAt: null,
    appliedBy: null,
    ...overrides,
  };
}

export function buildSkillValidation(overrides: Partial<SkillValidation> = {}): SkillValidation {
  return {
    ...meta(overrides.tenantId ?? TENANT_A, at(110)),
    id: 'skillval_1',
    skillId: 'skill_proxy',
    versionId: 'skillv_proxy_1',
    kind: 'simulation_test',
    outcome: 'passed',
    caseId: null,
    checks: [{ id: 'chk_1', passed: true, detail: 'Synthetic check passed.' }],
    executedBy: 'system:simulator',
    executedAt: at(110),
    synthetic: true,
    ...overrides,
  };
}

export function buildSkillApproval(overrides: Partial<SkillApproval> = {}): SkillApproval {
  return {
    ...meta(overrides.tenantId ?? TENANT_A, at(120)),
    id: 'skillapp_1',
    skillId: 'skill_proxy',
    versionId: 'skillv_proxy_1',
    fromState: 'expert_reviewed',
    toState: 'pilot',
    decision: 'approved',
    approver: 'user_riley_reviewer',
    requestedBy: 'user_casey_curator',
    reason: 'Synthetic approval for tests.',
    decidedAt: at(120),
    ...overrides,
  };
}

export function buildJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job_1',
    tenantId: TENANT_A,
    kind: 'case_analysis',
    status: 'queued',
    caseId: null,
    targetId: null,
    progress: { percent: 0, stage: 'queued', stages: [] },
    error: null,
    resultRef: null,
    idempotencyKey: null,
    createdAt: at(0),
    startedAt: null,
    completedAt: null,
    createdBy: ACTOR,
    cancellable: true,
    ...overrides,
  };
}

export function buildReviewDecision(overrides: Partial<ReviewDecision> = {}): ReviewDecision {
  return {
    ...meta(overrides.tenantId ?? TENANT_A, at(130)),
    id: 'rev_1',
    caseId: 'case_alpha',
    targetType: 'claim',
    targetId: 'clm_case_alpha_1',
    decision: 'correct',
    originalValue: 'customer_reported',
    newValue: 'confirmed_fact',
    reason: 'Synthetic reviewer correction.',
    reviewerId: 'user_riley_reviewer',
    reviewerRole: 'reviewer',
    decidedAt: at(130),
    ...overrides,
  };
}

export function buildUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user_test',
    tenantId: TENANT_A,
    displayName: 'Test User (synthetic)',
    email: 'test.user@contoso-synthetic.invalid',
    roles: ['engineer'],
    status: 'active',
    synthetic: true,
    createdAt: at(0),
    updatedAt: at(0),
    version: 1,
    ...overrides,
  };
}

export function buildAuditInput(overrides: Partial<AuditAppendInput> = {}): AuditAppendInput {
  return {
    actorId: ACTOR,
    actorRole: 'engineer',
    action: 'case.ingested',
    targetType: 'case',
    targetId: 'case_alpha',
    caseId: 'case_alpha',
    outcome: 'success',
    details: { events: 6 },
    correlationId: 'corr-0001',
    ...overrides,
  };
}

const pathMetrics = (tokens: number) => ({
  actionCount: range(6),
  customerInteractions: range(3),
  timeToUsefulEvidenceMinutes: range(90),
  timeToDiagnosisMinutes: range(180),
  diagnosticVolume: range(4),
  tokenEstimate: range(tokens),
  customerEffortMinutes: range(60),
  operationalRisk: 0.1,
  informationGainBits: range(2),
  unsupportedBranches: 0,
});

export function buildScenarioStep(overrides: Partial<CounterfactualStep> = {}): CounterfactualStep {
  return {
    id: 'step_1',
    scenarioId: 'cf_case_alpha_fork_1_balanced',
    index: 0,
    offsetMinutes: range(10),
    simulatedAt: at(51),
    actionKey: 'act.signin-log-correlation',
    label: 'Correlate sign-in logs',
    kind: 'log_query',
    executor: 'engineer',
    rationale: 'Synthetic rationale for the simulated step.',
    evidenceUsedIds: [],
    priorStepIds: [],
    predictedOutcome: {
      outcomeId: 'out_block',
      label: 'Block found',
      probability: 0.7,
      simulatedResult: 'Synthetic simulated result.',
      alternatives: [],
    },
    expectedInformationGainBits: 0.8,
    posteriorAfter: [],
    customerEffort: 'none',
    operationalRisk: 0.05,
    tokenEstimate: 300,
    safe: true,
    safetyNotes: [],
    assumptions: [],
    supported: true,
    unsupportedReasons: [],
    uncertainty: 'medium',
    simulated: true,
    ...overrides,
  };
}

export function buildScenario(
  overrides: Partial<CounterfactualScenario> = {},
): CounterfactualScenario {
  const caseId = overrides.caseId ?? 'case_alpha';
  const id = overrides.id ?? `cf_${caseId}_fork_1_balanced`;
  return {
    ...meta(overrides.tenantId ?? TENANT_A, at(102)),
    id,
    caseId,
    forkId: `fork_${caseId}_1`,
    analysisRunId: `run_${caseId}_1`,
    modelExecutionId: null,
    status: 'completed',
    strategy: 'balanced',
    label: 'Balanced path',
    summary: 'Synthetic simulated alternative path.',
    boundary: {
      asOf: at(50),
      eventIds: [],
      evidenceIds: [],
      eventCount: 0,
      leakCheck: {
        passed: true,
        checkedAt: at(102),
        futureReferencesFound: 0,
        resolutionExcluded: true,
        details: [],
      },
    },
    steps: [buildScenarioStep({ scenarioId: id })],
    branchNotes: [],
    assumptions: ['Synthetic simulation; not a measurement.'],
    rollouts: { count: 100, seed: 'seed-1', modalPathShare: 0.7, diagnosisReachedShare: 0.9 },
    actualMetrics: pathMetrics(2400),
    counterfactualMetrics: pathMetrics(1200),
    improvements: { tokenEstimate: 0.5 },
    comparisonConfidence: { level: 'medium', score: 0.6, rationale: 'Synthetic.' },
    validity: { valid: true, checks: [] },
    labels: { simulated: true, estimated: true },
    reviewState: 'pending',
    reviewReason: null,
    reviewedBy: null,
    reviewedAt: null,
    ...overrides,
  };
}
