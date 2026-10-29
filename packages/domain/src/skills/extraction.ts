import {
  type ActionValueConfig,
  type CaseEvent,
  type CaseResolution,
  type CounterfactualScenario,
  type DecisionFork,
  type KnowledgeAction,
  type SkillContent,
  type SkillDna,
  type SkillProvenance,
  type SkillVersion,
} from '@caseguard/schemas';
import type { EngineContext } from '../engine/context';
import { simulateAlternativePath } from '../engine/counterfactual';
import { resolutionHypothesisKey } from '../engine/hindsight';
import type { DeterministicAnalysis } from '../engine/pipeline';
import { createTemporalViewBeforeEvent } from '../engine/temporal';
import type { CompiledPack } from '../knowledge/compile';
import { hashJson, stableId } from '../util/ids';
import { round } from '../util/math';
import {
  buildCandidateAction,
  buildCondition,
  buildDecisionStep,
  buildMinimumEvidence,
  buildRequiredInputs,
  buildSafetyConstraints,
  buildStopAndEscalation,
  stepIdFor,
  successConditionOf,
  type BranchContext,
  type StepRole,
} from './content-builders';
import type { CaseInfo } from './evidence';
import {
  cheaperAlternativesOf,
  forkRefusals,
  HINDSIGHT_NOTICE,
  knownFailureModesOf,
  scenarioRefusals,
  skillNameOf,
} from './extraction-parts';
import { deriveLadder, deriveTriggers, exclusionSignalIds, familyOf } from './ladder';
import { replaySkillPath, type SkillReplayResult } from './replay';
import { knowledgeStateFromView } from './state';
import { templatesOfAction } from './templates';
import { clip, pct, slugify } from './util';

export interface SkillExtractionInput {
  /** The full, post-hoc analysis: used for the failure modes the source case showed. */
  analysis: DeterministicAnalysis;
  fork: DecisionFork;
  /** Scenarios generated for the fork (typically one per strategy); each is considered separately. */
  scenarios: readonly CounterfactualScenario[];
  events: readonly CaseEvent[];
  resolution: CaseResolution | null;
  pack: CompiledPack;
  config: ActionValueConfig;
  ctx: EngineContext;
  caseInfo: CaseInfo;
  caseReference: string;
  synthetic: boolean;
  options?: {
    /** Defaults to true: only scenarios a reviewer accepted (or corrected) may seed a skill. */
    requireAcceptedReview?: boolean;
    rolloutCount?: number;
  };
}

export interface SkillDraft {
  skill: SkillDna;
  version: SkillVersion;
  provenance: SkillProvenance;
  /** Scenarios that produced exactly this content (strategies often converge on one path). */
  sourceScenarioIds: string[];
  /** The replay used for the estimated benefit; recorded so reviewers can inspect it. */
  replay: SkillReplayResult;
}

export interface ExtractionRefusal {
  scenarioId: string | null;
  reasons: string[];
}

export interface SkillExtractionResult {
  candidates: SkillDraft[];
  refusals: ExtractionRefusal[];
}

const DEFAULT_ROLLOUTS = 100;

interface BuiltDraft {
  draft: SkillDraft;
}

