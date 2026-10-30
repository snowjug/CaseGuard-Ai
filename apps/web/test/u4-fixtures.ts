import {
  AuditEventSchema,
  AuditVerificationSchema,
  DEFAULT_GOVERNANCE_VALUES,
  DemoStateSchema,
  GovernanceSettingsSchema,
  PromptVersionSchema,
  ProviderStatusSchema,
  RequestMetricsSchema,
  ReviewDecisionSchema,
  SystemHealthSchema,
  UserSchema,
  type AuditEvent,
  type AuditVerification,
  type DemoState,
  type DemoStep,
  type GovernanceSection,
  type GovernanceSettings,
  type PromptVersion,
  type ProviderStatus,
  type RequestMetrics,
  type ReviewDecision,
  type SystemHealth,
  type User,
} from '@caseguard/schemas';
import { configure } from '@testing-library/react';

// These pages render a lot and the suite often runs on a busy machine: wait longer than the 1 s default for async UI.
configure({ asyncUtilTimeout: 8000 });

/**
 * Fixtures for the Governance, System Health and Demo Guide pages. Every factory validates its result with the real
 * Zod schema, so a fixture cannot drift from the contract.
 */

export const T0 = '2025-03-14T09:00:00.000Z';

// ---------------------------------------------------------------- governance

type Envelope<S extends GovernanceSection> = GovernanceSettings[S];

export function governanceSettings(
  overrides: { [S in GovernanceSection]?: Partial<Envelope<S>> } = {},
): GovernanceSettings {
  const base = Object.fromEntries(
    Object.entries(DEFAULT_GOVERNANCE_VALUES).map(([section, value]) => [
      section,
      {
        value: structuredClone(value),
        version: 1,
        updatedAt: T0,
        updatedBy: 'system:seed',
        changeNote: 'Default configuration',
      },
    ]),
  );
  const merged = Object.fromEntries(
    Object.entries(base).map(([section, envelope]) => [
      section,
      { ...envelope, ...(overrides as Record<string, object>)[section] },
    ]),
  );
  return GovernanceSettingsSchema.parse(merged);
}

export function userRecord(overrides: Partial<User> = {}): User {
  return UserSchema.parse({
    id: 'user_ava_engineer',
    tenantId: 'tenant_demo',
    displayName: 'Ava Engineer (synthetic)',
    email: 'ava.engineer@example.invalid',
    roles: ['engineer'],
    status: 'active',
    synthetic: true,
    createdAt: T0,
    updatedAt: T0,
    version: 1,
    ...overrides,
  });
}

export const USER_ROSTER: readonly User[] = [
  userRecord({
    id: 'user_alex_admin',
    displayName: 'Alex Admin (synthetic)',
    email: 'alex.admin@example.invalid',
    roles: ['administrator'],
  }),
  userRecord(),
  userRecord({
    id: 'user_riley_reviewer',
    displayName: 'Riley Reviewer (synthetic)',
    email: 'riley.reviewer@example.invalid',
    roles: ['reviewer'],
    version: 3,
  }),
];

const HASH = 'a'.repeat(64);

export function auditEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  const sequence = overrides.sequence ?? 1;
  return AuditEventSchema.parse({
    id: `aud_${sequence}`,
    tenantId: 'tenant_demo',
    sequence,
    occurredAt: T0,
    actorId: 'user_alex_admin',
    actorRole: 'administrator',
    action: 'governance.settings.updated',
    targetType: 'governance_section',
    targetId: 'model',
    caseId: null,
    outcome: 'success',
    details: { section: 'model', fromVersion: 1, toVersion: 2, changedKeys: ['temperature'] },
    correlationId: `req_${sequence}`,
    prevHash: HASH,
    hash: 'b'.repeat(64),
    ...overrides,
  });
}

export function auditPage(
  events: readonly AuditEvent[],
  nextCursor: string | null = null,
): { items: AuditEvent[]; nextCursor: string | null } {
  return { items: [...events], nextCursor };
}

export function auditVerification(overrides: Partial<AuditVerification> = {}): AuditVerification {
  return AuditVerificationSchema.parse({
    valid: true,
    eventsChecked: 19,
    firstInvalidSequence: null,
    checkedAt: T0,
    detail: 'Verified 19 audit events; the hash chain is intact',
    ...overrides,
  });
}

