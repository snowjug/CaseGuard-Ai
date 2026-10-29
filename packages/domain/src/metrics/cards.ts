import {
  METRIC_DEFINITIONS,
  METRIC_KEYS,
  type CaseComparisonRow,
  type MetricCard,
  type MetricEstimate,
  type MetricKey,
  type MetricUnit,
} from '@caseguard/schemas';
import { round } from '../util/math';

export const COMPARISON_NOTICE =
  'Differences between two cases are model estimates from the written record. They are not measurements and do not show cause and effect; use them to start a conversation, not to rate anyone.';

const UNIT_SUFFIX: Record<MetricUnit, string> = {
  score: 'points',
  percent: 'percentage points',
  minutes: 'minutes',
  hours: 'hours',
  bits_per_1k_tokens: 'bits per 1k tokens',
  ratio: '',
  count: '',
};

export interface MetricCardOptions {
  /** Estimates of an earlier analysis of the same case; the cards then show the change since then. */
  previous?: readonly MetricEstimate[];
  /** Where a card's click-through to the underlying evidence leads (null: no link). */
  evidenceHref?: (key: MetricKey, caseId: string) => string | null;
  /** Marks cards as synthetic even when the estimate itself does not say so. */
  synthetic?: boolean;
}

function trendOf(
  current: MetricEstimate,
  previous: MetricEstimate | undefined,
): MetricCard['trend'] {
  if (!previous || current.value === null || previous.value === null) return null;
  const delta = round(current.value - previous.value, 2);
  const suffix = UNIT_SUFFIX[current.unit];
  const shown = `${delta > 0 ? '+' : ''}${delta}${suffix ? ` ${suffix}` : ''}`;
  return {
    direction: Math.abs(delta) < 0.05 ? 'flat' : delta > 0 ? 'up' : 'down',
    delta,
    label: `${shown} since the previous analysis`,
  };
}

/**
 * Dashboard cards for one case's metric estimates. Every card carries its plain-language definition
 * and formula, stays labelled as an estimate, and only shows a trend against an earlier analysis of
 * the same metric (never across cases).
 */
export function buildMetricCards(
  estimates: readonly MetricEstimate[],
  options: MetricCardOptions = {},
): MetricCard[] {
  const previousByKey = new Map((options.previous ?? []).map((m) => [m.key, m]));
  return [...estimates]
    .sort((a, b) => METRIC_KEYS.indexOf(a.key) - METRIC_KEYS.indexOf(b.key))
    .map((m) => {
      const href = options.evidenceHref?.(m.key, m.caseId) ?? null;
      return {
        key: m.key,
        label: m.label,
        value: m.value,
        display: m.display,
        unit: m.unit,
        status: m.status,
        trend: trendOf(m, previousByKey.get(m.key)),
        definition: m.definition,
        formula: METRIC_DEFINITIONS[m.key].formula,
        range: m.low !== null && m.high !== null ? { low: m.low, high: m.high } : null,
        estimated: true,
        synthetic: m.synthetic || options.synthetic === true,
        evidenceLink: href ? { href, label: `Evidence behind ${m.label}` } : null,
        caseId: m.caseId,
      };
    });
}

export interface ComparisonSide {
  caseId: string;
  estimates: readonly MetricEstimate[];
}

/**
 * One comparison row per metric. "Better" follows the metric's direction (higher or lower is
 * better); it is null when either value is missing or the values are equal. `deltaPct` is the change
 * from the first case to the second, relative to the first.
 */
export function buildComparisonRows(a: ComparisonSide, b: ComparisonSide): CaseComparisonRow[] {
  return METRIC_KEYS.map((key) => {
    const def = METRIC_DEFINITIONS[key];
    const left = a.estimates.find((m) => m.key === key);
    const right = b.estimates.find((m) => m.key === key);
    const va = left?.value ?? null;
    const vb = right?.value ?? null;
    const comparable = va !== null && vb !== null && va !== vb;
    const aIsBetter = comparable && def.higherIsBetter === va > vb;
    const missing = va === null || vb === null;
    return {
      metric: key,
      label: def.label,
      unit: def.unit,
      values: [
        { caseId: a.caseId, value: va, display: left?.display ?? 'Not available' },
        { caseId: b.caseId, value: vb, display: right?.display ?? 'Not available' },
      ],
      betterCaseId: comparable ? (aIsBetter ? a.caseId : b.caseId) : null,
      deltaPct: !missing && va !== 0 ? round(((vb - va) / Math.abs(va)) * 100, 1) : null,
      note: `${def.higherIsBetter ? 'Higher is better.' : 'Lower is better.'} Both values are estimates.${missing ? ' A missing value means the metric could not be estimated for that case.' : ''}`,
    };
  });
}

/** A few plain sentences summarising the rows; labels name the cases (never participants). */
export function buildComparisonNarrative(
  rows: readonly CaseComparisonRow[],
  labels: Readonly<Record<string, string>>,
): string[] {
  const name = (caseId: string): string => labels[caseId] ?? caseId;
  const decided = rows.filter((r) => r.betterCaseId !== null);
  const wins = new Map<string, number>();
  for (const row of decided) {
    if (row.betterCaseId) wins.set(row.betterCaseId, (wins.get(row.betterCaseId) ?? 0) + 1);
  }
  const ranked = [...wins.entries()].sort((x, y) => y[1] - x[1]);
  const sentences: string[] = [];
  const [first, second] = ranked;
  if (first && (!second || first[1] > second[1])) {
    sentences.push(
      `${name(first[0])} shows the stronger estimate on ${first[1]} of the ${decided.length} metrics where both cases have a value and differ.`,
    );
  } else if (decided.length > 0) {
    sentences.push(
      `The two cases are evenly matched across the ${decided.length} metrics that differ.`,
    );
  } else {
    sentences.push('The two cases do not differ on any metric that both could be estimated for.');
  }
  for (const key of [
    'case_quality_index',
    'avoidable_support_effort',
    'customer_effort',
  ] as const) {
    const row = rows.find((r) => r.metric === key);
    if (!row || row.values.some((v) => v.value === null)) continue;
    sentences.push(
      `${row.label} (estimate): ${row.values.map((v) => `${name(v.caseId)} ${v.display}`).join(', ')}.`,
    );
  }
  sentences.push('All figures are model estimates, not measurements.');
  return sentences;
}
