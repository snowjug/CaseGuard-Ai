import {
  DEFAULT_ACTION_VALUE_CONFIG,
  DEFAULT_EFFORT_MINUTES,
  METRIC_DEFINITIONS,
  METRIC_KEYS,
  type ActionValueConfig,
  type EvidenceLink,
  type Level,
  type MetricEstimate,
  type MetricKey,
} from '@caseguard/schemas';
import { metaOf, type EngineContext } from '../engine/context';
import { resolutionHypothesisKey } from '../engine/hindsight';
import type { DeterministicAnalysis } from '../engine/pipeline';
import { isSatisfiedAt } from '../engine/requirements';
import type { CompiledPack } from '../knowledge/compile';
import { isAssessed } from '../quality/checks';
import { CLOSURE_REQUIREMENT_IDS } from '../quality/parameters';
import { evidenceLink, truncate } from '../quality/links';
import type { QualityReview } from '../quality/types';
import { stableId } from '../util/ids';
import { clamp, round } from '../util/math';
import type { AvoidableEffortEstimate } from './ase-model';
import { toAvoidableEffortDetails } from './ase-details';
import type { EfficiencyReport } from './efficiency';
import { computeReasoningEfficiency } from './reasoning';

export interface MetricEstimatesInput {
  analysis: DeterministicAnalysis;
  pack: CompiledPack;
  ctx: EngineContext;
  review: QualityReview;
  avoidable: AvoidableEffortEstimate;
  efficiency: EfficiencyReport;
  synthetic: boolean;
  actionConfig?: ActionValueConfig;
}

type Contributor = MetricEstimate['contributors'][number];

/** good / watch / poor from the shared thresholds (inverted when lower is better). */
export function metricStatus(key: MetricKey, value: number | null): MetricEstimate['status'] {
  if (value === null) return 'unknown';
  const def = METRIC_DEFINITIONS[key];
  if (def.higherIsBetter) {
    return value >= def.thresholds.good ? 'good' : value >= def.thresholds.watch ? 'watch' : 'poor';
  }
  return value <= def.thresholds.good ? 'good' : value <= def.thresholds.watch ? 'watch' : 'poor';
}

const levelFromWidth = (width: number, narrow: number, wide: number): Level =>
  width <= narrow ? 'high' : width <= wide ? 'medium' : 'low';

const shareOf = (value: number, total: number): number | null =>
  total > 0 ? round(clamp(value / total, 0, 1), 3) : null;

function reviewMetrics(
  review: QualityReview,
): Record<'case_quality_index' | 'evidence_integrity', Partial<MetricEstimate>> {
  const evidence = review.dimensions.find((d) => d.key === 'evidence_integrity');
  const evidenceAssessed = evidence !== undefined && isAssessed(evidence);
  const anyAssessed = review.dimensions.some(isAssessed);
  const contributions = review.dimensions.map((d) => ({ d, points: d.weight * d.rawScore }));
  const positive = contributions.reduce((s, c) => s + c.points, 0);
  const cqiContributors: Contributor[] = [
    ...contributions.map(({ d, points }) => ({
      label: `${d.label} (weight ${Math.round(d.weight * 100)}%)`,
      value: round(points, 1),
      unit: 'points',
      share: shareOf(points, positive),
      evidence: d.subChecks.flatMap((c) => c.evidence).slice(0, 4),
    })),
    ...review.penalties.map((p) => ({
      label: p.label,
      value: -p.points,
      unit: 'points',
      share: null,
      evidence: p.evidence.slice(0, 4),
    })),
  ];
  return {
    case_quality_index: {
      value: anyAssessed ? review.compositeScore : null,
      low: anyAssessed ? review.compositeLow : null,
      high: anyAssessed ? review.compositeHigh : null,
      display: anyAssessed ? `${Math.round(review.compositeScore)} / 100` : 'Not assessable yet',
      confidence: anyAssessed
        ? levelFromWidth(review.compositeHigh - review.compositeLow, 10, 25)
        : 'low',
      method: `${METRIC_DEFINITIONS.case_quality_index.formula}. ${review.uncertaintyNote}`,
      assumptions: [
        `Weights and penalty points come from quality configuration ${review.configVersion}.`,
        'Penalties are rule-based, evidence-linked and capped; they are not judgements of a person.',
      ],
      contributors: cqiContributors,
    },
    evidence_integrity: {
      value: evidenceAssessed ? evidence.score : null,
      low: evidenceAssessed ? evidence.low : null,
      high: evidenceAssessed ? evidence.high : null,
      display: evidenceAssessed ? `${Math.round(evidence.score)} / 100` : 'Not assessable yet',
      confidence: evidenceAssessed ? levelFromWidth(evidence.high - evidence.low, 10, 25) : 'low',
      method:
        `${METRIC_DEFINITIONS.evidence_integrity.formula}. ${evidence?.rationale ?? ''}`.trim(),
      assumptions: [
        'Statements are classified by transparent rules over the case text and the knowledge pack.',
      ],
      contributors: (evidence?.subChecks ?? [])
        .filter((c) => c.determinable)
        .map((c) => ({
          label: c.label,
          value: round(c.score * 100, 0),
          unit: 'score',
          share: shareOf(
            c.weight,
            (evidence?.subChecks ?? []).reduce((s, x) => s + x.weight, 0),
          ),
          evidence: c.evidence,
        })),
    },
  };
}

