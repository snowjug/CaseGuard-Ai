import type {
  AnalysisState,
  CaseStatus,
  HealthStatus,
  Priority,
  ProviderKind,
  Severity,
} from '@caseguard/schemas';
import type { BadgeStatus } from '@caseguard/ui';

/**
 * Shared display labels for enums that have no label map in `@caseguard/schemas`. Pages import from here so the same
 * value reads the same everywhere (and so the badge status, which carries icon and pattern, stays consistent).
 */

export interface StatusLabel {
  label: string;
  status: BadgeStatus;
}

export const CASE_STATUS_LABELS: Record<CaseStatus, string> = {
  open: 'Open',
  resolved: 'Resolved',
  closed: 'Closed',
};

export const SEVERITY_LABELS: Record<Severity, string> = {
  A: 'Severity A',
  B: 'Severity B',
  C: 'Severity C',
};

export const ANALYSIS_STATE_BADGES: Record<AnalysisState, StatusLabel> = {
  analyzed: { label: 'Analysed', status: 'productive' },
  running: { label: 'Analysing', status: 'neutral' },
  queued: { label: 'Queued', status: 'neutral' },
  failed: { label: 'Analysis failed', status: 'unsupported' },
  not_analyzed: { label: 'Not analysed', status: 'missing' },
};

export const PRIORITY_BADGES: Record<Priority, StatusLabel> = {
  critical: { label: 'Critical', status: 'unsupported' },
  high: { label: 'High priority', status: 'uncertain' },
  medium: { label: 'Medium', status: 'neutral' },
  low: { label: 'Low', status: 'neutral' },
};

export const HEALTH_BADGES: Record<HealthStatus, StatusLabel> = {
  healthy: { label: 'Healthy', status: 'productive' },
  degraded: { label: 'Degraded', status: 'uncertain' },
  unhealthy: { label: 'Unhealthy', status: 'unsupported' },
  unknown: { label: 'Unknown', status: 'missing' },
  disabled: { label: 'Disabled', status: 'neutral' },
};

export const PROVIDER_LABELS: Record<ProviderKind, string> = {
  deterministic: 'Deterministic provider',
  'azure-openai': 'Azure OpenAI',
  scripted: 'Scripted test provider',
};

export const CRITICALITY_LABELS = {
  critical: 'Critical',
  important: 'Important',
  helpful: 'Helpful',
} as const;

export const SKILL_APPLICABILITY: Record<'applies' | 'partial' | 'not_applicable', StatusLabel> = {
  applies: { label: 'Applies', status: 'productive' },
  partial: { label: 'Partly applies', status: 'uncertain' },
  not_applicable: { label: 'Does not apply', status: 'missing' },
};
