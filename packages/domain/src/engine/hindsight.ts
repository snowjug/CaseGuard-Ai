import {
  DEFAULT_EFFORT_MINUTES,
  type CaseResolution,
  type CounterfactualScenario,
  type DecisionFork,
  type DiagnosticAction,
  type HindsightCheck,
  type PathMetrics,
} from '@caseguard/schemas';
import type { CompiledPack } from '../knowledge/compile';
import { constantRange, round } from '../util/math';
import { formatDuration, minutesBetween } from '../util/time';
import type { DecisionRanking } from './actions';
import { type BeliefTimeline, topHypotheses } from './belief';
import { statedHypothesis } from './claims';
import type { EngineContext } from './context';
import { USEFUL_EVIDENCE_BITS, type SimulationResult } from './counterfactual';
import { satisfiedSetAt, type RequirementState } from './requirements';
import type { TemporalView } from './temporal';

export const HINDSIGHT_NOTICE =
  'Post-hoc evaluation. It uses the final resolution, which was never available when the counterfactual was generated, and it does not influence generation.';

export interface ActualPathInput {
  fork: DecisionFork;
  /** The FULL, post-hoc view. Used only to measure what really happened. */
  view: TemporalView;
  pack: CompiledPack;
  timeline: BeliefTimeline;
  requirementStates: readonly RequirementState[];
  actions: readonly DiagnosticAction[];
  decisions: ReadonlyMap<string, DecisionRanking>;
}

export interface ActualPath {
  metrics: PathMetrics;
  reachedDiagnosis: boolean;
  diagnosisEventId: string | null;
  diagnosisAt: string | null;
  diagnosisHypothesisKey: string | null;
  actionIds: string[];
}

/** Index of the first event, at or after `fromIndex`, at which the case was actually diagnosed. */
export function findDiagnosisIndex(
  pack: CompiledPack,
  timeline: BeliefTimeline,
  requirementStates: readonly RequirementState[],
  fromIndex: number,
): { index: number; key: string } | null {
  for (let i = Math.max(0, fromIndex); i < timeline.steps.length; i++) {
    const step = timeline.steps[i];
    const top = step ? topHypotheses(step.posterior, 1)[0] : undefined;
    if (!step || !top || top.id === 'hyp.other') continue;
    if (top.p < pack.pack.policies.diagnosisThreshold) continue;
    const satisfied = satisfiedSetAt(requirementStates, i);
    const required = pack.hypotheses.get(top.id)?.confirmationRequirementIds ?? [];
    if (required.every((r) => satisfied.has(r))) return { index: i, key: top.id };
  }
  return null;
}

/** Measures the real path from the decision instant to the real diagnosis (post-hoc). */
export function computeActualPath(input: ActualPathInput): ActualPath {
  const { fork, view, pack, timeline, requirementStates, actions, decisions } = input;
  const events = view.events;
  const forkIndex = events.findIndex((e) => e.id === fork.eventId);
  const diagnosis = findDiagnosisIndex(pack, timeline, requirementStates, forkIndex);
  const lastIndex = events.length - 1;
  const endIndex = diagnosis?.index ?? lastIndex;
  const start = events[forkIndex]?.timestamp ?? fork.timestamp;
  const end = events[endIndex]?.timestamp ?? start;
  const minutesToDiagnosis = Math.max(0, minutesBetween(start, end));

  const windowActions = actions.filter((a) => a.sequence >= forkIndex && a.sequence <= endIndex);
  const usefulStep = timeline.steps.find(
    (s) =>
      s.eventIndex >= forkIndex && s.eventIndex <= endIndex && s.gainBits >= USEFUL_EVIDENCE_BITS,
  );
  const minutesToUseful = usefulStep
    ? Math.max(0, minutesBetween(start, usefulStep.at))
    : minutesToDiagnosis;

  const tokenOf = (a: DiagnosticAction): number =>
    a.tokenEstimate > 0
      ? a.tokenEstimate
      : a.actionKey
        ? (pack.actions.get(a.actionKey)?.tokenEstimate ?? 0)
        : 0;
  const unsupported = windowActions.filter((a) => {
    const key = a.actionKey;
    const decision = decisions.get(a.eventId);
    const packAction = key ? pack.actions.get(key) : undefined;
    if (!decision || !packAction || packAction.targets.length === 0) return false;
    const mass = Math.max(...packAction.targets.map((t) => decision.analysis.belief[t] ?? 0));
    return mass < 0.1;
  }).length;
  const gain = timeline.steps
    .filter((s) => s.eventIndex >= forkIndex && s.eventIndex <= endIndex)
    .reduce((sum, s) => sum + s.gainBits, 0);

  const metrics: PathMetrics = {
    actionCount: constantRange(windowActions.length),
    customerInteractions: constantRange(
      windowActions.filter((a) => a.customerEffort !== 'none').length,
    ),
    timeToUsefulEvidenceMinutes: constantRange(round(minutesToUseful, 1)),
    timeToDiagnosisMinutes: constantRange(round(minutesToDiagnosis, 1)),
    diagnosticVolume: constantRange(
      round(
        windowActions.reduce((s, a) => s + a.computeUnits, 0),
        2,
      ),
    ),
    tokenEstimate: constantRange(windowActions.reduce((s, a) => s + tokenOf(a), 0)),
    customerEffortMinutes: constantRange(
      windowActions.reduce((s, a) => s + DEFAULT_EFFORT_MINUTES[a.customerEffort], 0),
    ),
    operationalRisk: round(
      windowActions.length === 0 ? 0 : Math.max(...windowActions.map((a) => a.operationalRisk)),
      3,
    ),
    informationGainBits: constantRange(round(gain, 3)),
    unsupportedBranches: unsupported,
  };
  return {
    metrics,
    reachedDiagnosis: diagnosis !== null,
    diagnosisEventId: diagnosis ? (events[diagnosis.index]?.id ?? null) : null,
    diagnosisAt: diagnosis ? (events[diagnosis.index]?.timestamp ?? null) : null,
    diagnosisHypothesisKey: diagnosis?.key ?? null,
    actionIds: windowActions.map((a) => a.id),
  };
}

