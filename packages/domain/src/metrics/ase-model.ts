import {
  AVOIDABLE_EFFORT_COMPONENTS,
  METRIC_DEFINITIONS,
  type AvoidableEffortComponentKey,
  type EvidenceLink,
  type Level,
  type PathMetrics,
  type Range,
} from '@caseguard/schemas';
import { clamp, round } from '../util/math';

/** The estimate is built from the best valid simulated alternative; these are the three outcomes. */
export type AvoidableEffortState = 'estimated' | 'no_decision_forks' | 'no_valid_counterfactual';

export const ASE_NOTICE = `${METRIC_DEFINITIONS.avoidable_support_effort.definition} Simulated alternatives use only information available at the decision time.`;

export interface ComponentSpec {
  label: string;
  unit: string;
  /** Default share of the overall estimate; re-normalised over the components that have data. */
  weight: number;
  /** Where the avoidable amount comes from. */
  source: 'counterfactual' | 'decision_time' | 'telemetry';
}

export const ASE_COMPONENT_SPECS: Readonly<Record<AvoidableEffortComponentKey, ComponentSpec>> = {
  engineer_effort: {
    label: 'Engineer effort',
    unit: 'steps',
    weight: 0.15,
    source: 'counterfactual',
  },
  customer_effort: {
    label: 'Customer effort',
    unit: 'customer minutes',
    weight: 0.2,
    source: 'counterfactual',
  },
  repeated_interactions: {
    label: 'Customer interactions',
    unit: 'interactions',
    weight: 0.1,
    source: 'counterfactual',
  },
  diagnostic_executions: {
    label: 'Diagnostic executions',
    unit: 'diagnostic units',
    weight: 0.1,
    source: 'counterfactual',
  },
  escalations: {
    label: 'Escalations',
    unit: 'escalations',
    weight: 0.05,
    source: 'decision_time',
  },
  waiting_time: {
    label: 'Waiting time to diagnosis',
    unit: 'minutes',
    weight: 0.2,
    source: 'counterfactual',
  },
  token_usage: {
    label: 'Token usage',
    unit: 'tokens',
    weight: 0.05,
    source: 'counterfactual',
  },
  compute_usage: {
    label: 'Compute usage',
    unit: 'compute seconds',
    weight: 0.05,
    source: 'telemetry',
  },
  low_information_actions: {
    label: 'Steps that added little information',
    unit: 'steps',
    weight: 0.1,
    source: 'decision_time',
  },
};

/** Maps the counterfactual-based components onto the engine's path metrics. */
export const CF_METRIC_FOR: Readonly<
  Partial<Record<AvoidableEffortComponentKey, (m: PathMetrics) => Range>>
> = {
  engineer_effort: (m) => m.actionCount,
  customer_effort: (m) => m.customerEffortMinutes,
  repeated_interactions: (m) => m.customerInteractions,
  diagnostic_executions: (m) => m.diagnosticVolume,
  waiting_time: (m) => m.timeToDiagnosisMinutes,
  token_usage: (m) => m.tokenEstimate,
};

export interface AvoidableComponentDetail {
  key: AvoidableEffortComponentKey;
  label: string;
  unit: string;
  source: ComponentSpec['source'];
  /** Whether the component has data; excluded components carry weight 0. */
  included: boolean;
  /** Actual amount on the real path (measured or estimated, see the assumption). */
  total: number;
  avoidable: Range;
  /** Avoidable share in percent, always within 0-100. */
  pct: Range;
  /** Weight after re-normalising over the included components (sums to 1). */
  weight: number;
  assumption: string;
  evidence: EvidenceLink[];
}

export interface AvoidableEffortEstimate {
  state: AvoidableEffortState;
  /** Always true: nothing here is a measured production value. */
  estimated: true;
  simulated: boolean;
  /** Why the estimate is zero or absent; null when a counterfactual produced it. */
  reason: string | null;
  /** Overall avoidable share in percent; null when no valid counterfactual exists. */
  percent: Range | null;
  confidence: Level;
  components: AvoidableComponentDetail[];
  basis: {
    forkId: string;
    forkEventId: string;
    forkAt: string;
    bestScenarioId: string;
    bestStrategy: string;
    scenarioIds: string[];
    comparisonConfidence: Level;
    /** Composite share if the actual path is 100: what the counterfactual still needs. */
    remainingPct: Range;
  } | null;
  method: string;
  assumptions: string[];
  notice: string;
}

export const range = (low: number, mid: number, high: number): Range => ({ low, mid, high });

export const roundRange = (r: Range, digits = 1): Range => ({
  low: round(r.low, digits),
  mid: round(r.mid, digits),
  high: round(r.high, digits),
});

export const zeroRange = (): Range => range(0, 0, 0);

/** Avoidable amount and share when the counterfactual replaces the actual path (never negative, never above 100%). */
export function avoidableAgainst(
  actual: number,
  counterfactual: Range,
): { avoidable: Range; pct: Range } | null {
  if (!(actual > 0) || !Number.isFinite(actual)) return null;
  const avoid = (cf: number): number => clamp(actual - cf, 0, actual);
  const avoidable = range(
    avoid(counterfactual.high),
    avoid(counterfactual.mid),
    avoid(counterfactual.low),
  );
  const share = (v: number): number => clamp((100 * v) / actual, 0, 100);
  return {
    avoidable,
    pct: range(share(avoidable.low), share(avoidable.mid), share(avoidable.high)),
  };
}

export const COMPONENT_KEYS = AVOIDABLE_EFFORT_COMPONENTS;
