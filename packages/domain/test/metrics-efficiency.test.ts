import { describe, expect, it } from 'vitest';
import {
  CaseBundleSchema,
  METRIC_DEFINITIONS,
  METRIC_KEYS,
  MetricEstimateSchema,
  AvoidableEffortDetailsSchema,
  type CaseBundle,
  type MetricEstimate,
  type MetricKey,
} from '@caseguard/schemas';
import {
  buildMetricEstimates,
  computeAvoidableEffort,
  computeEfficiency,
  computeQualityReview,
  computeReasoningEfficiency,
  createTemporalView,
  metricStatus,
  runDeterministicAnalysis,
} from '../src';
import {
  CASE_ONE,
  CASE_TWO,
  CONFIG,
  eventBySuffix,
  loadBundle,
  prepareBundle,
  prepareCase,
} from './helpers';
import { scenariosFor } from './quality-fixtures';

const one = prepareCase(CASE_ONE);
const two = prepareCase(CASE_TWO);

const tokensOf = (p: typeof one): number =>
  p.analysis.view.events.reduce(
    (s, e) => s + (e.ai ? e.ai.promptTokens + e.ai.completionTokens : 0),
    0,
  );

const withEvents = (map: (e: CaseBundle['events'][number]) => CaseBundle['events'][number]) => {
  const copy = structuredClone(loadBundle(CASE_ONE));
  return prepareBundle(
    CaseBundleSchema.parse({ ...copy, events: copy.events.map(map) }),
    'case_variant',
  );
};