export function reviewDecision(overrides: Partial<ReviewDecision> = {}): ReviewDecision {
  return ReviewDecisionSchema.parse({
    tenantId: 'tenant_demo',
    createdAt: T0,
    updatedAt: T0,
    createdBy: 'user_riley_reviewer',
    version: 1,
    id: 'rev_1',
    caseId: 'case_1',
    targetType: 'counterfactual',
    targetId: 'scn_1',
    decision: 'confirm',
    originalValue: { reviewState: 'pending' },
    newValue: { reviewState: 'confirmed' },
    reason: 'The path is realistic: every step uses only what was known before the decision.',
    reviewerId: 'user_riley_reviewer',
    reviewerRole: 'reviewer',
    decidedAt: T0,
    ...overrides,
  });
}

export function promptVersion(overrides: Partial<PromptVersion> = {}): PromptVersion {
  return PromptVersionSchema.parse({
    tenantId: 'tenant_demo',
    createdAt: T0,
    updatedAt: T0,
    createdBy: 'system:prompt-registry',
    version: '1.0.0',
    id: 'prompt_quality_judge_1.0.0',
    agent: 'quality_judge',
    templateHash: 'c'.repeat(64),
    template: 'Role: Quality Judge. Describe process quality, never people.',
    outputSchemaId: 'caseguard.quality-judgement.v1',
    status: 'active',
    changeNote: 'Initial version.',
    ...overrides,
  });
}

// ---------------------------------------------------------------- system

export function providerStatus(overrides: Partial<ProviderStatus> = {}): ProviderStatus {
  return ProviderStatusSchema.parse({
    kind: 'deterministic',
    configured: true,
    healthy: true,
    model: 'deterministic-knowledge-pack',
    simulated: true,
    checkedAt: T0,
    detail: 'Deterministic knowledge-pack provider (simulated values, fully offline).',
    validationNote:
      'Deterministic knowledge-pack provider: fully offline, reproducible, and exercised by the automated tests.',
    limits: { maxInputTokens: 24000, maxOutputTokens: 4000, timeoutMs: 30000, maxRetries: 2 },
    ...overrides,
  });
}

export function systemHealth(overrides: Partial<SystemHealth> = {}): SystemHealth {
  const row = (
    name: string,
    kind: SystemHealth['dependencies'][number]['kind'],
    detail: string,
    simulated: boolean,
    extra: Partial<SystemHealth['dependencies'][number]> = {},
  ) => ({
    name,
    kind,
    status: 'healthy' as const,
    latencyMs: null,
    detail,
    checkedAt: T0,
    simulated,
    ...extra,
  });
  return SystemHealthSchema.parse({
    status: 'healthy',
    service: 'caseguard-api',
    version: '0.1.0',
    commit: null,
    environment: 'local',
    uptimeSeconds: 3725,
    checkedAt: T0,
    dependencies: [
      row('database', 'database', 'pglite reachable', false, { latencyMs: 3.8 }),
      row('migrations', 'migrations', 'up to date (0012_review_target_type_idx)', false, {
        latencyMs: 46.3,
      }),
      row('storage', 'storage', 'local object store reachable', true, { latencyMs: 6.8 }),
      row('search', 'search', 'lexical search runs in-process', true, { latencyMs: 2.8 }),
      row('model_provider', 'ai_provider', 'Deterministic knowledge-pack provider.', true),
      row('cache', 'cache', 'In-process memory cache.', true),
      row('identity', 'identity', 'Development personas: synthetic identities.', true),
    ],
    migrations: { applied: 12, pending: 0, latest: '0012_review_target_type_idx' },
    provider: providerStatus(),
    notices: [
      'AI reasoning runs on the deterministic evidence engine. No cloud language model is connected; model values are simulated or estimated.',
      'Search is the built-in lexical (keyword) search over the data of this tenant. Azure AI Search is not configured.',
      'Dependency "storage" is an in-process or synthetic stand-in, not a live service.',
    ],
    ...overrides,
  });
}

export function requestMetrics(overrides: Partial<RequestMetrics> = {}): RequestMetrics {
  return RequestMetricsSchema.parse({
    since: T0,
    totalRequests: 120,
    errorRequests: 3,
    errorRate: 0.025,
    latencyMs: { p50: 12.5, p95: 143.9, p99: 301.2, max: 643.9 },
    byRoute: [
      { route: '/api/v1/cases', method: 'GET', count: 40, errors: 0, p95Ms: 31.2 },
      { route: '/api/v1/governance/settings', method: 'PUT', count: 3, errors: 3, p95Ms: 18.4 },
    ],
    modelExecutions: { total: 12, failures: 1, avgLatencyMs: 71 },
    securityEvents: { authFailures: 1, forbidden: 2, rateLimited: 0, injectionFlags: 0 },
    ...overrides,
  });
}