function aseMetric(ase: AvoidableEffortEstimate): Partial<MetricEstimate> {
  const percent = ase.percent;
  const contributors: Contributor[] = ase.components
    .filter((c) => c.included)
    .map((c) => ({ c, points: c.weight * c.pct.mid }))
    .sort((a, b) => b.points - a.points)
    .map(({ c, points }) => ({
      label: c.label,
      value: round(points, 1),
      unit: 'percentage points',
      share: shareOf(points, percent?.mid ?? 0),
      evidence: c.evidence,
    }));
  const excluded = ase.components
    .filter((c) => !c.included)
    .map((c) => `${c.label}: ${c.assumption}`);
  return {
    value: percent?.mid ?? null,
    low: percent?.low ?? null,
    high: percent?.high ?? null,
    display: percent ? `${Math.round(percent.mid)}% (estimate)` : 'Not available',
    confidence: ase.confidence,
    method: ase.reason ? `${ase.reason} ${ase.method}` : ase.method,
    assumptions: [...ase.assumptions, ...excluded],
    contributors,
    comparison: ase.basis
      ? {
          actual: 100,
          counterfactual: ase.basis.remainingPct.mid,
          counterfactualLow: ase.basis.remainingPct.low,
          counterfactualHigh: ase.basis.remainingPct.high,
          scenarioId: ase.basis.bestScenarioId,
        }
      : null,
    ase: toAvoidableEffortDetails(ase),
  };
}

