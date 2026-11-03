import type {
  ActionValueConfig,
  CaseEvent,
  CaseResolution,
  Claim,
  Conflict,
  CounterfactualScenario,
  CounterfactualStrategy,
  DecisionFork,
  DiagnosticAction,
  Evidence,
  HindsightCheck,
  Hypothesis,
  HypothesisEvidenceLink,
  MissingEvidence,
  TemporalFinding,
} from '@caseguard/schemas';
import type { CompiledPack } from '../knowledge/compile';
import { type DecisionRanking, buildDiagnosticActions } from './actions';
import { type BeliefTimeline, buildBeliefTimeline } from './belief';
import { type AnchorInfo, buildClaims } from './claims';
import { detectConflicts } from './conflicts';
import { type EngineContext, buildEvidence } from './context';
import { assembleScenario, simulateAlternativePath } from './counterfactual';
import { detectForks } from './forks';
import { futureOnlyTokens, packStaticTokens } from './leak-check';
import {
  type ActualPath,
  computeActualPath,
  hindsightCheck,
  resolutionHypothesisKey,
} from './hindsight';
import { buildHypotheses } from './hypotheses';
import { computeRequirementStates, type RequirementState } from './requirements';
import { ResponderIndex } from './responders';
import { detectSequenceFindings } from './sequence';
import { detectObservations, type Observation, type SuppressedObservation } from './signals';
import { PrefixAnalyzer } from './state';
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
  /**
   * Words that were found and not counted because the sentence does not state the fact (a denial, a guess, a plan, a
   * condition). They are why an expected signal is missing, and the first thing to look at when one is.
   */
  suppressed: SuppressedObservation[];
  /** Statements of the case that cannot both stand, with both sides and the kind of disagreement. */
  conflicts: Conflict[];
  /** Conclusions that need more than one event, each anchored at the event that makes it true. */
  sequenceFindings: TemporalFinding[];
  /**
   * Bounded notes about limits that shortened this analysis (for example the statement-claim cap).
   * Empty when nothing was truncated; surface them wherever the analysis is presented.
   */
  notes: string[];
}

/** Runs the full deterministic pipeline: signals -> beliefs -> claims -> actions -> forks. */
export function runDeterministicAnalysis(input: AnalysisInput): DeterministicAnalysis {
  const { view, pack, config, ctx } = input;
  const suppressedNotes: { suppressed: SuppressedObservation[] } = { suppressed: [] };
  const observations = detectObservations(view, pack, ctx.caseId, suppressedNotes);
  const evidence = buildEvidence(view, pack, observations, ctx);
  const timeline = buildBeliefTimeline(view, pack, observations, { seed: ctx.seed });
  const requirementStates = computeRequirementStates(view, pack, observations);
  const { claims, anchors, notes } = buildClaims({
    view,
    pack,
    ctx,
    observations,
    evidence,
    timeline,
    requirementStates,
  });
  const analyzer = new PrefixAnalyzer(view, pack, ctx.caseId, { observations, requirementStates });
  const responders = new ResponderIndex(view.events);
  const { actions, decisions } = buildDiagnosticActions({
    view,
    pack,
    ctx,
    config,
    timeline,
    analyzer,
    responders,
  });
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
    analyzer,
    responders,
  });
  const conflicts = detectConflicts({ view, pack, caseId: ctx.caseId, observations });
  const sequenceFindings = detectSequenceFindings({
    view,
    pack,
    caseId: ctx.caseId,
    observations,
    timeline,
    requirementStates,
    forks,
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
    suppressed: suppressedNotes.suppressed,
    conflicts,
    sequenceFindings,
    notes,
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
    // Scenario text is written from the pack, so identifiers the pack itself contains are not leaks.
    packStaticTokens(pack),
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