describe('token and compute efficiency (FR-TK-01)', () => {
  const ase = computeAvoidableEffort({
    analysis: one.analysis,
    pack: one.pack,
    scenarios: scenariosFor(one),
  });
  const report = computeEfficiency({
    analysis: one.analysis,
    pack: one.pack,
    caseId: 'case_test',
    synthetic: true,
    avoidable: ase,
  });

  it('[FR-TK-01] separates measured telemetry from knowledge-pack estimates and labels both', () => {
    const withTelemetry = one.analysis.view.events.filter((e) => e.ai !== null);
    expect(report.tokens.measured.total).toBe(tokensOf(one));
    expect(report.tokens.measured.events).toBe(withTelemetry.length);
    expect(report.tokens.measured.events).toBeGreaterThan(0);
    expect(report.tokens.estimated.total).toBeGreaterThanOrEqual(0);
    expect(report.tokens.total.value).toBe(
      report.tokens.measured.total + report.tokens.estimated.total,
    );
    expect(report.tokens.total.basis).toBe(
      report.tokens.estimated.total > 0 ? 'mixed' : 'measured',
    );
    expect(report.tokens.total.note).toMatch(/recorded on \d+ events/);
    expect(report.labels).toEqual({ measured: true, estimated: true, synthetic: true });
    expect(report.notes.join(' ')).toMatch(/synthetic/);
  });

  it('[FR-TK-01] without telemetry everything is labelled estimated and nothing is called measured', () => {
    const stripped = withEvents((e) => ({ ...e, ai: undefined }));
    const result = computeEfficiency({
      analysis: stripped.analysis,
      pack: stripped.pack,
      caseId: 'case_variant',
      synthetic: false,
      unitPrices: { inputPer1kUsd: 1, outputPer1kUsd: 2 },
    });
    expect(result.tokens.measured).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      total: 0,
      events: 0,
    });
    expect(result.labels.measured).toBe(false);
    expect(result.tokens.total.basis).toBe('estimated');
    expect(result.bitsPer1kTokens.basis).toBe('estimated');
    expect(result.cost.usd).toBeNull();
    expect(result.cost.reason).toMatch(/No token telemetry/);
    expect(result.notes.join(' ')).not.toMatch(/synthetic/);
  });

  it('[FR-TK-01] reports tokens per useful evidence item and per diagnosis', () => {
    const useful = new Set(one.analysis.links.map((l) => l.evidenceId)).size;
    const total = report.tokens.total.value ?? 0;
    expect(report.usefulEvidenceItems).toBe(useful);
    expect(useful).toBeGreaterThan(0);
    expect(report.perUsefulEvidence.value).toBeCloseTo(total / useful, 1);
    expect(report.perUsefulEvidence.basis).toBe(report.tokens.total.basis);
    expect(report.perDiagnosis.value).toBeGreaterThan(0);
    expect(report.perDiagnosis.value ?? Infinity).toBeLessThanOrEqual(total);
    expect(report.perDiagnosis.note).toMatch(/diagnosis/);
  });

  it('[FR-TK-01] wasted tokens come only from steps flagged as repeated or low value', () => {
    const lowValueEvents = new Set(
      one.analysis.actions.filter((a) => a.lowValue).map((a) => a.eventId),
    );
    expect(report.waste.tokens.value).toBeGreaterThan(0);
    expect(report.waste.share).toBeGreaterThan(0);
    expect(report.waste.share ?? 2).toBeLessThanOrEqual(1);
    expect(report.waste.actionEventIds.length).toBeGreaterThan(0);
    for (const id of report.waste.actionEventIds) expect(lowValueEvents.has(id)).toBe(true);

    const clean = computeEfficiency({
      analysis: two.analysis,
      pack: two.pack,
      caseId: 'case_two',
      synthetic: true,
    });
    expect(clean.waste.tokens.value).toBeNull();
    expect(clean.waste.share).toBeNull();
    expect(clean.cheaperEquivalents).toEqual([]);
  });

  it('[FR-TK-01] suggests cheaper equivalents with the tokens they would have saved', () => {
    expect(report.cheaperEquivalents.length).toBeGreaterThan(0);
    const saved = report.cheaperEquivalents.map((c) => c.savedTokens);
    expect([...saved].sort((a, b) => b - a)).toEqual(saved);
    for (const c of report.cheaperEquivalents) {
      expect(c.savedTokens).toBeGreaterThan(0);
      expect(c.alternativeTokens).toBeLessThan(c.chosenTokens);
      expect(c.savedTokens).toBe(c.chosenTokens - c.alternativeTokens);
      expect(['measured', 'estimated']).toContain(c.chosenBasis);
      expect(c.evidence.length).toBeGreaterThan(0);
      if (c.alternativeActionKey === null) expect(c.alternativeTokens).toBe(0);
    }
  });

  it('[FR-TK-01] hard-coded prices are never used: cost needs operator-supplied unit prices', () => {
    expect(report.cost.usd).toBeNull();
    expect(report.cost.basis).toBe('unavailable');
    expect(report.cost.reason).toMatch(/never hard-coded/);
    const base = { analysis: one.analysis, pack: one.pack, caseId: 'case_test', synthetic: true };
    const events = one.analysis.view.events;
    const prompt = events.reduce((s, e) => s + (e.ai?.promptTokens ?? 0), 0);
    const completion = events.reduce((s, e) => s + (e.ai?.completionTokens ?? 0), 0);
    const priced = computeEfficiency({
      ...base,
      unitPrices: { inputPer1kUsd: 3, outputPer1kUsd: 9 },
    });
    expect(priced.cost.usd).toBeCloseTo((prompt / 1000) * 3 + (completion / 1000) * 9, 5);
    expect(priced.cost.basis).toBe('estimated');
    const free = computeEfficiency({
      ...base,
      unitPrices: { inputPer1kUsd: 0, outputPer1kUsd: 0 },
    });
    expect(free.cost.usd).toBe(0);
    const partial = computeEfficiency({
      ...base,
      unitPrices: { inputPer1kUsd: 3, outputPer1kUsd: null },
    });
    expect(partial.cost.usd).toBeNull();
  });

  it('[FR-TK-01] compute is measured only from telemetry; pack units are labelled estimated', () => {
    expect(report.compute.measuredSeconds).toMatchObject({ value: null, basis: 'unavailable' });
    expect(report.compute.estimatedUnits.basis).toBe('estimated');
    expect(report.compute.estimatedUnits.value).toBe(
      one.analysis.actions.reduce((s, a) => s + a.computeUnits, 0),
    );
    const timed = withEvents((e) => (e.ai ? { ...e, ai: { ...e.ai, computeSeconds: 12.5 } } : e));
    const withCompute = computeEfficiency({
      analysis: timed.analysis,
      pack: timed.pack,
      caseId: 'case_variant',
      synthetic: true,
    });
    const events = timed.analysis.view.events.filter((e) => e.ai !== null).length;
    expect(withCompute.compute.measuredSeconds).toMatchObject({
      value: events * 12.5,
      basis: 'measured',
    });
  });

  it('[FR-TK-01] compares the real path with the best valid alternative when an estimate exists', () => {
    expect(report.caseProcess.counterfactualTokens).not.toBeNull();
    expect(report.caseProcess.counterfactualTokens ?? Infinity).toBeLessThan(
      report.caseProcess.actualTokens,
    );
    expect(report.caseProcess.estimatedSavingsPct).toBeGreaterThan(0);
    expect(report.caseProcess.estimatedSavingsPct ?? 101).toBeLessThanOrEqual(100);
    const alone = computeEfficiency({
      analysis: one.analysis,
      pack: one.pack,
      caseId: 'case_test',
      synthetic: true,
    });
    expect(alone.caseProcess.counterfactualTokens).toBeNull();
    expect(alone.caseProcess.estimatedSavingsPct).toBeNull();
  });

  it('[FR-TK-01] the information-gain rate is a labelled figure with an explanation', () => {
    expect(report.bitsPer1kTokens.value).toBeGreaterThan(0);
    expect(report.bitsPer1kTokens.basis).toBe('measured');
    expect(report.bitsPer1kTokens.note).toMatch(/per 1,000 tokens/);
  });
});