function buildDraft(
  input: SkillExtractionInput,
  scenario: CounterfactualScenario,
): BuiltDraft | { refused: string[] } {
  const { analysis, fork, events, resolution, pack, config, ctx, caseInfo } = input;
  const truth = resolutionHypothesisKey(resolution, pack);
  if (!resolution || !truth) {
    return {
      refused: [
        'The case has no recorded resolution that maps to a knowledge-pack cause: skills are only distilled from resolved cases.',
      ],
    };
  }
  if (resolution.validation?.outcome !== 'confirmed') {
    return { refused: ['The resolution of the source case was not validated as confirmed.'] };
  }
  const preView = createTemporalViewBeforeEvent(events, fork.eventId);
  const { state: state0 } = knowledgeStateFromView(preView, pack, ctx.caseId);
  const hindsight = simulateAlternativePath({
    preView,
    fork,
    strategy: scenario.strategy,
    pack,
    config,
    ctx,
    rolloutCount: input.options?.rolloutCount ?? DEFAULT_ROLLOUTS,
    conditionOnHypothesis: truth,
  });
  if (!hindsight.reachedDiagnosis || hindsight.steps.length === 0) {
    return {
      refused: [
        'The hindsight-conditioned path does not reach a confirmed diagnosis, so there is no validated reasoning to distil.',
      ],
    };
  }

  const path = hindsight.steps.map((s) => s.action);
  const family = familyOf(pack, truth);
  const exclusionIds = exclusionSignalIds(pack, family);
  const exclusionSet = new Set(exclusionIds);
  const ladder = deriveLadder({
    pack,
    config,
    state0,
    path,
    family,
    exclusionSignals: exclusionSet,
  });
  const firstStepSignals = new Set(path[0]?.outcomes.flatMap((o) => o.emitsSignals) ?? []);
  const triggers = deriveTriggers({
    pack,
    family,
    truth,
    observedAtDecision: state0.observedSignals,
    firstStepSignals,
  });
  if (triggers.length === 0) {
    return {
      refused: [
        'No observable symptom pattern was on record at the decision time, so there is nothing to trigger the skill on.',
      ],
    };
  }

  const terminalKey = [...path].reverse().find((a) => a.valueClass !== 'enabling')?.id ?? null;
  const guardKeys = new Set(ladder.guards.map((a) => a.id));
  const roleOf = (a: KnowledgeAction): StepRole =>
    a.id === terminalKey ? 'terminal' : guardKeys.has(a.id) ? 'guard' : 'enabling';
  const branchCtx: BranchContext = {
    pack,
    belief0: state0.belief,
    truth,
    exclusionSignals: exclusionSet,
  };
  const decisionSequence = ladder.ordered.map((action, i) => {
    const next = ladder.ordered[i + 1];
    return buildDecisionStep({
      action,
      order: i + 1,
      nextStepId: next ? stepIdFor(i + 2, next.id) : null,
      role: roleOf(action),
      ctx: branchCtx,
    });
  });

  const signalOf = (id: string) => {
    const signal = pack.signals.get(id);
    if (!signal) throw new Error(`Unknown signal ${id}`);
    return signal;
  };
  const triggerConditions = triggers.map((t) => {
    const condition = buildCondition(signalOf(t.signalId), 'trg', t.weight, t.required);
    return t.origin === 'hindsight'
      ? { ...condition, description: clip(`${condition.description} (hindsight-informed)`, 400) }
      : condition;
  });
  const exclusions = exclusionIds.map((id) => buildCondition(signalOf(id), 'exc', 1, false));
  const requirementLabel = (id: string): string => pack.requirements.get(id)?.label ?? id;
  const terminalAction = ladder.ordered.find((a) => a.id === terminalKey);
  const terminalStage = ladder.ordered.findIndex((a) => a.id === terminalKey) + 1;
  const candidateActions = [
    ...ladder.ordered.map((action, i) =>
      buildCandidateAction(
        action,
        roleOf(action) === 'terminal'
          ? `Stage ${i + 1}: the check the source case validated (${input.caseReference}).`
          : roleOf(action) === 'guard'
            ? `Stage ${i + 1}: cheap, read-only check that can rule out a reason this skill would not apply.`
            : `Stage ${i + 1}: collect the minimum data first at low customer effort.`,
      ),
    ),
    ...ladder.alternatives.map((action) =>
      buildCandidateAction(
        action,
        `Alternative at stage ${terminalStage}: answers the same question (${(terminalAction?.produces ?? []).map(requirementLabel).join('; ')}). Not yet validated by a source case; prefer it when the evidence points at ${action.targets.map((t) => pack.hypotheses.get(t)?.name ?? t).join(' or ')}.`,
      ),
    ),
  ];
  const { stopConditions, escalationConditions } = buildStopAndEscalation(pack, exclusionIds);
  const successConditions = terminalAction
    ? [successConditionOf(pack, terminalAction, truth)].filter((s): s is string => s !== null)
    : [];
  const queryTemplates = ladder.ordered.flatMap(templatesOfAction);
  const minimumEvidence = buildMinimumEvidence(pack);
  const reached = hindsight.rollouts.diagnosisReachedShare;
  const confidenceScore = round(
    Math.min(0.35 + 0.25 * reached + 0.15 * scenario.comparisonConfidence.score, 0.6),
    2,
  );
  const truthName = pack.hypotheses.get(truth)?.name ?? truth;
  const name = skillNameOf(pack, truth, ladder.ordered);

  const baseContent: SkillContent = {
    name,
    description: clip(
      `Distilled from ${input.caseReference}${input.synthetic ? ' (synthetic)' : ''}. Collect the minimum scoping data, rule out cheap global causes, prove whether the failing attempts reached the identity service, then isolate the failing hop. ${ladder.ordered.map((a, i) => `${i + 1}. ${a.label}.`).join(' ')} In the source case the cause was “${truthName}”. All probabilities and savings are estimates.`,
      1200,
    ),
    product: caseInfo.product,
    workload: pack.pack.workload,
    triggerConditions,
    exclusions,
    requiredInputs: buildRequiredInputs(pack, ladder.ordered),
    minimumEvidence,
    decisionSequence,
    candidateActions,
    stopConditions,
    successConditions,
    escalationConditions,
    safetyConstraints: buildSafetyConstraints([...ladder.ordered, ...ladder.alternatives]),
    queryTemplates,
    knownFailureModes: knownFailureModesOf(analysis, pack),
    sourceCases: [
      {
        caseId: ctx.caseId,
        reference: clip(
          `${input.caseReference} · fork ${fork.id} · scenario ${scenario.id} · run ${ctx.runId}`,
          200,
        ),
        role: 'origin',
      },
    ],
    confidence: {
      score: confidenceScore,
      rationale: clip(
        `Model estimate, not a measurement: ${pct(reached)} of ${hindsight.rollouts.count} hindsight-conditioned rollouts reach a confirmed diagnosis; decision-time scenario confidence ${pct(scenario.comparisonConfidence.score)}. Capped at 60% because one source case supports it.`,
        500,
      ),
    },
    cheaperAlternatives: cheaperAlternativesOf(fork, pack),
    validationCriteria: [
      'Replaying the skill on its source case at the decision point reaches a confirmed diagnosis sooner than the recorded path.',
      'The replay needs no more estimated customer effort than the recorded path.',
      'No recommended step is destructive, approval-required or blocked by the safety policy.',
      'The skill does not match cases that hit one of its exclusions.',
      'On a related case it either reaches the same diagnosis or stops at a declared stop condition; it never reports a false diagnosis.',
    ],
    applicability: {
      scope: clip(
        `${caseInfo.product} (${pack.pack.workload}): ${triggerConditions
          .filter((c) => c.required)
          .map((c) => c.description.toLowerCase())
          .join(' and ')}, where the failing attempts may never reach the identity service.`,
        600,
      ),
      validatedOnCases: 1,
      limitations: [
        `Distilled from one ${input.synthetic ? 'synthetic ' : ''}source case; it has not been validated on other cases.`,
        'Same-question alternatives listed as candidate actions are knowledge-pack suggestions, not validated by a source case.',
        'Probabilities, time and effort figures are model estimates.',
      ],
    },
  };

  const replay = replaySkillPath({
    content: baseContent,
    pack,
    config,
    state0,
    truthHypothesis: truth,
    minimumEvidence: minimumEvidence.map((m) => m.requirementId),
  });
  const actual = scenario.actualMetrics;
  const saved = (actualValue: number, low: number, mid: number, high: number) => ({
    low: round(actualValue - high, 1),
    mid: round(actualValue - mid, 1),
    high: round(actualValue - low, 1),
  });
  const content: SkillContent = {
    ...baseContent,
    expectedBenefit: {
      estimated: true,
      simulated: true,
      basis: clip(
        `Replay of this skill at the source decision point with step outcomes taken from the recorded cause (hindsight), compared with the recorded path of ${input.caseReference}.`,
        400,
      ),
      timeSavedMinutes: saved(
        actual.timeToDiagnosisMinutes.mid,
        replay.metrics.timeToDiagnosisMinutes.low,
        replay.metrics.timeToDiagnosisMinutes.mid,
        replay.metrics.timeToDiagnosisMinutes.high,
      ),
      customerEffortSavedMinutes: saved(
        actual.customerEffortMinutes.mid,
        replay.metrics.customerEffortMinutes,
        replay.metrics.customerEffortMinutes,
        replay.metrics.customerEffortMinutes,
      ),
      tokensSaved: saved(
        actual.tokenEstimate.mid,
        replay.metrics.tokenEstimate,
        replay.metrics.tokenEstimate,
        replay.metrics.tokenEstimate,
      ),
      caveats: [
        'Estimated, not measured: nothing was executed.',
        'Step outcomes come from the recorded cause; a different cause changes the path.',
        `Based on one ${input.synthetic ? 'synthetic ' : ''}case.`,
      ],
    },
  };

  const hindsightParts = [
    ...triggers
      .filter((t) => t.origin === 'hindsight')
      .map((t) => `triggerConditions.${buildCondition(signalOf(t.signalId), 'trg', 0, false).id}`),
    'exclusions',
    'decisionSequence.*.branches.hindsightProbability',
    `decisionSequence.${terminalKey ? stepIdFor(terminalStage, terminalKey) : 'terminal'}.branches.next`,
    'successConditions',
    'knownFailureModes',
    'expectedBenefit',
    'confidence',
  ];
  const decisionTimeParts = [
    ...triggers
      .filter((t) => t.origin === 'decision_time')
      .map((t) => `triggerConditions.${buildCondition(signalOf(t.signalId), 'trg', 0, false).id}`),
    'requiredInputs',
    'minimumEvidence',
    'decisionSequence.*.branches.probability',
    'queryTemplates',
    'candidateActions',
    'cheaperAlternatives',
    'stopConditions',
    'escalationConditions',
    'safetyConstraints',
  ];
  const provenance: SkillProvenance = {
    caseId: ctx.caseId,
    caseReference: input.caseReference,
    forkId: fork.id,
    scenarioId: scenario.id,
    analysisRunId: ctx.runId,
    strategy: scenario.strategy,
    extractedAt: ctx.now,
    hindsight: {
      used: true,
      resolutionHypothesisKey: truth,
      parts: hindsightParts,
      notice: HINDSIGHT_NOTICE,
    },
    decisionTimeParts,
    labels: { simulated: true, estimated: true, synthetic: input.synthetic },
  };
  const finalContent: SkillContent = { ...content, provenance };
  const contentHash = hashJson(finalContent);
  const skillId = stableId('skl', ctx.caseId, scenario.id);
  const versionId = stableId('skv', skillId, 1);
  const meta = {
    tenantId: ctx.tenantId,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    createdBy: ctx.createdBy,
    version: 1,
  };
  const version: SkillVersion = {
    ...meta,
    id: versionId,
    skillId,
    version: '1.0.0',
    sequence: 1,
    parentVersionId: null,
    changeType: 'initial',
    changeSummary: clip(
      `Extracted from ${input.caseReference} (fork ${fork.id}). Starts as Discovered: every lifecycle gate still needs a human.`,
      600,
    ),
    state: 'active',
    lifecycleAtCreation: 'discovered',
    content: finalContent,
    contentHash,
  };
  const skill: SkillDna = {
    ...meta,
    id: skillId,
    key: `${slugify(name).slice(0, 48).replace(/-+$/, '')}-${contentHash.slice(0, 6)}`,
    name,
    description: finalContent.description,
    workload: finalContent.workload,
    product: finalContent.product,
    lifecycle: 'discovered',
    currentVersionId: versionId,
    currentVersion: '1.0.0',
    owner: ctx.createdBy,
    reviewer: null,
    validationStatus: 'unvalidated',
    lastValidatedAt: null,
    confidence: confidenceScore,
    sourceCaseIds: [ctx.caseId],
    effectiveness: {
      applications: 0,
      matchedCases: 0,
      avgTimeToDiagnosisMinutes: null,
      baselineAvgTimeToDiagnosisMinutes: null,
      conformanceAvg: null,
      estimatedTokenSavingsPct: null,
      notes: ['No applications recorded yet.'],
      synthetic: input.synthetic,
      estimated: true,
    },
    hasProposedMutation: false,
    synthetic: input.synthetic,
  };
  return {
    draft: { skill, version, provenance, sourceScenarioIds: [scenario.id], replay },
  };
}

