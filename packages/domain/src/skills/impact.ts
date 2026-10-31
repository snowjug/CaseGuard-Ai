import type {
  ActionValueConfig,
  CounterfactualStrategy,
  Range,
  SkillVersion,
} from '@caseguard/schemas';
import type { EngineContext } from '../engine/context';
import type { DeterministicAnalysis } from '../engine/pipeline';
import type { CompiledPack } from '../knowledge/compile';
import { round } from '../util/math';
import { formatDuration } from '../util/time';
import {
  defaultDecisionEventId,
  differenceRange,
  measureActualPath,
  type ActualMeasure,
} from './actual';
import type { ConformanceReport } from './conformance';
import { asOfView } from './guidance';
import type { GuidedPlan } from './plan';
import { simulateBaselinePolicy, type BaselineResult } from './replay';
import { knowledgeStateFromView } from './state';
import { pct } from './util';

/**
 * A recorded path from another case (for example the skill's source case). On its own it is context
 * for an impact estimate. Every figure is measured from the case record exactly as the recorded path of
 * the case under estimate (`measureActualPath`), each from its own decision point, so the two are
 * comparable with each other even though they describe different cases.
 */
export interface ImpactPrecedent {
  reference: string;
  timeToDiagnosisMinutes: number;
  customerEffortMinutes: number;
  actionCount: number;
  /** Estimated material read for the recorded steps, defined as for the recorded path. */
  tokenEstimate: number;
  /** Share (0-1) of the minimum-evidence items held at the recorded diagnosis, defined as for the recorded path. */
  evidenceCompleteness: number;
  /** False when the recorded path ends without a confirmed diagnosis: its time is then not a time to diagnosis. */
  reachedDiagnosis: boolean;
}

/**
 * The recorded path of a finished case from its own decision point (for example the skill's source
 * case), as context for an impact estimate. It is measured from the case record, never estimated.
 */
export function impactPrecedentOf(args: {
  reference: string;
  analysis: DeterministicAnalysis;
  pack: CompiledPack;
  minimumEvidence: readonly string[];
}): ImpactPrecedent | null {
  const { reference, analysis, pack, minimumEvidence } = args;
  const decisionEventId = defaultDecisionEventId(analysis);
  const fromIndex = analysis.view.events.findIndex((e) => e.id === decisionEventId);
  const first = analysis.view.events[fromIndex];
  if (!first || fromIndex < 0) return null;
  const measure = measureActualPath({
    analysis,
    pack,
    fromIndex,
    fromAt: first.timestamp,
    minimumEvidence,
  });
  return measure
    ? {
        reference,
        timeToDiagnosisMinutes: measure.timeToDiagnosisMinutes,
        customerEffortMinutes: measure.customerEffortMinutes,
        actionCount: measure.actionCount,
        tokenEstimate: measure.tokenEstimate,
        evidenceCompleteness: measure.evidenceCompleteness,
        reachedDiagnosis: measure.reachedDiagnosis,
      }
    : null;
}

export interface SkillImpactInput {
  /** The guided plan as it stood when the skill was applied (its `asOf` is the comparison start). */
  plan: GuidedPlan;
  version: SkillVersion;
  /** Full analysis of the case: the recorded path is read post-hoc to measure what happened. */
  analysis: DeterministicAnalysis;
  pack: CompiledPack;
  config: ActionValueConfig;
  ctx: EngineContext;
  synthetic: boolean;
  strategy?: CounterfactualStrategy;
  rolloutCount?: number;
  conformance?: ConformanceReport | null;
  precedent?: ImpactPrecedent | null;
}

export type RangePosition =
  'below_range' | 'at_or_below_median' | 'above_median_within_range' | 'above_range';

export interface ImpactDecisionPoint {
  eventId: string;
  at: string;
  recordedActionKey: string | null;
  recordedLabel: string;
  /** The skill step (or stage alternative) this recorded action corresponds to, if any. */
  plannedStepId: string | null;
  plannedStage: number | null;
  baselineBestActionKey: string | null;
  baselineBestLabel: string | null;
  /** Relative action value of the recorded step versus the best safe candidate at that moment. */
  relativeValue: number | null;
  agreement: 'same_as_baseline_best' | 'different_route' | 'not_ranked';
}

