import {
  CommandCenterSchema,
  DEFAULT_FEATURE_FLAGS,
  METRIC_DEFINITIONS,
  PersonaSchema,
  SessionSchema,
  type CaseSummary,
  type CommandCenter,
  type MetricCard,
  type MetricKey,
  type Permission,
  type Persona,
  type Role,
  type Session,
} from '@caseguard/schemas';

/**
 * Test fixtures. Each factory validates its result with the real Zod schema, so a fixture can never drift from the
 * contract the UI consumes.
 */

export const NOW = '2025-03-14T09:00:00.000Z';

export function caseSummary(overrides: Partial<CaseSummary> = {}): CaseSummary {
  return {
    id: 'case_1',
    reference: 'SAMPLE-001',
    title: 'Intermittent sign-in failures',
    product: 'Identity Gateway',
    workload: 'Authentication',
    severity: 'B',
    status: 'open',
    customerAlias: 'Contoso (synthetic)',
    openedAt: '2025-03-03T08:02:00.000Z',
    closedAt: null,
    synthetic: true,
    eventCount: 12,
    analysisState: 'analyzed',
    analyzedAt: NOW,
    hasResolution: false,
    injectionDetected: false,
    qualityIndex: 72,
    avoidableEffortPct: 38,
    leadingHypothesis: { name: 'Proxy authentication misconfiguration', confidence: 0.58 },
    openWarningCount: 2,
    ...overrides,
  };
}

export function metric(key: MetricKey, overrides: Partial<MetricCard> = {}): MetricCard {
  const definition = METRIC_DEFINITIONS[key];
  return {
    key,
    label: definition.label,
    value: 72,
    display: '72',
    unit: definition.unit,
    status: 'watch',
    trend: { direction: 'up', delta: 4.2, label: 'vs previous run' },
    definition: definition.definition,
    formula: definition.formula,
    range: { low: 64, high: 80 },
    estimated: true,
    synthetic: true,
    evidenceLink: { href: '/cases/case_1/quality', label: 'View score composition' },
    caseId: 'case_1',
    ...overrides,
  };
}

const meta = {
  tenantId: 'tenant_demo',
  createdAt: NOW,
  updatedAt: NOW,
  createdBy: 'synthetic',
  version: 1,
};

export function commandCenter(overrides: Partial<CommandCenter> = {}): CommandCenter {
  const base: CommandCenter = {
    generatedAt: NOW,
    activeCase: caseSummary(),
    metrics: [
      metric('case_quality_index'),
      metric('evidence_integrity', { value: 86, display: '86', status: 'good', trend: null }),
      metric('avoidable_support_effort', {
        value: 38,
        display: '38%',
        unit: 'percent',
        status: 'poor',
        range: { low: 31, high: 45 },
      }),
      metric('token_efficiency', {
        value: null,
        display: 'Not enough data',
        status: 'unknown',
        trend: null,
        range: null,
        evidenceLink: null,
      }),
    ],
    criticalMissingEvidence: [
      {
        id: 'req_1',
        caseId: 'case_1',
        requirementId: 'client_trace',
        label: 'Client trace from an affected device',
        description: 'Shows whether the request reaches the proxy.',
        criticality: 'critical',
        category: 'evidence',
        firstRelevantAt: '2025-03-04T10:00:00.000Z',
        resolvedAt: null,
        resolvedByEventId: null,
        neededFor: ['Proxy authentication misconfiguration'],
        askText: 'Could you capture a trace on one affected device?',
      },
    ],
    leadingHypothesis: {
      hypothesisId: 'hyp_1',
      name: 'Proxy authentication misconfiguration',
      confidence: 0.58,
      low: 0.44,
      high: 0.72,
      caseId: 'case_1',
    },
    skillMatch: {
      skillId: 'skill_1',
      name: 'Check proxy authentication first',
      version: '1.2.0',
      score: 0.71,
      applicability: 'applies',
      caseId: 'case_1',
    },
    openWarnings: [
      {
        ...meta,
        id: 'warn_1',
        caseId: 'case_1',
        analysisRunId: 'run_1',
        ruleId: 'repeated_request',
        category: 'troubleshooting',
        priority: 'high',
        rank: 1,
        title: 'The same logs were requested twice',
        message: 'Logs were requested on 5 March and again on 8 March without new questions.',
        suggestedAction: 'Ask for the proxy trace instead of repeating the request.',
        evidence: [{ type: 'event', id: 'evt_9', label: 'Second log request' }],
        fingerprint: 'repeated_request:evt_9',
        raisedAt: '2025-03-08T09:00:00.000Z',
        resolvedAt: null,
        resolvedReason: null,
        state: 'open',
        dismissal: null,
      },
    ],
    recentCases: [
      caseSummary(),
      caseSummary({
        id: 'case_2',
        reference: 'SAMPLE-002',
        title: 'Mailbox migration stalls',
        qualityIndex: null,
        analysisState: 'not_analyzed',
        openWarningCount: 0,
      }),
    ],
    skillCandidates: [],
    systemHealth: {
      status: 'healthy',
      healthy: 5,
      degraded: 0,
      unhealthy: 0,
      providerKind: 'deterministic',
      providerSimulated: true,
    },
    notices: [],
    ...overrides,
  };
  return CommandCenterSchema.parse(base);
}

export const ALL_PERMISSIONS: readonly Permission[] =
  SessionSchema.shape.permissions.element.options;

export function session(
  role: Role = 'engineer',
  permissions: readonly Permission[] = ['case:read', 'case:ingest', 'quality:read'],
): Session {
  return SessionSchema.parse({
    user: {
      id: `user_${role}`,
      displayName: 'Ada Reviewer',
      email: 'ada@example.invalid',
      roles: [role],
      synthetic: true,
    },
    tenant: { id: 'tenant_demo', name: 'Demo tenant', slug: 'demo', synthetic: true },
    permissions: [...permissions],
    authMode: 'dev',
    environment: 'local',
    features: DEFAULT_FEATURE_FLAGS,
    notices: ['All data in this environment is synthetic.'],
  });
}

export function persona(id: string, role: Role, displayName: string): Persona {
  return PersonaSchema.parse({
    id,
    displayName,
    role,
    tenantId: 'tenant_demo',
    description: `Synthetic ${role} persona`,
  });
}