/**
 * Distils draft skills from an eligible decision fork and valid, leak-free scenarios of a resolved
 * case. Every refusal is reported with its reasons; nothing is ever extracted from a rejected or
 * invalid scenario, an ineligible fork or a case without a validated resolution. Candidates start as
 * `discovered`: no gate is passed on the author's behalf.
 */
export function extractSkillCandidates(input: SkillExtractionInput): SkillExtractionResult {
  const requireAccepted = input.options?.requireAcceptedReview ?? true;
  const forkReasons = forkRefusals(input.fork, input.ctx);
  const refusals: ExtractionRefusal[] = [];
  const candidates: SkillDraft[] = [];
  if (input.scenarios.length === 0) {
    refusals.push({ scenarioId: null, reasons: [...forkReasons, 'No scenario was provided.'] });
  }
  for (const scenario of input.scenarios) {
    const reasons = [...forkReasons, ...scenarioRefusals(scenario, input.fork, requireAccepted)];
    if (reasons.length > 0) {
      refusals.push({ scenarioId: scenario.id, reasons });
      continue;
    }
    const built = buildDraft(input, scenario);
    if ('refused' in built) {
      refusals.push({ scenarioId: scenario.id, reasons: built.refused });
      continue;
    }
    const twin = candidates.find((c) => sameContent(c.version, built.draft.version));
    if (twin) twin.sourceScenarioIds.push(scenario.id);
    else candidates.push(built.draft);
  }
  return { candidates, refusals };
}

/** Strategies often converge on one path: contents equal up to provenance are the same candidate. */
function sameContent(a: SkillVersion, b: SkillVersion): boolean {
  const strip = (v: SkillVersion): string =>
    hashJson({ ...v.content, provenance: undefined, sourceCases: undefined });
  return strip(a) === strip(b);
}