// ---------------------------------------------------------------- demo

const STEP_TEXT: readonly (readonly [string, DemoStep['persona'], string])[] = [
  ['import-case-one', 'engineer', 'Import Case One'],
  ['reconstruct-timeline', 'engineer', 'Timeline reconstructed'],
  ['build-evidence-ledger', 'engineer', 'Evidence ledger built'],
  ['compare-hypotheses', 'engineer', 'Competing hypotheses shown'],
  ['find-decision-forks', 'engineer', 'Decision forks found'],
  ['accept-better-path', 'reviewer', 'A better path simulated and accepted'],
  ['calculate-metrics', 'manager', 'Quality and efficiency metrics calculated'],
  ['generate-skill', 'engineer', 'Draft SkillDNA generated'],
  ['approve-skill', 'skill_curator', 'Governed approval completed'],
  ['import-case-two', 'engineer', 'Import Case Two'],
  ['skill-applies', 'engineer', 'The validated skill applies to Case Two'],
  [
    'second-investigation',
    'engineer',
    'The second investigation is shorter and more evidence-driven',
  ],
  ['compare-outcomes', 'manager', 'Outcomes compared'],
];

const ROUTES_BY_STEP: Record<string, string> = {
  'import-case-one': '/cases/case_1',
  'reconstruct-timeline': '/cases/case_1/timeline',
  'build-evidence-ledger': '/cases/case_1/evidence',
  'compare-hypotheses': '/cases/case_1/hypotheses',
  'find-decision-forks': '/cases/case_1/counterfactual',
  'accept-better-path': '/cases/case_1/counterfactual',
  'calculate-metrics': '/cases/case_1/quality',
  'generate-skill': '/skills/skill_1',
  'approve-skill': '/skills/skill_1',
  'import-case-two': '/cases/case_2',
  'skill-applies': '/cases/case_2',
  'second-investigation': '/cases/case_2/quality',
  'compare-outcomes': '/efficiency',
};

/** Where the last step leads once both cases exist: the comparison of case two with case one, as the API reports it. */
export const COMPARE_ROUTE = '/cases/case_2/quality?tab=compare&with=case_1';

/** The 13-step story with the first `completedSteps` steps done (the API derives this from stored facts). */
export function demoState(completedSteps = 0, overrides: Partial<DemoState> = {}): DemoState {
  const bothCases = completedSteps > 9;
  const steps: DemoStep[] = STEP_TEXT.map(([id, persona, title], index) => {
    const done = index < completedSteps;
    const next =
      completedSteps >= STEP_TEXT.length
        ? index === STEP_TEXT.length - 1
        : index === completedSteps;
    const enabled = done || index === completedSteps;
    return {
      id,
      order: index + 1,
      title,
      description: `${title}: what this step shows.`,
      presenterNotes: `Notes for "${title}": figures are estimates and every value is synthetic.`,
      persona,
      actionLabel: `Open ${title}`,
      route: id === 'compare-outcomes' && bothCases ? COMPARE_ROUTE : (ROUTES_BY_STEP[id] ?? '/'),
      completed: done,
      enabled,
      lockedReason: enabled
        ? null
        : `Complete "${STEP_TEXT[index - 1]?.[2] ?? 'the previous step'}" first.`,
      isNextAction: next,
    };
  });
  return DemoStateSchema.parse({
    steps,
    seededAt: completedSteps > 0 ? T0 : null,
    datasetLabel: 'Synthetic demonstration data',
    provider: 'deterministic',
    providerSimulated: true,
    caseOneId: completedSteps > 0 ? 'case_1' : null,
    caseTwoId: completedSteps > 9 ? 'case_2' : null,
    skillId: completedSteps > 7 ? 'skill_1' : null,
    notices: [
      'Every case, person and organisation in this demo is synthetic. No customer data is used.',
      'The AI provider is the deterministic offline engine: results are simulated and reproducible, and token figures are estimates.',
      'Nothing is deployed to Azure by this demo. Azure OpenAI, Microsoft Entra ID, Blob Storage and AI Search are implemented and validated against mocks or locally generated test keys only.',
    ],
    ...overrides,
  });
}