describe('reasoning efficiency (FR-AV-03)', () => {
  const caseOne = computeReasoningEfficiency(one.analysis, one.pack);
  const caseTwo = computeReasoningEfficiency(two.analysis, two.pack);

  it('[FR-AV-03] separates the inefficient case from the efficient one', () => {
    expect(caseOne.value).not.toBeNull();
    expect(caseTwo.value).not.toBeNull();
    expect(caseOne.value ?? 100).toBeLessThan(
      METRIC_DEFINITIONS.reasoning_efficiency.thresholds.watch,
    );
    expect(caseTwo.value ?? 0).toBeGreaterThanOrEqual(
      METRIC_DEFINITIONS.reasoning_efficiency.thresholds.good,
    );
  });

  it('[FR-AV-03] ratios are bounded, the strict reading is never kinder, and repeats are never excused', () => {
    for (const result of [caseOne, caseTwo]) {
      expect(result.strictValue ?? 0).toBeLessThanOrEqual((result.value ?? 0) + 1e-9);
      for (const d of result.decisions) {
        expect(d.ratio).toBeGreaterThanOrEqual(0);
        expect(d.ratio).toBeLessThanOrEqual(1);
        expect(d.rawRatio).toBeLessThanOrEqual(1);
        if (d.excused !== null) {
          expect(d.ratio).toBe(1);
          expect(d.action.lowValue).toBe(false);
        }
      }
    }
    const ranked = one.analysis.actions.filter((a) => a.relativeValueAtDecision !== null);
    expect(caseOne.decisions).toHaveLength(ranked.length);
  });

  it('[FR-AV-03] returns null instead of inventing a score when nothing could be ranked', () => {
    const empty = { ...one.analysis, actions: [] };
    expect(computeReasoningEfficiency(empty, one.pack)).toEqual({
      value: null,
      decisions: [],
      strictValue: null,
    });
  });
});