function resolutionConfidence(
  analysis: DeterministicAnalysis,
  pack: CompiledPack,
): Partial<MetricEstimate> {
  const last = analysis.timeline.steps[analysis.timeline.steps.length - 1];
  if (!last) {
    return {
      value: null,
      low: null,
      high: null,
      display: 'Not available',
      confidence: 'low',
      method: `${METRIC_DEFINITIONS.resolution_confidence.formula}. No events are in this view.`,
      assumptions: [],
      contributors: [],
    };
  }
  const recorded = resolutionHypothesisKey(analysis.view.resolution, pack);
  const top = Object.entries(last.posterior).sort((a, b) => b[1] - a[1])[0];
  const key = recorded ?? top?.[0] ?? 'hyp.other';
  const lastIndex = analysis.timeline.steps.length - 1;
  const done = (id: string): boolean => {
    const state = analysis.requirementStates.find((s) => s.requirementId === id);
    return state !== undefined && isSatisfiedAt(state, lastIndex);
  };
  const confirmation = pack.hypotheses.get(key)?.confirmationRequirementIds ?? [];
  const factors = [
    { label: 'Baseline for an unvalidated cause', value: 0.6, met: true },
    {
      label: 'Before/after validation on record',
      value: 0.2,
      met: done(CLOSURE_REQUIREMENT_IDS.fixValidation),
    },
    {
      label: 'Customer confirmed the result',
      value: 0.1,
      met: done(CLOSURE_REQUIREMENT_IDS.customerConfirmation),
    },
    {
      label: 'Confirming evidence for the hypothesis collected',
      value: 0.1,
      met: confirmation.length > 0 && confirmation.every(done),
    },
  ];
  const factor = factors.reduce((s, f) => s + (f.met ? f.value : 0), 0);
  const posterior = last.posterior[key] ?? 0;
  const low = (last.low[key] ?? posterior) * factor * 100;
  const high = (last.high[key] ?? posterior) * factor * 100;
  const value = posterior * factor * 100;
  const name = pack.hypotheses.get(key)?.name ?? key;
  return {
    value: round(value, 1),
    low: round(Math.min(low, value), 1),
    high: round(Math.max(high, value), 1),
    display: `${Math.round(value)}% (model estimate)`,
    confidence: levelFromWidth(Math.abs(high - low), 12, 30),
    method: `${METRIC_DEFINITIONS.resolution_confidence.formula}. Hypothesis “${name}”: model posterior ${Math.round(posterior * 100)}% times a validation factor of ${round(factor, 2)}.${recorded ? ' The hypothesis is the one the recorded resolution points to.' : ' No resolution is in this view, so the leading hypothesis is used.'}`,
    assumptions: [
      'The posterior is a model estimate from the knowledge pack, not a statistical probability.',
      'The validation factor adds credit for before/after validation, customer confirmation and confirming evidence.',
    ],
    contributors: [
      {
        label: `Posterior of “${name}”`,
        value: round(posterior * 100, 1),
        unit: 'percent',
        share: null,
        evidence: [evidenceLink('hypothesis', key, name)],
      },
      ...factors.map((f) => ({
        label: f.label,
        value: f.met ? round(f.value, 2) : 0,
        unit: 'factor',
        share: shareOf(f.met ? f.value : 0, factor),
        evidence: [] as EvidenceLink[],
      })),
    ],
  };
}

/**
 * Builds the seven metric estimates (contract order) from the review, the avoidable-effort result,
 * the efficiency report and the analysis. Every one is labelled as an estimate.
 */
