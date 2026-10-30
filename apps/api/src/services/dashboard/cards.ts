import { buildMetricCards, metricStatus, round } from '@caseguard/domain';
import {
  METRIC_DEFINITIONS,
  METRIC_KEYS,
  type MetricCard,
  type MetricEstimate,
  type MetricKey,
  type MetricUnit,
} from '@caseguard/schemas';

/** Where a card's click-through leads in the web app: the page that shows the evidence behind it. */
export function metricHref(key: MetricKey, caseId: string): string {
  const base = `/cases/${encodeURIComponent(caseId)}`;
  switch (key) {
    case 'case_quality_index':
      return `${base}/quality`;
    case 'evidence_integrity':
      return `${base}/evidence`;
    case 'avoidable_support_effort':
      return `${base}/counterfactual`;
    case 'reasoning_efficiency':
    case 'customer_effort':
      return `${base}/timeline`;
    case 'resolution_confidence':
      return `${base}/hypotheses`;
    case 'token_efficiency':
      return `/efficiency?case=${encodeURIComponent(caseId)}`;
  }
}

const UNIT_SUFFIX: Record<MetricUnit, string> = {
  score: 'points',
  percent: 'percentage points',
  minutes: 'minutes',
  hours: 'hours',
  bits_per_1k_tokens: 'bits per 1k tokens',
  ratio: '',
  count: '',
};

/** The earlier analysed case a trend compares with: its estimates and the reference to name it by. */
export interface TrendBase {
  readonly reference: string;
  readonly estimates: readonly MetricEstimate[];
}

/**
 * How a metric moved against the previous analysed case. Never fabricated: both values must exist, and
 * the label says what it compares with and that both are estimates.
 */
export function trendOf(current: MetricEstimate, base: TrendBase | null): MetricCard['trend'] {
  const earlier = base?.estimates.find((estimate) => estimate.key === current.key);
  if (base === null || earlier === undefined || current.value === null || earlier.value === null) {
    return null;
  }
  const delta = round(current.value - earlier.value, 2);
  const suffix = UNIT_SUFFIX[current.unit];
  const shown = `${delta > 0 ? '+' : ''}${delta}${suffix === '' ? '' : ` ${suffix}`}`;
  return {
    direction: Math.abs(delta) < 0.05 ? 'flat' : delta > 0 ? 'up' : 'down',
    delta,
    label: `${shown} compared with ${base.reference}, the previous analysed case (estimates)`,
  };
}

/** A card for a metric that has no estimate yet: no value, status unknown, but still explained. */
export function unavailableCard(
  key: MetricKey,
  options: { readonly caseId: string | null; readonly synthetic: boolean },
): MetricCard {
  const definition = METRIC_DEFINITIONS[key];
  return {
    key,
    label: definition.label,
    value: null,
    display: 'Not available yet',
    unit: definition.unit,
    status: metricStatus(key, null),
    trend: null,
    definition: definition.definition,
    formula: definition.formula,
    range: null,
    estimated: true,
    synthetic: options.synthetic,
    evidenceLink: null,
    caseId: options.caseId,
  };
}

export interface CardInputs {
  readonly caseId: string | null;
  readonly synthetic: boolean;
  /** The active case's stored estimates; empty when it has not been analysed. */
  readonly estimates: readonly MetricEstimate[];
  /** The previous analysed case, when there is one (at least two analysed cases). */
  readonly base: TrendBase | null;
}

/**
 * The seven metric cards of the active case, in the contract order. The domain builds each card (its
 * definition, formula, status band and range come from the estimate and `METRIC_DEFINITIONS`); this
 * adds the click-through and the cross-case trend. A metric without an estimate is an "unavailable"
 * card rather than a missing one.
 */
export function buildCards(input: CardInputs): MetricCard[] {
  const { caseId, synthetic, estimates, base } = input;
  const built = new Map(
    buildMetricCards(estimates, {
      synthetic,
      evidenceHref: (key, id) => metricHref(key, id),
    }).map((card) => [card.key, card] as const),
  );
  return METRIC_KEYS.map((key) => {
    const card = built.get(key);
    const estimate = estimates.find((candidate) => candidate.key === key);
    if (card === undefined || estimate === undefined) {
      return unavailableCard(key, { caseId, synthetic });
    }
    return { ...card, trend: trendOf(estimate, base) };
  });
}
