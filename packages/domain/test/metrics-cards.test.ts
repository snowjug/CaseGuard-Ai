import { describe, expect, it } from 'vitest';
import {
  CaseComparisonRowSchema,
  METRIC_DEFINITIONS,
  METRIC_KEYS,
  MetricCardSchema,
  type MetricEstimate,
  type MetricKey,
} from '@caseguard/schemas';
import {
  COMPARISON_NOTICE,
  buildComparisonNarrative,
  buildComparisonRows,
  buildMetricCards,
  buildMetricEstimates,
  computeAvoidableEffort,
  computeEfficiency,
  computeQualityReview,
} from '../src';
import { CASE_ONE, CASE_TWO, prepareCase, type Prepared } from './helpers';
import { scenariosFor } from './quality-fixtures';

const one = prepareCase(CASE_ONE);
const two = prepareCase(CASE_TWO);

function estimatesFor(p: Prepared, withScenarios: boolean): MetricEstimate[] {
  const avoidable = computeAvoidableEffort({
    analysis: p.analysis,
    pack: p.pack,
    scenarios: withScenarios ? scenariosFor(p) : [],
  });
  return buildMetricEstimates({
    analysis: p.analysis,
    pack: p.pack,
    ctx: p.ctx,
    review: computeQualityReview({ analysis: p.analysis, pack: p.pack, ctx: p.ctx }),
    avoidable,
    efficiency: computeEfficiency({
      analysis: p.analysis,
      pack: p.pack,
      caseId: p.ctx.caseId,
      synthetic: true,
      avoidable,
    }),
    synthetic: true,
  });
}

const oneMetrics = estimatesFor(one, true);
const twoMetrics = estimatesFor(two, false);
const get = (list: MetricEstimate[], key: MetricKey): MetricEstimate => {
  const found = list.find((m) => m.key === key);
  if (!found) throw new Error(`no metric ${key}`);
  return found;
};

describe('dashboard metric cards (FR-ASE-01, FR-QI-02)', () => {
  const cards = buildMetricCards(oneMetrics, {
    evidenceHref: (key, caseId) => `/cases/${caseId}/quality#${key}`,
  });

  it('[FR-QI-02] builds one valid card per metric, in contract order, with definition and formula', () => {
    expect(cards.map((c) => c.key)).toEqual([...METRIC_KEYS]);
    for (const card of cards) {
      expect(() => MetricCardSchema.parse(card)).not.toThrow();
      const def = METRIC_DEFINITIONS[card.key as MetricKey];
      expect(card.definition).toBe(def.definition);
      expect(card.formula).toBe(def.formula);
      expect(card.estimated).toBe(true);
      expect(card.synthetic).toBe(true);
      expect(card.caseId).toBe(one.ctx.caseId);
      expect(card.evidenceLink?.href).toBe(`/cases/${one.ctx.caseId}/quality#${card.key}`);
    }
  });

  it('[FR-QI-02] cards carry the estimate value, display, status and range unchanged', () => {
    for (const card of cards) {
      const m = get(oneMetrics, card.key as MetricKey);
      expect(card.value).toBe(m.value);
      expect(card.display).toBe(m.display);
      expect(card.status).toBe(m.status);
      expect(card.range).toEqual(
        m.low !== null && m.high !== null ? { low: m.low, high: m.high } : null,
      );
    }
  });

  it('[FR-ASE-01] a metric without a value has no range and no trend, and stays "unknown"', () => {
    const none = buildMetricCards(estimatesFor(one, false), { previous: oneMetrics }).find(
      (c) => c.key === 'avoidable_support_effort',
    );
    expect(none).toMatchObject({ value: null, range: null, trend: null, status: 'unknown' });
  });

  it('[FR-QI-02] shows the trend against an earlier analysis of the same metric only', () => {
    const previous = oneMetrics.map((m) =>
      m.key === 'case_quality_index' && m.value !== null ? { ...m, value: m.value - 10 } : m,
    );
    const withTrend = buildMetricCards(oneMetrics, { previous });
    const cqi = withTrend.find((c) => c.key === 'case_quality_index');
    expect(cqi?.trend).toEqual({
      direction: 'up',
      delta: 10,
      label: '+10 points since the previous analysis',
    });
    expect(withTrend.find((c) => c.key === 'customer_effort')?.trend).toMatchObject({
      direction: 'flat',
      delta: 0,
    });
    const down = buildMetricCards(oneMetrics, {
      previous: oneMetrics.map((m) =>
        m.key === 'customer_effort' && m.value !== null ? { ...m, value: m.value + 30 } : m,
      ),
    }).find((c) => c.key === 'customer_effort');
    expect(down?.trend).toMatchObject({ direction: 'down', delta: -30 });
    expect(down?.trend?.label).toBe('-30 minutes since the previous analysis');
    expect(buildMetricCards(oneMetrics).every((c) => c.trend === null)).toBe(true);
  });

  it('[FR-QI-02] has no click-through unless a link target is provided', () => {
    expect(buildMetricCards(oneMetrics).every((c) => c.evidenceLink === null)).toBe(true);
    const some = buildMetricCards(oneMetrics, { evidenceHref: () => null });
    expect(some.every((c) => c.evidenceLink === null)).toBe(true);
  });
});

