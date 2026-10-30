import {
  MetricEstimateSchema,
  METRIC_DEFINITIONS,
  type CaseSummary,
  type MetricEstimate,
  type MetricKey,
  type SkillDna,
} from '@caseguard/schemas';
import { metricStatus } from '@caseguard/domain';
import type { AnalyticsSource, CaseListItem, TelemetryAggregate } from '../src/db';

/** Pure fixtures for the unit tests of the insights services (no database, no clock). */

export const NOW = '2026-03-15T09:00:00.000Z';

const META = {
  tenantId: 'tenant_test',
  createdAt: NOW,
  updatedAt: NOW,
  createdBy: 'system:test',
  version: 1,
} as const;

/** A schema-valid metric estimate whose status band comes from the domain, like a stored one. */
export function estimateOf(
  key: MetricKey,
  value: number | null,
  extras: Partial<MetricEstimate> & { caseId?: string } = {},
): MetricEstimate {
  const definition = METRIC_DEFINITIONS[key];
  const caseId = extras.caseId ?? 'case_a';
  return MetricEstimateSchema.parse({
    ...META,
    id: `met_${key}_${caseId}`,
    caseId,
    analysisRunId: 'run_1',
    key,
    label: definition.label,
    value,
    unit: definition.unit,
    display: value === null ? 'Not available' : String(value),
    low: value === null ? null : value - 5,
    high: value === null ? null : value + 5,
    confidence: 'medium',
    status: metricStatus(key, value),
    definition: definition.definition,
    method: 'Test fixture.',
    assumptions: [],
    contributors: [],
    comparison: null,
    ase: null,
    estimated: true,
    synthetic: true,
    ...extras,
  });
}

/** The seven estimates of one case, in contract order, with the given values. */
export function estimatesOf(
  caseId: string,
  values: Partial<Record<MetricKey, number | null>>,
): MetricEstimate[] {
  return (Object.keys(METRIC_DEFINITIONS) as MetricKey[]).map((key) =>
    estimateOf(key, values[key] ?? null, { caseId }),
  );
}

/** An avoidable-effort estimate carrying the token component the efficiency overview reads. */
export function aseEstimateWithTokens(
  caseId: string,
  tokens: { total: number; avoidable: number; avoidablePct: number },
): MetricEstimate {
  return estimateOf('avoidable_support_effort', 38, {
    caseId,
    ase: {
      method: 'Test fixture.',
      counterfactual: null,
      components: [
        {
          key: 'token_usage',
          label: 'Token usage',
          unit: 'tokens',
          weight: 0.1,
          assumption: 'Test fixture.',
          evidence: [],
          ...tokens,
        },
      ],
    },
  });
}

export function listItem(id: string, overrides: Partial<CaseListItem> = {}): CaseListItem {
  return {
    id,
    reference: `REF-${id}`,
    title: `Case ${id}`,
    product: 'Microsoft Teams',
    workload: 'teams-authentication',
    severity: 'B',
    status: 'resolved',
    customerAlias: 'Contoso (synthetic)',
    openedAt: '2026-03-01T09:00:00.000Z',
    closedAt: null,
    synthetic: true,
    eventCount: 10,
    analysisState: 'analyzed',
    analyzedAt: '2026-03-02T09:00:00.000Z',
    hasResolution: true,
    injectionDetected: false,
    ...overrides,
  };
}

export function summaryOf(id: string, overrides: Partial<CaseSummary> = {}): CaseSummary {
  return {
    ...listItem(id),
    qualityIndex: null,
    avoidableEffortPct: null,
    leadingHypothesis: null,
    openWarningCount: 0,
    ...overrides,
  };
}

export function telemetry(overrides: Partial<TelemetryAggregate> = {}): TelemetryAggregate {
  return {
    totals: {
      executions: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      failures: 0,
      cacheHits: 0,
      avgLatencyMs: 0,
      estimatedCostUsd: null,
    },
    byAgent: [],
    byModel: [],
    savings: {
      contextCompressionTokens: 0,
      duplicateRemovalTokens: 0,
      cacheHitTokens: 0,
      earlyStopTokens: 0,
    },
    tokensToday: 0,
    ...overrides,
  };
}

export function emptySource(): AnalyticsSource {
  return {
    cases: [],
    quality: [],
    forks: [],
    missing: [],
    metrics: [],
    assumptionFlags: [],
    scenarios: [],
    skills: [],
    matches: [],
  };
}

export function skillOf(id: string, overrides: Partial<SkillDna> = {}): SkillDna {
  return {
    ...META,
    id,
    key: `skill-${id}`,
    name: `Skill ${id}`,
    description: 'Synthetic test skill.',
    workload: 'teams-authentication',
    product: 'Microsoft Teams',
    lifecycle: 'published',
    currentVersionId: `ver_${id}`,
    currentVersion: '1.0.0',
    owner: 'user_ava_engineer',
    reviewer: 'user_riley_reviewer',
    validationStatus: 'validated',
    lastValidatedAt: NOW,
    confidence: 0.8,
    sourceCaseIds: ['case_a'],
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
