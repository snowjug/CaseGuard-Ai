import type {
  ActionValueConfig,
  CaseEvent,
  CaseResolution,
  Claim,
  CounterfactualScenario,
  CounterfactualStrategy,
  DecisionFork,
  DiagnosticAction,
  Evidence,
  HindsightCheck,
  Hypothesis,
  HypothesisEvidenceLink,
  MissingEvidence,
} from '@caseguard/schemas';
import type { CompiledPack } from '../knowledge/compile';
import { type DecisionRanking, buildDiagnosticActions } from './actions';
import { type BeliefTimeline, buildBeliefTimeline } from './belief';
import { type AnchorInfo, buildClaims } from './claims';
import { type EngineContext, buildEvidence } from './context';
import { assembleScenario, futureOnlyTokens, simulateAlternativePath } from './counterfactual';
import { detectForks } from './forks';
import {
  type ActualPath,
  computeActualPath,
  hindsightCheck,
  resolutionHypothesisKey,
} from './hindsight';
import { buildHypotheses } from './hypotheses';
import { computeRequirementStates, type RequirementState } from './requirements';
import { detectObservations, type Observation } from './signals';
import {
  assertPreResolution,
  createFullView,
  createTemporalViewBeforeEvent,
  type TemporalView,
} from './temporal';

export interface AnalysisInput {
  /** The temporal window to analyse: a full view, or an as-of prefix for replays. */
  view: TemporalView;
  pack: CompiledPack;
  config: ActionValueConfig;
  ctx: EngineContext;
}

export interface DeterministicAnalysis {
  view: TemporalView;
  observations: Observation[];
  evidence: Evidence[];
  timeline: BeliefTimeline;
  requirementStates: RequirementState[];
  claims: Claim[];
  anchors: AnchorInfo[];
  hypotheses: Hypothesis[];
  links: HypothesisEvidenceLink[];
  missing: MissingEvidence[];
  actions: DiagnosticAction[];
  decisions: Map<string, DecisionRanking>;
  forks: DecisionFork[];
  earliestMeaningfulForkId: string | null;
}

/** Runs the full deterministic pipeline: signals -> beliefs -> claims -> actions -> forks. */
export function runDeterministicAnalysis(input: AnalysisInput): DeterministicAnalysis {
  const { view, pack, config, ctx } = input;
  const observations = detectObservations(view, pack, ctx.caseId);
  const evidence = buildEvidence(view, pack, observations, ctx);
  const timeline = buildBeliefTimeline(view, pack, observations, { seed: ctx.seed });
  const requirementStates = computeRequirementStates(view, pack, observations);
  const { claims, anchors } = buildClaims({
    view,
    pack,
    ctx,
    observations,
    evidence,
    timeline,
    requirementStates,
  });
  const { actions, decisions } = buildDiagnosticActions({ view, pack, ctx, config, timeline });
  const { hypotheses, links, missing } = buildHypotheses({
    pack,
    ctx,
    config,
    timeline,
    observations,
    evidence,
    claims,
    actions,
    requirementStates,
  });
  const { forks, earliestMeaningfulForkId } = detectForks({
    view,
    pack,
    ctx,
    config,
    timeline,
    observations,
    evidence,
    claims,
    anchors,
    requirementStates,
    actions,
    decisions,
  });
  return {
    view,
    observations,
    evidence,
    timeline,
    requirementStates,
    claims,
    anchors,
    hypotheses,
    links,
    missing,
    actions,
    decisions,
    forks,
    earliestMeaningfulForkId,
  };
}

export interface CounterfactualRequest {
  analysis: DeterministicAnalysis;
  fork: DecisionFork;
  strategies: readonly CounterfactualStrategy[];
  events: readonly CaseEvent[];
  resolution: CaseResolution | null;
  pack: CompiledPack;
  config: ActionValueConfig;
  ctx: EngineContext;
  rolloutCount?: number;
}

export interface CounterfactualResult {
  scenarios: CounterfactualScenario[];
  hindsight: HindsightCheck[];
  actual: ActualPath;
}

/**
 * Generates one scenario per strategy. Generation sees only the boundary view; the actual path and
 * the hindsight check are computed afterwards from the full record and never feed generation.
 */
export function generateCounterfactuals(request: CounterfactualRequest): CounterfactualResult {
  const { analysis, fork, strategies, events, resolution, pack, config, ctx } = request;
  const preView = createTemporalViewBeforeEvent(events, fork.eventId);
  assertPreResolution(preView);
  const futureTokens = futureOnlyTokens(
    events,
    preView,
    resolution
      ? `${resolution.summary} ${resolution.rootCause} ${resolution.workaround ?? ''} ${resolution.permanentFix ?? ''}`
      : '',
  );

  const fullView = createFullView(events, resolution);
  const actual = computeActualPath({
    fork,
    view: fullView,
    pack,
    timeline: analysis.timeline,
    requirementStates: analysis.requirementStates,
    actions: analysis.actions,
    decisions: analysis.decisions,
  });

  const scenarios: CounterfactualScenario[] = [];
  const hindsight: HindsightCheck[] = [];
  for (const strategy of strategies) {
    const sim = simulateAlternativePath({
      preView,
      fork,
      strategy,
      pack,
      config,
      ctx,
      ...(request.rolloutCount !== undefined ? { rolloutCount: request.rolloutCount } : {}),
    });
    const scenario = assembleScenario({
      sim,
      preView,
      fork,
      pack,
      config,
      ctx,
      evidence: analysis.evidence,
      actualMetrics: actual.metrics,
      futureTokens,
    });
    scenarios.push(scenario);
    const truthKey = resolutionHypothesisKey(resolution, pack);
    const conditioned = truthKey
      ? simulateAlternativePath({
          preView,
          fork,
          strategy,
          pack,
          config,
          ctx,
          rolloutCount: Math.min(100, request.rolloutCount ?? pack.pack.policies.rolloutCount),
          conditionOnHypothesis: truthKey,
        })
      : null;
    hindsight.push(hindsightCheck(scenario, actual, resolution, pack, ctx, conditioned));
  }
  return { scenarios, hindsight, actual };
}