describe('comparing two cases (FR-ASE-01, FR-QI-02)', () => {
  const rows = buildComparisonRows(
    { caseId: 'case_one', estimates: oneMetrics },
    { caseId: 'case_two', estimates: twoMetrics },
  );
  const row = (key: MetricKey) => {
    const found = rows.find((r) => r.metric === key);
    if (!found) throw new Error(`no row ${key}`);
    return found;
  };

  it('[FR-QI-02] has one valid row per metric with both values and their displays', () => {
    expect(rows.map((r) => r.metric)).toEqual([...METRIC_KEYS]);
    for (const r of rows) {
      expect(() => CaseComparisonRowSchema.parse(r)).not.toThrow();
      expect(r.values.map((v) => v.caseId)).toEqual(['case_one', 'case_two']);
      expect(r.note).toMatch(/Both values are estimates/);
    }
  });

  it('[FR-QI-02] picks the better case by the metric direction and reports the change relative to the first case', () => {
    expect(row('case_quality_index').betterCaseId).toBe('case_two');
    expect(row('avoidable_support_effort').betterCaseId).toBe('case_two');
    expect(row('customer_effort').betterCaseId).toBe('case_two');
    expect(row('reasoning_efficiency').betterCaseId).toBe('case_two');
    const cqi = row('case_quality_index');
    const a = cqi.values[0]?.value ?? 0;
    const b = cqi.values[1]?.value ?? 0;
    expect(cqi.deltaPct).toBeCloseTo(((b - a) / a) * 100, 1);
    expect(row('customer_effort').deltaPct ?? 0).toBeLessThan(0);
    expect(row('case_quality_index').note).toMatch(/Higher is better/);
    expect(row('customer_effort').note).toMatch(/Lower is better/);
  });

  it('[FR-ASE-01] a metric missing for one case has no verdict and says why', () => {
    const missing = buildComparisonRows(
      { caseId: 'case_one', estimates: estimatesFor(one, false) },
      { caseId: 'case_two', estimates: twoMetrics },
    ).find((r) => r.metric === 'avoidable_support_effort');
    expect(missing).toMatchObject({ betterCaseId: null, deltaPct: null });
    expect(missing?.values[0]).toMatchObject({ value: null, display: 'Not available' });
    expect(missing?.note).toMatch(/could not be estimated/);
  });

  it('[FR-QI-02] equal values are not a win for either case, and a zero baseline gives no percentage', () => {
    const same = buildComparisonRows(
      { caseId: 'a', estimates: twoMetrics },
      { caseId: 'b', estimates: twoMetrics },
    );
    expect(same.every((r) => r.betterCaseId === null)).toBe(true);
    expect(same.every((r) => r.deltaPct === null || r.deltaPct === 0)).toBe(true);
    const asePair = buildComparisonRows(
      { caseId: 'zero', estimates: twoMetrics },
      { caseId: 'some', estimates: oneMetrics },
    ).find((r) => r.metric === 'avoidable_support_effort');
    expect(asePair?.deltaPct).toBeNull();
    expect(asePair?.betterCaseId).toBe('zero');
  });

  it('[FR-QI-02] the narrative uses the supplied labels, mentions the key metrics and states the estimate caveat', () => {
    const story = buildComparisonNarrative(rows, { case_one: 'Case One', case_two: 'Case Two' });
    expect(story[0]).toMatch(/^Case Two shows the stronger estimate on \d+ of the \d+ metrics/);
    expect(story.join(' ')).toMatch(/Case Quality Index \(estimate\): Case One .*, Case Two /);
    expect(story.join(' ')).toMatch(/Avoidable Support Effort \(estimate\)/);
    expect(story.at(-1)).toBe('All figures are model estimates, not measurements.');
    expect(story.join(' ')).not.toMatch(/case_one|case_two/);
    const tie = buildComparisonNarrative(
      buildComparisonRows(
        { caseId: 'a', estimates: twoMetrics },
        { caseId: 'b', estimates: twoMetrics },
      ),
      {},
    );
    expect(tie[0]).toMatch(/do not differ/);
    expect(COMPARISON_NOTICE).toMatch(/not measurements/);
    expect(COMPARISON_NOTICE).toMatch(/not to rate anyone/);
  });
});
