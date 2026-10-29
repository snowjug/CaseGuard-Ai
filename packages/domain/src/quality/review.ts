import {
  DEFAULT_ACTION_VALUE_CONFIG,
  DEFAULT_QUALITY_CONFIG,
  PENALTY_LABELS,
  QUALITY_DIMENSIONS,
  QUALITY_DIMENSION_LABELS,
  RESPONSIBLE_USE_NOTICE,
  type ActionValueConfig,
  type AppliedPenalty,
  type CaseEvent,
  type CaseResolution,
  type QualityAssessment,
  type QualityConfig,
} from '@caseguard/schemas';
import { metaOf, type EngineContext } from '../engine/context';
import { runDeterministicAnalysis } from '../engine/pipeline';
import { createTemporalView } from '../engine/temporal';
import type { CompiledPack } from '../knowledge/compile';
import { stableId } from '../util/ids';
import { round } from '../util/math';
import { formatUtcStamp } from '../util/time';
import { buildDimensionDrafts } from './dimensions';
import { buildQualityFacts } from './facts';
import { buildImprovements, type PricedPenalty } from './improvements';
import { DEFAULT_QUALITY_RULE_PARAMETERS, type QualityRuleParameters } from './parameters';
import { detectPenalties } from './penalties';
import { composeQualityScore } from './score';
import type { QualityInput, QualityReview } from './types';

function uncertaintyNote(input: {
  pack: CompiledPack;
  low: number;
  high: number;
  excluded: string[];
  undecided: number;
  asOf: string | null;
}): string {
  const { pack, low, high, excluded, undecided, asOf } = input;
  const nothing = excluded.length >= QUALITY_DIMENSIONS.length;
  return [
    nothing
      ? 'This is a model estimate, but nothing can be assessed from the information in this view yet: the score is a neutral placeholder with the full 0–100 range, not a result.'
      : `Model estimate from a rule-based analysis of the case record using knowledge pack ${pack.pack.id} v${pack.pack.version}; the plausible range is ${low}–${high}.`,
    undecided > 0
      ? `${undecided} sub-checks could not be decided from the information available and widen the range.`
      : null,
    excluded.length > 0 && !nothing
      ? `Not yet assessable and left out of the composite: ${excluded.join(', ')}.`
      : null,
    asOf ? `Scored as of ${formatUtcStamp(asOf)} using only information available then.` : null,
    'It is decision support for focusing a human review, never a verdict about a person.',
    RESPONSIBLE_USE_NOTICE,
  ]
    .filter((s): s is string => s !== null)
    .join(' ');
}

/**
 * Scores one temporal view with the Case Quality Index: six explainable dimensions, ten
 * deterministic penalties (capped), a band, an uncertainty range and recommended improvements.
 * Pure and deterministic for a given analysis; always labelled as an estimate.
 */
export function computeQualityReview(input: QualityInput): QualityReview {
  const { analysis, pack, ctx } = input;
  const config: QualityConfig = input.config ?? DEFAULT_QUALITY_CONFIG;
  const actionConfig: ActionValueConfig = input.actionConfig ?? DEFAULT_ACTION_VALUE_CONFIG;
  const params: QualityRuleParameters = { ...DEFAULT_QUALITY_RULE_PARAMETERS, ...input.parameters };
  const asOf =
    input.asOf !== undefined
      ? input.asOf
      : analysis.view.withheldFutureEventCount > 0
        ? analysis.view.asOf
        : null;

  const facts = buildQualityFacts({ analysis, pack, actionConfig, params });
  const drafts = buildDimensionDrafts(facts);
  const priced: PricedPenalty[] = detectPenalties(facts)
    .map((draft) => ({ ...draft, points: config.penaltyPoints[draft.key] ?? 0 }))
    .filter((p) => p.points > 0);
  const composed = composeQualityScore({ dimensions: drafts, penalties: priced, config });
  const plan = buildImprovements({
    facts,
    dimensions: drafts,
    penalties: priced,
    composed,
    caseId: ctx.caseId,
  });

  const dimensions = drafts.map((draft) => {
    const scored = composed.dimensions.find((d) => d.key === draft.key);
    return {
      key: draft.key,
      label: draft.label,
      weight: scored?.weight ?? 0,
      rawScore: scored?.rawScore ?? draft.rawScore,
      penaltyPoints: scored?.penaltyPoints ?? 0,
      score: scored?.score ?? draft.rawScore,
      low: scored?.low ?? draft.low,
      high: scored?.high ?? draft.high,
      subChecks: draft.subChecks,
      rationale: draft.rationale,
    };
  });
  const penalties: AppliedPenalty[] = priced.map((p) => ({
    id: stableId('pen', ctx.caseId, p.key),
    key: p.key,
    label: PENALTY_LABELS[p.key],
    points: p.points,
    dimension: p.dimension,
    evidence: p.evidence,
    rationale: p.rationale,
  }));
  const undecided = drafts.reduce(
    (n, d) => n + d.subChecks.filter((c) => !c.determinable && c.weight > 0).length,
    0,
  );
  const excluded = drafts.filter((d) => !d.assessable).map((d) => QUALITY_DIMENSION_LABELS[d.key]);

  const review: QualityAssessment = {
    ...metaOf(ctx),
    id: stableId('qa', ctx.caseId, ctx.runId, asOf ?? 'full'),
    caseId: ctx.caseId,
    analysisRunId: ctx.runId,
    asOf,
    compositeScore: composed.composite,
    compositeLow: composed.low,
    compositeHigh: composed.high,
    band: composed.band,
    dimensions,
    penalties,
    totalPenaltyPoints: composed.totalPenaltyPoints,
    penaltyCapApplied: composed.capApplied,
    improvements: plan.improvements,
    estimatedScoreAfterImprovements: plan.estimatedAfter,
    configVersion: config.version,
    weights: Object.fromEntries(
      Object.entries(composed.weights).map(([key, weight]) => [key, round(weight, 4)]),
    ),
    uncertaintyNote: uncertaintyNote({
      pack,
      low: composed.low,
      high: composed.high,
      excluded,
      undecided,
      asOf,
    }),
    estimated: true,
  };
  return review;
}

export interface QualityAsOfInput {
  events: readonly CaseEvent[];
  resolution: CaseResolution | null;
  /** Only events at or before this instant (and the resolution, if it is within) are used. */
  asOf: string;
  pack: CompiledPack;
  ctx: EngineContext;
  /** Action-value configuration the analysis runs with. */
  actionConfig?: ActionValueConfig;
  config?: QualityConfig;
  parameters?: Partial<QualityRuleParameters>;
}

/**
 * Scores the case as it stood at `asOf`: the analysis runs on the prefix of events up to that
 * instant, so nothing recorded later (including the resolution, unless it is within the view) can
 * influence the review.
 */
export function computeQualityReviewAsOf(input: QualityAsOfInput): QualityReview {
  const actionConfig = input.actionConfig ?? DEFAULT_ACTION_VALUE_CONFIG;
  const view = createTemporalView(input.events, input.asOf, { resolution: input.resolution });
  const analysis = runDeterministicAnalysis({
    view,
    pack: input.pack,
    config: actionConfig,
    ctx: input.ctx,
  });
  return computeQualityReview({
    analysis,
    pack: input.pack,
    ctx: input.ctx,
    actionConfig,
    asOf: input.asOf,
    ...(input.config ? { config: input.config } : {}),
    ...(input.parameters ? { parameters: input.parameters } : {}),
  });
}