export interface SkillImpactEstimate {
  labels: { estimated: true; simulated: true; synthetic: boolean };
  planAsOf: string;
  decisionEventId: string | null;
  baseline: BaselineResult & { policy: string };
  /** Measured from the case record (descriptive); only the comparison with the baseline is an estimate. */
  recorded: ActualMeasure | null;
  /** Estimated `baseline - recorded` per bound: positive means the recorded path was lower. */
  difference: {
    timeToDiagnosisMinutes: Range;
    customerEffortMinutes: Range;
    customerInteractions: Range;
    tokenEstimate: Range;
  } | null;
  /** Recorded minus baseline for minimum-evidence completeness: positive means more complete. */
  evidenceCompletenessUplift: Range | null;
  position: {
    time: RangePosition;
    customerEffort: RangePosition;
    tokens: RangePosition;
    evidenceCompleteness: RangePosition;
  } | null;
  decisionPoints: ImpactDecisionPoint[];
  conformance: { level: ConformanceReport['level']; score: number } | null;
  precedent:
    | (ImpactPrecedent & {
        timeDifferenceMinutes: number;
        note: string;
      })
    | null;
  headline: string;
  statements: string[];
  caveats: string[];
  notice: string;
}

export function positionOf(value: number, range: Range): RangePosition {
  if (value < range.low) return 'below_range';
  if (value <= range.mid) return 'at_or_below_median';
  if (value <= range.high) return 'above_median_within_range';
  return 'above_range';
}

const TIME_PHRASE: Record<RangePosition, string> = {
  below_range: 'shorter than the whole estimated range',
  at_or_below_median: 'at or below the estimated median',
  above_median_within_range: 'longer than the estimated median but within the estimated range',
  above_range: 'longer than the whole estimated range',
};

const EVIDENCE_PHRASE: Record<RangePosition, string> = {
  below_range: 'less complete than the whole estimated range',
  at_or_below_median: 'no more complete than the estimated median',
  above_median_within_range: 'more complete than the estimated median',
  above_range: 'more complete than the whole estimated range',
};

/** Evidence completeness is "higher is better", so its position is read from the other side. */
function evidencePosition(value: number, range: Range): RangePosition {
  if (value > range.high) return 'above_range';
  if (value > range.mid) return 'above_median_within_range';
  if (value >= range.low) return 'at_or_below_median';
  return 'below_range';
}

const EFFORT_PHRASE: Record<RangePosition, string> = {
  below_range: 'lower than the whole estimated range',
  at_or_below_median: 'at or below the estimated median',
  above_median_within_range: 'higher than the estimated median but within the estimated range',
  above_range: 'higher than the whole estimated range',
};

const PRECEDENT_NOTE =
  'Recorded in a different case: shown for context only. It is not a controlled baseline for this case.';

/**
 * Honest, estimated comparison of the recorded path with what the knowledge-pack action-value policy
 * would be expected to do WITHOUT the skill, starting from the same evidence at the plan time. The
 * baseline is a seeded simulation (a range, never a point); the recorded values are measured from the
 * case. The difference is an estimate for one case and never a measurement of the skill's effect.
 */