/** Hypothesis key the recorded resolution points to (explicit key first, then keyword match). */
export function resolutionHypothesisKey(
  resolution: CaseResolution | null,
  pack: CompiledPack,
): string | null {
  if (!resolution) return null;
  if (resolution.rootCauseHypothesisKey && pack.hypotheses.has(resolution.rootCauseHypothesisKey)) {
    return resolution.rootCauseHypothesisKey;
  }
  const match = statedHypothesis(`${resolution.rootCause} ${resolution.summary}`, pack);
  return match && match !== 'hyp.other' ? match : null;
}

export function hindsightCheck(
  scenario: CounterfactualScenario,
  actual: ActualPath,
  resolution: CaseResolution | null,
  pack: CompiledPack,
  ctx: EngineContext,
  conditioned: SimulationResult | null,
): HindsightCheck {
  const resolutionKey = resolutionHypothesisKey(resolution, pack);
  const hypName = (key: string): string => pack.hypotheses.get(key)?.name ?? key;
  const actualTime = actual.metrics.timeToDiagnosisMinutes.mid;
  const cfTime = scenario.counterfactualMetrics.timeToDiagnosisMinutes;
  let leading: HindsightCheck['leadingHypothesisAtEndOfPath'] = null;
  let consistent: boolean | null = null;
  let simulated = cfTime;
  let explanation: string;

  if (!resolution) {
    explanation =
      'The case has no recorded resolution, so the simulated strategy cannot be compared with a known root cause.';
  } else if (!resolutionKey || !conditioned) {
    explanation =
      'The recorded resolution could not be mapped to a knowledge-pack hypothesis, so consistency was not assessed.';
  } else {
    const ranked = topHypotheses(conditioned.rollouts.meanFinalBelief, 1)[0];
    leading = ranked
      ? { key: ranked.id, name: hypName(ranked.id), confidence: round(ranked.p, 3) }
      : null;
    const correctShare = conditioned.rollouts.finalLeaderShare[resolutionKey] ?? 0;
    consistent = correctShare >= 0.5 && leading?.key === resolutionKey;
    simulated = conditioned.rollouts.metrics.timeToDiagnosisMinutes;
    explanation = consistent
      ? `Given the recorded root cause (“${hypName(resolutionKey)}”), this strategy, which did not know it, would have ended with that cause leading in ${Math.round(correctShare * 100)}% of ${conditioned.rollouts.count} rollouts and reached a confirmed diagnosis in ${Math.round(conditioned.rollouts.diagnosisReachedShare * 100)}%, in about ${formatDuration(simulated.mid)} (${formatDuration(simulated.low)}–${formatDuration(simulated.high)}). The real case took ${formatDuration(actualTime)}.`
      : `Given the recorded root cause (“${hypName(resolutionKey)}”), this strategy would have had it leading in only ${Math.round(correctShare * 100)}% of ${conditioned.rollouts.count} rollouts. Treat this counterfactual as unreliable for this case.`;
  }
  return {
    scenarioId: scenario.id,
    caseId: ctx.caseId,
    computedAt: ctx.now,
    usedFinalResolution: true,
    notice: HINDSIGHT_NOTICE,
    resolutionHypothesisKey: resolutionKey,
    leadingHypothesisAtEndOfPath: leading,
    consistentWithResolution: consistent,
    simulatedTimeToDiagnosisMinutes: simulated,
    actualTimeToDiagnosisMinutes: actual.reachedDiagnosis ? actualTime : null,
    explanation,
  };
}
