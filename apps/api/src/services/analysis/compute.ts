import {
  buildCoachingReport,
  buildDigitalTwin,
  buildMetricEstimates,
  computeAvoidableEffort,
  computeEfficiency,
  computeQualityReview,
  createFullView,
  generateCounterfactuals,
  matchSkills,
  replayWarnings,
  runDeterministicAnalysis,
  type AvoidableEffortEstimate,
  type CoachingSkill,
  type DeterministicAnalysis,
  type EfficiencyReport,
  type EngineContext,
  type SkillMatchSet,
} from '@caseguard/domain';
import {
  COUNTERFACTUAL_STRATEGIES,
  type CaseWarning,
  type CoachingReport,
  type CounterfactualScenario,
  type CounterfactualStrategy,
  type DigitalTwin,
  type MetricEstimate,
  type QualityAssessment,
} from '@caseguard/schemas';
import type { AnalysisInputs } from './inputs';

/** Simulating every fork of a pathological case would be wasted work; the engine ranks them by impact. */
const MAX_SIMULATED_FORKS = 12;

/** The earliest meaningful fork gets every strategy; the others the balanced path only. */
const SECONDARY_STRATEGIES: readonly CounterfactualStrategy[] = ['balanced'];

export type StageReporter = (stageId: string, detail?: string) => Promise<void>;

export interface AnalysisComputation {
  readonly analysis: DeterministicAnalysis;
  readonly twin: DigitalTwin;
  readonly scenarios: CounterfactualScenario[];
  readonly review: QualityAssessment;
  readonly avoidable: AvoidableEffortEstimate;
  readonly efficiency: EfficiencyReport;
  readonly metrics: MetricEstimate[];
  readonly warnings: CaseWarning[];
  readonly coaching: CoachingReport;
  readonly skillMatches: SkillMatchSet;
}

/**
 * The deterministic core of an analysis: everything the product shows is computed here from the
 * stored record alone, in a fixed order, with no clock or randomness beyond the seed in `ctx`. Nothing
 * here calls a model: model calls are validated proposals recorded next to this result, never inputs to it.
 */
export async function computeAnalysis(
  inputs: AnalysisInputs,
  ctx: EngineContext,
  report: StageReporter,
): Promise<AnalysisComputation> {
  const { caseRecord, events, resolution, pack, actionConfig, qualityConfig } = inputs;

  await report('analyse', 'Classifying evidence, scoring hypotheses and ranking actions');
  const view = createFullView(events, resolution);
  const analysis = runDeterministicAnalysis({ view, pack, config: actionConfig, ctx });
  const twin = buildDigitalTwin({
    caseRecord,
    events,
    resolution,
    analysis,
    pack,
    ctx,
    asOf: null,
  });

  await report(
    'counterfactuals',
    `Simulating alternative paths for ${analysis.forks.length} decision fork(s)`,
  );
  const scenarios = simulateForks(inputs, analysis, ctx);

  await report('assess', 'Scoring case quality, avoidable effort and efficiency');
  const review = computeQualityReview({
    analysis,
    pack,
    ctx,
    config: qualityConfig,
    actionConfig,
  });
  const avoidable = computeAvoidableEffort({ analysis, pack, scenarios });
  const efficiency = computeEfficiency({
    analysis,
    pack,
    caseId: caseRecord.id,
    synthetic: caseRecord.synthetic,
    unitPrices: inputs.unitPrices,
    avoidable,
  });
  const metrics = buildMetricEstimates({
    analysis,
    pack,
    ctx,
    review,
    avoidable,
    efficiency,
    synthetic: caseRecord.synthetic,
    actionConfig,
  });

  await report('warnings', 'Replaying live quality warnings over the case');
  const replay = replayWarnings({
    events,
    resolution,
    pack,
    ctx,
    config: actionConfig,
    analysis,
  });

  await report('skills', `Matching ${inputs.skills.length} SkillDNA skill(s) to the case`);
  const lastEventAt = events[events.length - 1]?.timestamp ?? caseRecord.openedAt;
  const skillMatches = matchSkills({
    skills: inputs.skills,
    analysisAsOf: analysis,
    asOf: lastEventAt,
    pack,
    config: actionConfig,
    ctx,
    caseInfo: { workload: caseRecord.workload, product: caseRecord.product },
  });
  const coachingSkills: CoachingSkill[] = skillMatches.matches
    .filter((match) => match.applicability !== 'not_applicable')
    .map((match) => ({
      skillId: match.skillId,
      name:
        inputs.skills.find((entry) => entry.skill.id === match.skillId)?.skill.name ??
        match.skillId,
      matchScore: match.score,
    }));
  const coaching = buildCoachingReport({
    analysis,
    pack,
    ctx,
    review,
    warnings: replay.warnings,
    skills: coachingSkills,
    config: actionConfig,
    synthetic: caseRecord.synthetic,
  });

  return {
    analysis,
    twin,
    scenarios,
    review,
    avoidable,
    efficiency,
    metrics,
    warnings: replay.warnings,
    coaching,
    skillMatches,
  };
}

function simulateForks(
  inputs: AnalysisInputs,
  analysis: DeterministicAnalysis,
  ctx: EngineContext,
): CounterfactualScenario[] {
  const eligible = analysis.forks.filter((fork) => fork.eligibility.eligible);
  const forks = [
    ...eligible.filter((fork) => fork.isEarliestMeaningful),
    ...eligible.filter((fork) => !fork.isEarliestMeaningful),
  ].slice(0, MAX_SIMULATED_FORKS);

  const scenarios: CounterfactualScenario[] = [];
  for (const fork of forks) {
    const result = generateCounterfactuals({
      analysis,
      fork,
      strategies: fork.isEarliestMeaningful ? COUNTERFACTUAL_STRATEGIES : SECONDARY_STRATEGIES,
      events: inputs.events,
      resolution: inputs.resolution,
      pack: inputs.pack,
      config: inputs.actionConfig,
      ctx,
    });
    scenarios.push(...result.scenarios);
  }
  return scenarios;
}