export function buildMetricEstimates(input: MetricEstimatesInput): MetricEstimate[] {
  const { analysis, pack, ctx, review, avoidable, efficiency, synthetic } = input;
  const actionConfig = input.actionConfig ?? DEFAULT_ACTION_VALUE_CONFIG;
  const reasoning = computeReasoningEfficiency(analysis, pack, actionConfig);
  const reasoningN = reasoning.decisions.length;
  const minutes = analysis.actions.reduce(
    (s, a) => s + DEFAULT_EFFORT_MINUTES[a.customerEffort],
    0,
  );
  const heavy = analysis.actions
    .filter((a) => DEFAULT_EFFORT_MINUTES[a.customerEffort] > 0)
    .sort(
      (a, b) => DEFAULT_EFFORT_MINUTES[b.customerEffort] - DEFAULT_EFFORT_MINUTES[a.customerEffort],
    )
    .slice(0, 5);
  const bits = efficiency.bitsPer1kTokens;
  const bitsMargin = bits.basis === 'measured' ? 0.1 : 0.3;
  // Recorded token telemetry on a synthetic case is simulated, so it is never presented as measured.
  const bitsBasisLabel =
    bits.basis === 'measured' && synthetic ? 'simulated telemetry' : bits.basis;
  const fromReview = reviewMetrics(review);

  const parts: Record<MetricKey, Partial<MetricEstimate>> = {
    ...fromReview,
    avoidable_support_effort: aseMetric(avoidable),
    reasoning_efficiency: {
      value: reasoning.value,
      low: reasoning.value === null ? null : round(clamp(reasoning.value - 10, 0, 100), 1),
      high: reasoning.value === null ? null : round(clamp(reasoning.value + 10, 0, 100), 1),
      display: reasoning.value === null ? 'Not available' : `${Math.round(reasoning.value)} / 100`,
      confidence: reasoningN >= 5 ? 'medium' : 'low',
      method: `${METRIC_DEFINITIONS.reasoning_efficiency.formula}. Trivially cheap steps and routine hygiene steps count as best-available unless they were repeats or re-checks of known outcomes (strict reading without that rule: ${reasoning.strictValue ?? 'n/a'}).`,
      assumptions: [
        'Relative value is the engine action-value heuristic at the decision time, not a scientific measure.',
        `${reasoningN} ranked decisions contribute; the displayed range is a fixed ±10 for classification uncertainty.`,
      ],
      contributors: reasoning.decisions
        .filter((d) => d.ratio < 0.7)
        .map((d) => ({
          label: d.action.label,
          value: round(d.ratio * 100, 0),
          unit: 'percent of best safe action',
          share: null,
          evidence: [evidenceLink('action', d.action.id, d.action.label)],
        }))
        .slice(0, 5),
    },
    customer_effort: {
      value: minutes,
      low: Math.round(minutes * 0.7),
      high: Math.round(minutes * 1.4),
      display: `${minutes} min (estimated)`,
      confidence: 'medium',
      method: `${METRIC_DEFINITIONS.customer_effort.formula}. These are effort-level minutes, not measured customer time.`,
      assumptions: [
        'Effort levels map to minutes with the default scale (assumption A-06); the range is -30% / +40%.',
      ],
      contributors: heavy.map((a) => ({
        label: a.label,
        value: DEFAULT_EFFORT_MINUTES[a.customerEffort],
        unit: 'minutes',
        share: shareOf(DEFAULT_EFFORT_MINUTES[a.customerEffort], minutes),
        evidence: [evidenceLink('action', a.id, a.label)],
      })),
    },
    resolution_confidence: resolutionConfidence(analysis, pack),
    token_efficiency: {
      value: bits.value,
      low: bits.value === null ? null : round(bits.value * (1 - bitsMargin), 3),
      high: bits.value === null ? null : round(bits.value * (1 + bitsMargin), 3),
      display:
        bits.value === null
          ? 'Not available'
          : `${bits.value} bits per 1k tokens (${bitsBasisLabel})`,
      confidence: bits.basis === 'measured' ? 'medium' : 'low',
      method: `${METRIC_DEFINITIONS.token_efficiency.formula}. ${bits.note}`,
      assumptions: [
        synthetic
          ? 'Token counts come from simulated telemetry on a synthetic case.'
          : 'Token counts come from recorded telemetry where available, estimates elsewhere.',
        'Information gain is a model estimate from hypothesis updates.',
      ],
      contributors: efficiency.cheaperEquivalents.slice(0, 3).map((c) => ({
        label: `Possible saving: ${c.alternativeLabel}`,
        value: c.savedTokens,
        unit: 'tokens',
        share: null,
        evidence: c.evidence,
      })),
    },
  };
  return METRIC_KEYS.map((key) => {
    const def = METRIC_DEFINITIONS[key];
    const p = parts[key];
    const value = p.value ?? null;
    return {
      ...metaOf(ctx),
      id: stableId('met', ctx.caseId, ctx.runId, key),
      caseId: ctx.caseId,
      analysisRunId: ctx.runId,
      key,
      label: def.label,
      value,
      unit: def.unit,
      display: p.display ?? 'Not available',
      low: p.low ?? null,
      high: p.high ?? null,
      confidence: p.confidence ?? 'low',
      status: metricStatus(key, value),
      definition: def.definition,
      method: truncate(p.method ?? def.formula, 4000),
      assumptions: p.assumptions ?? [],
      contributors: p.contributors ?? [],
      comparison: p.comparison ?? null,
      ase: key === 'avoidable_support_effort' ? (p.ase ?? null) : null,
      estimated: true,
      synthetic,
    };
  });
}
