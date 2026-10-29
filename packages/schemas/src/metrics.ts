import type { MetricKey, MetricUnit } from './quality';

export interface MetricDefinition {
  key: MetricKey;
  label: string;
  unit: MetricUnit;
  /** Plain-language definition shown on every metric card (FR-UX-07). */
  definition: string;
  /** Compact formula; never presented as a scientific law. */
  formula: string;
  higherIsBetter: boolean;
  /** Status thresholds on the displayed value: >= good => good, >= watch => watch, else poor (inverted when lower is better). */
  thresholds: { good: number; watch: number };
  estimated: true;
}

/** Single source of truth for metric explanations, shared by the engine, API and UI. */
export const METRIC_DEFINITIONS: Record<MetricKey, MetricDefinition> = {
  case_quality_index: {
    key: 'case_quality_index',
    label: 'Case Quality Index',
    unit: 'score',
    definition:
      'A weighted composite (0-100) of six quality dimensions minus capped, evidence-linked penalties. It is a model estimate meant to focus a human review, not a performance rating of a person.',
    formula: 'CQI = sum(weight x dimension score) - min(penalty cap, sum of applied penalties)',
    higherIsBetter: true,
    thresholds: { good: 80, watch: 60 },
    estimated: true,
  },
  evidence_integrity: {
    key: 'evidence_integrity',
    label: 'Evidence Integrity',
    unit: 'score',
    definition:
      'How well statements in the case are justified by cited evidence: conclusions backed by diagnostic evidence, assumptions kept separate from facts, and contradictions acknowledged.',
    formula:
      'Weighted share of key claims whose category is supported by cited evidence, minus ledger flags',
    higherIsBetter: true,
    thresholds: { good: 80, watch: 60 },
    estimated: true,
  },
  avoidable_support_effort: {
    key: 'avoidable_support_effort',
    label: 'Avoidable Support Effort',
    unit: 'percent',
    definition:
      'An estimate of the share of weighted support effort that a better-sequenced investigation could plausibly have avoided. It is shown with a range, its assumptions and its contributors, and is never a measured fact.',
    formula: 'ASE = sum(weight_i x avoidable_i / total_i) over nine effort components',
    higherIsBetter: false,
    thresholds: { good: 20, watch: 40 },
    estimated: true,
  },
  reasoning_efficiency: {
    key: 'reasoning_efficiency',
    label: 'Reasoning Efficiency',
    unit: 'score',
    definition:
      'How close the chosen diagnostic actions were to the best safe alternative available at each decision time (100 = always chose the best available action).',
    formula:
      'Mean over decisions of (action value of chosen action / best safe action value) x 100',
    higherIsBetter: true,
    thresholds: { good: 70, watch: 45 },
    estimated: true,
  },
  customer_effort: {
    key: 'customer_effort',
    label: 'Customer Effort',
    unit: 'minutes',
    definition:
      'Estimated minutes of customer time requested by the actions in the case, using a configurable effort scale. A lower value means less burden on the customer.',
    formula:
      'Sum over customer-involving actions of effort-level minutes (none 0, low 10, medium 30, high 90, very high 180)',
    higherIsBetter: false,
    thresholds: { good: 120, watch: 360 },
    estimated: true,
  },
  resolution_confidence: {
    key: 'resolution_confidence',
    label: 'Resolution Confidence',
    unit: 'percent',
    definition:
      'A model estimate of how likely the documented root cause is correct, combining the final hypothesis posterior with the strength of the validation evidence. It is not a statistical guarantee.',
    formula: 'posterior(root-cause hypothesis) x validation factor',
    higherIsBetter: true,
    thresholds: { good: 75, watch: 50 },
    estimated: true,
  },
  token_efficiency: {
    key: 'token_efficiency',
    label: 'Token Efficiency',
    unit: 'bits_per_1k_tokens',
    definition:
      'Information gained (bits, from hypothesis updates) per 1,000 AI-assisted tokens in the case process. Token counts are estimates; the deterministic provider reports simulated values.',
    formula: 'sum(realized information gain bits) / (sum(tokens) / 1000)',
    higherIsBetter: true,
    thresholds: { good: 1, watch: 0.4 },
    estimated: true,
  },
};

export const OPEN_WARNING_DEFINITION =
  'Count of unresolved, undismissed live quality warnings. Each is specific, evidence-linked and actionable.';
export const CRITICAL_MISSING_EVIDENCE_DEFINITION =
  'Evidence the knowledge pack marks as critical for the current stage that has not yet been collected.';
export const LEADING_HYPOTHESIS_DEFINITION =
  'The hypothesis with the highest model-estimated confidence. Confidence is an estimate shown with a range, not a statistical truth.';
export const SKILL_MATCH_DEFINITION =
  'The best-matching published or validated SkillDNA for the case, using only evidence available at the selected time.';

export const SYNTHETIC_DATA_NOTICE =
  'All case data, people and organisations in this environment are synthetic and for demonstration only.';
export const SYNTHETIC_EFFECTIVENESS_NOTICE =
  'Improvement figures compare synthetic cases and demonstrate the measurement pipeline. They are not evidence of real-world effectiveness.';
export const MODEL_ESTIMATE_NOTICE =
  'Confidence values are model estimates produced from an authored knowledge pack. They are not statistical truth.';
export const RESPONSIBLE_USE_NOTICE =
  'CaseGuard AI supports quality review and coaching. It must not be used to rank, rate or discipline individual employees, and it never closes cases automatically.';