describe('metric estimates (FR-ASE-01, FR-QI-02)', () => {
  const build = (p: typeof one, withScenarios: boolean): MetricEstimate[] => {
    const ase = computeAvoidableEffort({
      analysis: p.analysis,
      pack: p.pack,
      scenarios: withScenarios ? scenariosFor(p) : [],
    });
    return buildMetricEstimates({
      analysis: p.analysis,
      pack: p.pack,
      ctx: p.ctx,
      review: computeQualityReview({ analysis: p.analysis, pack: p.pack, ctx: p.ctx }),
      avoidable: ase,
      efficiency: computeEfficiency({
        analysis: p.analysis,
        pack: p.pack,
        caseId: p.ctx.caseId,
        synthetic: true,
        avoidable: ase,
      }),
      synthetic: true,
    });
  };
  const caseOne = build(one, true);
  const caseTwo = build(two, false);
  const byKey = (list: MetricEstimate[], key: MetricKey): MetricEstimate => {
    const found = list.find((m) => m.key === key);
    if (!found) throw new Error(`no metric ${key}`);
    return found;
  };

  it('[FR-ASE-01] yields the seven contract metrics in order, valid and labelled as estimates', () => {
    for (const list of [caseOne, caseTwo]) {
      expect(list.map((m) => m.key)).toEqual([...METRIC_KEYS]);
      for (const m of list) {
        expect(() => MetricEstimateSchema.parse(m)).not.toThrow();
        expect(m.estimated).toBe(true);
        expect(m.synthetic).toBe(true);
        expect(m.definition).toBe(METRIC_DEFINITIONS[m.key].definition);
        expect(m.unit).toBe(METRIC_DEFINITIONS[m.key].unit);
        expect(m.label).toBe(METRIC_DEFINITIONS[m.key].label);
        expect(m.method.length).toBeGreaterThan(20);
        expect(m.status).toBe(metricStatus(m.key, m.value));
        if (m.value !== null && m.low !== null && m.high !== null) {
          expect(m.low).toBeLessThanOrEqual(m.value + 1e-9);
          expect(m.high).toBeGreaterThanOrEqual(m.value - 1e-9);
        }
      }
    }
  });

  it('[FR-TK-01] token efficiency recorded on a synthetic case is labelled simulated telemetry, never measured', () => {
    const synthetic = byKey(caseOne, 'token_efficiency');
    expect(synthetic.display).toMatch(/bits per 1k tokens \(simulated telemetry\)$/);
    expect(synthetic.display).not.toMatch(/measured/);

    const ase = computeAvoidableEffort({
      analysis: one.analysis,
      pack: one.pack,
      scenarios: scenariosFor(one),
    });
    const real = buildMetricEstimates({
      analysis: one.analysis,
      pack: one.pack,
      ctx: one.ctx,
      review: computeQualityReview({ analysis: one.analysis, pack: one.pack, ctx: one.ctx }),
      avoidable: ase,
      efficiency: computeEfficiency({
        analysis: one.analysis,
        pack: one.pack,
        caseId: one.ctx.caseId,
        synthetic: false,
        avoidable: ase,
      }),
      synthetic: false,
    }).find((metric) => metric.key === 'token_efficiency');
    expect(real?.display).toMatch(/bits per 1k tokens \(measured\)$/);
  });

  it('[FR-ASE-01] the avoidable-effort metric carries range, contributors, assumptions and the actual-vs-alternative comparison', () => {
    const metric = byKey(caseOne, 'avoidable_support_effort');
    expect(metric.value).toBeGreaterThan(30);
    expect(metric.display).toMatch(/% \(estimate\)/);
    expect(metric.low ?? 100).toBeLessThan(metric.value ?? 0);
    expect(metric.high ?? 0).toBeGreaterThan(metric.value ?? 100);
    expect(metric.contributors.length).toBeGreaterThan(3);
    expect(metric.contributors.some((c) => c.evidence.length > 0)).toBe(true);
    expect(metric.assumptions.length).toBeGreaterThan(0);
    expect(metric.comparison).toMatchObject({ actual: 100 });
    expect(metric.comparison?.counterfactual).toBeCloseTo(100 - (metric.value ?? 0), 0);
    expect(() => AvoidableEffortDetailsSchema.parse(metric.ase)).not.toThrow();
    expect(metric.status).toBe('poor');
  });

  it('[FR-ASE-01] the no-valid-counterfactual state is explicit: no value, a reason, unknown status', () => {
    const metric = byKey(build(one, false), 'avoidable_support_effort');
    expect(metric.value).toBeNull();
    expect(metric.low).toBeNull();
    expect(metric.display).toBe('Not available');
    expect(metric.status).toBe('unknown');
    expect(metric.method).toMatch(/No counterfactual path has been simulated/);
    expect(metric.comparison).toBeNull();
    expect(metric.ase?.components).toEqual([]);
  });

  it('[FR-ASE-01] a case with no decision fork shows 0% as a good result, not as missing', () => {
    const metric = byKey(caseTwo, 'avoidable_support_effort');
    expect(metric.value).toBe(0);
    expect(metric.status).toBe('good');
    expect(metric.method).toMatch(/No decision fork/);
  });

  it('[FR-QI-02] the other metrics reflect the review and the analysis', () => {
    const review = computeQualityReview({ analysis: one.analysis, pack: one.pack, ctx: one.ctx });
    expect(byKey(caseOne, 'case_quality_index').value).toBe(review.compositeScore);
    expect(byKey(caseOne, 'case_quality_index').low).toBe(review.compositeLow);
    expect(byKey(caseOne, 'case_quality_index').contributors.some((c) => c.value < 0)).toBe(true);
    expect(byKey(caseTwo, 'case_quality_index').status).toBe('good');
    expect(byKey(caseOne, 'case_quality_index').status).toBe('poor');
    expect(byKey(caseOne, 'evidence_integrity').value).toBe(
      review.dimensions.find((d) => d.key === 'evidence_integrity')?.score,
    );
    expect(byKey(caseOne, 'customer_effort').value).toBeGreaterThan(
      byKey(caseTwo, 'customer_effort').value ?? Infinity,
    );
    expect(byKey(caseOne, 'reasoning_efficiency').value ?? 100).toBeLessThan(
      byKey(caseTwo, 'reasoning_efficiency').value ?? 0,
    );
    for (const list of [caseOne, caseTwo]) {
      const confidence = byKey(list, 'resolution_confidence').value ?? -1;
      expect(confidence).toBeGreaterThan(0);
      expect(confidence).toBeLessThanOrEqual(100);
    }
  });

  it('is deterministic: identical inputs give identical records', () => {
    expect(build(two, false)).toEqual(caseTwo);
  });

  it('[FR-QI-02] a view with nothing to assess shows "Not assessable yet" instead of a score', () => {
    const analysis = runDeterministicAnalysis({
      view: createTemporalView(one.normalized.events, eventBySuffix(one, 'e01').timestamp),
      pack: one.pack,
      config: CONFIG,
      ctx: one.ctx,
    });
    const avoidable = computeAvoidableEffort({ analysis, pack: one.pack, scenarios: [] });
    const metrics = buildMetricEstimates({
      analysis,
      pack: one.pack,
      ctx: one.ctx,
      review: computeQualityReview({ analysis, pack: one.pack, ctx: one.ctx }),
      avoidable,
      efficiency: computeEfficiency({
        analysis,
        pack: one.pack,
        caseId: one.ctx.caseId,
        synthetic: true,
        avoidable,
      }),
      synthetic: true,
    });
    for (const m of metrics) expect(() => MetricEstimateSchema.parse(m)).not.toThrow();
    for (const key of ['case_quality_index', 'evidence_integrity'] as const) {
      expect(byKey(metrics, key)).toMatchObject({
        value: null,
        low: null,
        high: null,
        display: 'Not assessable yet',
        status: 'unknown',
        confidence: 'low',
      });
    }
    expect(byKey(metrics, 'resolution_confidence').value).not.toBeNull();
  });

  it('[FR-ASE-01] status follows the shared thresholds, inverted when lower is better', () => {
    expect(metricStatus('case_quality_index', null)).toBe('unknown');
    const cqi = METRIC_DEFINITIONS.case_quality_index.thresholds;
    expect(metricStatus('case_quality_index', cqi.good)).toBe('good');
    expect(metricStatus('case_quality_index', cqi.good - 0.1)).toBe('watch');
    expect(metricStatus('case_quality_index', cqi.watch)).toBe('watch');
    expect(metricStatus('case_quality_index', cqi.watch - 0.1)).toBe('poor');
    const ase = METRIC_DEFINITIONS.avoidable_support_effort.thresholds;
    expect(metricStatus('avoidable_support_effort', ase.good)).toBe('good');
    expect(metricStatus('avoidable_support_effort', ase.good + 0.1)).toBe('watch');
    expect(metricStatus('avoidable_support_effort', ase.watch)).toBe('watch');
    expect(metricStatus('avoidable_support_effort', ase.watch + 0.1)).toBe('poor');
  });
});