export function estimateSkillImpact(input: SkillImpactInput): SkillImpactEstimate {
  const { plan, version, analysis, pack, config, ctx } = input;
  const view = asOfView(analysis, plan.asOf);
  const { state: state0 } = knowledgeStateFromView(view, pack, ctx.caseId);
  const minimumEvidence = version.content.minimumEvidence.map((m) => m.requirementId);
  const strategy = input.strategy ?? 'balanced';
  const baseline = simulateBaselinePolicy({
    state0,
    pack,
    config,
    strategy,
    // The baseline is what the knowledge-pack policy does at this moment, with or without any one skill, so
    // its stream is named by the moment. A skill id is generated per database and must not enter a seed.
    seed: `${ctx.seed}|skill-impact|${plan.asOf}`,
    rolloutCount: input.rolloutCount ?? pack.pack.policies.rolloutCount,
    minimumEvidence,
  });
  const events = analysis.view.events;
  const fromIndex = events.findIndex((e) => e.timestamp > plan.asOf);
  const first = events[fromIndex];
  const recorded =
    first && fromIndex >= 0
      ? measureActualPath({ analysis, pack, fromIndex, fromAt: first.timestamp, minimumEvidence })
      : null;

  const decisionPoints: ImpactDecisionPoint[] = recorded
    ? analysis.actions
        .filter((a) => a.sequence >= fromIndex)
        .filter((a) => {
          const end = recorded.diagnosisAt ?? events[events.length - 1]?.timestamp ?? '';
          return a.startedAt <= end;
        })
        .map((a) => {
          const ranking = analysis.decisions.get(a.eventId);
          const planned = plan.steps.find(
            (s) => s.actionKey !== null && s.actionKey === a.actionKey,
          );
          const best = ranking?.best ?? null;
          return {
            eventId: a.eventId,
            at: a.startedAt,
            recordedActionKey: a.actionKey,
            recordedLabel: a.actionKey
              ? (pack.actions.get(a.actionKey)?.label ?? a.label)
              : a.label,
            plannedStepId: planned?.stepId ?? null,
            plannedStage: planned?.stage ?? null,
            baselineBestActionKey: best?.actionKey ?? null,
            baselineBestLabel: best?.label ?? null,
            relativeValue: ranking?.relative ?? null,
            agreement: !best
              ? 'not_ranked'
              : best.actionKey === a.actionKey
                ? 'same_as_baseline_best'
                : 'different_route',
          };
        })
    : [];

  const bm = baseline.metrics;
  const difference = recorded
    ? {
        timeToDiagnosisMinutes: differenceRange(
          bm.timeToDiagnosisMinutes,
          recorded.timeToDiagnosisMinutes,
        ),
        customerEffortMinutes: differenceRange(
          bm.customerEffortMinutes,
          recorded.customerEffortMinutes,
        ),
        customerInteractions: differenceRange(
          bm.customerInteractions,
          recorded.customerInteractions,
        ),
        tokenEstimate: differenceRange(bm.tokenEstimate, recorded.tokenEstimate),
      }
    : null;
  const uplift = recorded
    ? {
        low: round(recorded.evidenceCompleteness - bm.evidenceCompleteness.high, 3),
        mid: round(recorded.evidenceCompleteness - bm.evidenceCompleteness.mid, 3),
        high: round(recorded.evidenceCompleteness - bm.evidenceCompleteness.low, 3),
      }
    : null;
  const position = recorded
    ? {
        time: positionOf(recorded.timeToDiagnosisMinutes, bm.timeToDiagnosisMinutes),
        customerEffort: positionOf(recorded.customerEffortMinutes, bm.customerEffortMinutes),
        tokens: positionOf(recorded.tokenEstimate, bm.tokenEstimate),
        evidenceCompleteness: evidencePosition(
          recorded.evidenceCompleteness,
          bm.evidenceCompleteness,
        ),
      }
    : null;

  const fd = formatDuration;
  const statements: string[] = [];
  if (recorded && position) {
    statements.push(
      `Time (estimated baseline vs recorded): without the skill the action-value policy is simulated to need about ${fd(bm.timeToDiagnosisMinutes.mid)} (range ${fd(bm.timeToDiagnosisMinutes.low)}–${fd(bm.timeToDiagnosisMinutes.high)}) from the first step to a confirmed diagnosis; the recorded path took ${fd(recorded.timeToDiagnosisMinutes)}${recorded.reachedDiagnosis ? '' : ' without reaching a confirmed diagnosis'}, which is ${TIME_PHRASE[position.time]}.`,
      `Customer effort (estimated): about ${bm.customerEffortMinutes.mid} customer minutes (range ${bm.customerEffortMinutes.low}–${bm.customerEffortMinutes.high}) for the baseline versus ${recorded.customerEffortMinutes} recorded, which is ${EFFORT_PHRASE[position.customerEffort]}.`,
      `Tokens (estimated): about ${bm.tokenEstimate.mid} (range ${bm.tokenEstimate.low}–${bm.tokenEstimate.high}) for the baseline versus ${recorded.tokenEstimate} for the recorded steps, which is ${EFFORT_PHRASE[position.tokens]}.`,
      `Evidence completeness: the recorded path held ${pct(recorded.evidenceCompleteness)} of the skill's minimum-evidence items when it was diagnosed; the baseline policy typically holds ${pct(bm.evidenceCompleteness.mid)} (every item in ${pct(baseline.evidenceCompleteShare)} of ${baseline.count} rollouts), which makes the recorded path ${EVIDENCE_PHRASE[position.evidenceCompleteness]}.`,
    );
  } else {
    statements.push('No steps were recorded after the plan time, so nothing can be compared yet.');
  }
  const same = decisionPoints.filter((d) => d.agreement === 'same_as_baseline_best').length;
  if (decisionPoints.length > 0) {
    statements.push(
      `At ${same} of ${decisionPoints.length} decision points the recorded step was the baseline's top-ranked action; the others were different routes, which can be justified when evidence is collected first.`,
    );
  }
  const headline =
    recorded && position
      ? `Estimated, not measured. Time to diagnosis: recorded ${fd(recorded.timeToDiagnosisMinutes)} versus an estimated ${fd(bm.timeToDiagnosisMinutes.mid)} without the skill (range ${fd(bm.timeToDiagnosisMinutes.low)}–${fd(bm.timeToDiagnosisMinutes.high)}), which is ${TIME_PHRASE[position.time]}. Minimum-evidence completeness: ${pct(recorded.evidenceCompleteness)} recorded versus about ${pct(bm.evidenceCompleteness.mid)} estimated.`
      : 'Estimated, not measured: no recorded path is available to compare with the baseline yet.';

  const precedent =
    input.precedent && recorded
      ? {
          ...input.precedent,
          timeDifferenceMinutes: round(
            input.precedent.timeToDiagnosisMinutes - recorded.timeToDiagnosisMinutes,
            1,
          ),
          note: PRECEDENT_NOTE,
        }
      : null;
  const stamp = baseline.seed;
  return {
    labels: { estimated: true, simulated: true, synthetic: input.synthetic },
    planAsOf: plan.asOf,
    decisionEventId: recorded?.fromEventId ?? null,
    baseline: {
      ...baseline,
      policy: `Knowledge-pack action-value policy (${strategy}), without the skill`,
    },
    recorded,
    difference,
    evidenceCompletenessUplift: uplift,
    position,
    decisionPoints,
    conformance: input.conformance
      ? { level: input.conformance.level, score: input.conformance.score }
      : null,
    precedent,
    headline,
    statements,
    caveats: [
      `The baseline is a simulation (${baseline.count} seeded rollouts, seed ${stamp}) that uses only the evidence available at ${plan.asOf}; its true cause is sampled from the decision-time belief.`,
      'One case and no control group: the skill’s own effect cannot be isolated, and the difference is an estimate with a range, not a measurement.',
      'The baseline prices steps with the knowledge pack’s estimated durations and has no waiting between steps, while recorded times include real gaps, so recorded times read longer than the baseline by construction.',
      'Token figures estimate the material that has to be read for each step (knowledge-pack estimates and recorded output sizes); they are not metered usage.',
      'The knowledge pack already encodes much of the domain knowledge a skill captures, so a skill is not expected to beat this baseline on speed; its value shows in evidence completeness, safety and reuse.',
      input.synthetic
        ? 'All data are synthetic and demonstrate the pipeline only.'
        : 'Figures describe this case only.',
    ],
    notice:
      'Estimated comparison. "Expected without the skill" comes from a seeded simulation of the action-value baseline at the same decision moment; "recorded" values come from the case. It does not measure the skill’s effect.',
  };
}
