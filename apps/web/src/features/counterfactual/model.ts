import type {
  CounterfactualScenario,
  CounterfactualStep,
  DecisionFork,
  DiagnosticAction,
  HypothesesResponse,
  PathMetrics,
  Range,
} from '@caseguard/schemas';
import {
  formatDuration,
  formatNumber,
  formatProbability,
  type BadgeStatus,
  type PathMetricDelta,
  type PathStep,
  type PathTrack,
} from '@caseguard/ui';
import { minutesBetween } from '../reasoning/time';

/** Pure view-model helpers for the Counterfactual Lab (no React, no fetching), so they can be unit-tested. */

/** Relative value (0-1) at which a recorded step counts as well chosen: the line the graph builder uses as well. */
export const WELL_CHOSEN_RELATIVE_VALUE = 0.6;

const DEFAULT_STRATEGY_ORDER = ['balanced', 'lowest_customer_effort', 'fastest_diagnosis'] as const;

/** Scenarios of one fork, in the canonical strategy order. */
export function scenariosOfFork(
  scenarios: readonly CounterfactualScenario[],
  forkId: string,
): CounterfactualScenario[] {
  const order = (strategy: string): number => {
    const index = (DEFAULT_STRATEGY_ORDER as readonly string[]).indexOf(strategy);
    return index === -1 ? DEFAULT_STRATEGY_ORDER.length : index;
  };
  return scenarios
    .filter((scenario) => scenario.forkId === forkId)
    .sort((a, b) => order(a.strategy) - order(b.strategy));
}

export interface LabSelection {
  fork: DecisionFork | null;
  scenario: CounterfactualScenario | null;
}

/**
 * Resolves `?sel=` (a fork id or a scenario id; deep links use both) into the fork and scenario to show. Without a valid
 * selection the earliest meaningful fork is shown, then the first fork; a fork shows its first (balanced) scenario.
 */
export function resolveSelection(
  forks: readonly DecisionFork[],
  scenarios: readonly CounterfactualScenario[],
  earliestId: string | null,
  selection: string | null,
): LabSelection {
  const byScenario = selection ? scenarios.find((s) => s.id === selection) : undefined;
  const fork =
    (byScenario ? forks.find((f) => f.id === byScenario.forkId) : undefined) ??
    forks.find((f) => f.id === selection) ??
    forks.find((f) => f.id === earliestId) ??
    forks[0] ??
    null;
  if (!fork) return { fork: null, scenario: null };
  const mine = scenariosOfFork(scenarios, fork.id);
  const scenario = (byScenario && byScenario.forkId === fork.id ? byScenario : mine[0]) ?? null;
  return { fork, scenario };
}

/** True when every scenario of a fork takes the same steps in the same order (strategies may converge). */
export function strategiesConverge(scenarios: readonly CounterfactualScenario[]): boolean {
  if (scenarios.length < 2) return false;
  const signature = (s: CounterfactualScenario): string =>
    s.steps.map((st) => st.actionKey).join('>');
  const first = scenarios[0] ? signature(scenarios[0]) : '';
  return scenarios.every((s) => signature(s) === first);
}

/**
 * Why a scenario cannot be accepted. Mirrors the API's own rule (a path the engine rejected, or one that failed a
 * validity or leak check, can be rejected by a reviewer but never accepted); the API stays the authority.
 */
export function acceptanceBlockers(scenario: CounterfactualScenario): string[] {
  const blockers: string[] = [];
  if (scenario.status !== 'completed')
    blockers.push(`The engine marked the path ${scenario.status}.`);
  const failed = scenario.validity.checks.filter((check) => !check.passed).map((check) => check.id);
  if (!scenario.validity.valid || failed.length > 0) {
    blockers.push(
      `It failed validity checks${failed.length > 0 ? ` (${failed.join(', ')})` : ''}.`,
    );
  }
  const leak = scenario.boundary.leakCheck;
  if (!leak.passed || leak.futureReferencesFound > 0 || !leak.resolutionExcluded) {
    blockers.push('It did not pass the no-hindsight check.');
  }
  return blockers;
}

/** Events the boundary withheld: everything after the decision instant. `null` when the case size is unknown. */
export function withheldAfterBoundary(
  scenario: Pick<CounterfactualScenario, 'boundary'>,
  caseEventCount: number | null,
): number | null {
  return caseEventCount === null
    ? null
    : Math.max(0, caseEventCount - scenario.boundary.eventCount);
}

export interface EvidenceBearing {
  hypothesisName: string;
  polarity: 'supports' | 'contradicts';
}

/**
 * Which hypotheses each piece of evidence bears on, from the decision-time hypotheses response (links and names), so the
 * evidence inspector can say "supports X, contradicts Y" without a second request.
 */
export function bearingsOf(
  data: Pick<HypothesesResponse, 'items' | 'links'> | undefined,
): Map<string, EvidenceBearing[]> {
  const result = new Map<string, EvidenceBearing[]>();
  if (!data) return result;
  const names = new Map(data.items.map((h) => [h.id, h.name]));
  for (const link of data.links) {
    if (link.polarity === 'neutral') continue;
    const name = names.get(link.hypothesisId);
    if (!name) continue;
    const list = result.get(link.evidenceId) ?? [];
    list.push({ hypothesisName: name, polarity: link.polarity });
    result.set(link.evidenceId, list);
  }
  return result;
}

// ------------------------------------------------------------------ path tracks for PathComparison

function actionStatus(action: DiagnosticAction): BadgeStatus {
  if (action.lowValue || action.isRepeat || action.destructive) return 'unsupported';
  return (action.relativeValueAtDecision ?? 0) >= WELL_CHOSEN_RELATIVE_VALUE
    ? 'productive'
    : 'uncertain';
}

function stepStatus(step: CounterfactualStep): BadgeStatus {
  if (!step.supported || !step.safe) return 'unsupported';
  return step.uncertainty === 'high' ? 'uncertain' : 'productive';
}

export interface ComparisonTracks {
  actual: PathTrack;
  counterfactual: PathTrack;
  forkStepId: string;
  /** Recorded actions that fall between the decision and the diagnosis, compared with the API's own count. */
  recordedActionCount: number;
}

/**
 * The two tracks of `PathComparison`, both measured from the decision instant like the API's metrics. The recorded track
 * is the decision itself followed by the actions taken until the diagnosis; the simulated track is the generated steps.
 * Each track ends with a "diagnosis reached" marker so the segments add up to the API's time-to-diagnosis figure.
 */
export function comparisonTracks(
  fork: DecisionFork,
  scenario: CounterfactualScenario,
  actions: readonly DiagnosticAction[],
): ComparisonTracks {
  const decisionAt = fork.timestamp;
  const actualDiagnosis = scenario.actualMetrics.timeToDiagnosisMinutes.mid;
  const recorded = actions
    .filter((action) => action.eventId !== fork.eventId)
    .filter((action) => {
      const offset = minutesBetween(decisionAt, action.startedAt);
      return offset > 0 && offset <= actualDiagnosis;
    })
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || a.sequence - b.sequence);

  const forkStep: PathStep = {
    id: fork.id,
    label: fork.actual.label,
    kind: 'fork',
    durationMinutes: 0,
    detail: 'The step taken at the decision moment',
  };
  const actualSteps: PathStep[] = [forkStep];
  let previousAt = decisionAt;
  let lastOffset = 0;
  for (const action of recorded) {
    const offset = minutesBetween(decisionAt, action.startedAt);
    actualSteps.push({
      id: action.id,
      label: action.label,
      kind: 'action',
      status: actionStatus(action),
      durationMinutes: minutesBetween(previousAt, action.startedAt),
      detail: action.lowValueReasons[0] ?? undefined,
    });
    previousAt = action.startedAt;
    lastOffset = offset;
  }
  if (actualDiagnosis > lastOffset) {
    actualSteps.push({
      id: `${fork.id}:actual-diagnosis`,
      label: 'Diagnosis reached',
      kind: 'outcome',
      durationMinutes: actualDiagnosis - lastOffset,
    });
  }

  const simDiagnosis = scenario.counterfactualMetrics.timeToDiagnosisMinutes.mid;
  const simSteps: PathStep[] = [];
  let previousOffset = 0;
  for (const step of scenario.steps) {
    const offset = step.offsetMinutes.mid;
    simSteps.push({
      id: step.id,
      label: step.label,
      kind: 'action',
      status: stepStatus(step),
      durationMinutes: Math.max(0, offset - previousOffset),
      detail: step.predictedOutcome.label,
    });
    previousOffset = offset;
  }
  if (simDiagnosis > previousOffset) {
    simSteps.push({
      id: `${scenario.id}:sim-diagnosis`,
      label: 'Diagnosis reached (simulated)',
      kind: 'outcome',
      durationMinutes: simDiagnosis - previousOffset,
    });
  }

  return {
    actual: { label: 'Actual path', steps: actualSteps, totalMinutes: actualDiagnosis },
    counterfactual: { label: 'Simulated path', steps: simSteps, totalMinutes: simDiagnosis },
    forkStepId: fork.id,
    recordedActionCount: recorded.length + 1,
  };
}

const count = (n: number): string => formatNumber(n, { maximumFractionDigits: 0 });
const decimal = (n: number): string => formatNumber(n, { maximumFractionDigits: 2 });

interface MetricSpec {
  key: keyof PathMetrics;
  label: string;
  better: 'lower' | 'higher';
  format: (value: number) => string;
  /** `range` metrics carry low/mid/high; the others are single numbers. */
  range: boolean;
}

export const METRIC_SPECS: readonly MetricSpec[] = [
  {
    key: 'actionCount',
    label: 'Troubleshooting actions',
    better: 'lower',
    format: count,
    range: true,
  },
  {
    key: 'customerInteractions',
    label: 'Customer interactions',
    better: 'lower',
    format: count,
    range: true,
  },
  {
    key: 'timeToUsefulEvidenceMinutes',
    label: 'Time to useful evidence',
    better: 'lower',
    format: formatDuration,
    range: true,
  },
  {
    key: 'timeToDiagnosisMinutes',
    label: 'Time to diagnosis',
    better: 'lower',
    format: formatDuration,
    range: true,
  },
  {
    key: 'diagnosticVolume',
    label: 'Diagnostic volume',
    better: 'lower',
    format: count,
    range: true,
  },
  { key: 'tokenEstimate', label: 'Estimated tokens', better: 'lower', format: count, range: true },
  {
    key: 'customerEffortMinutes',
    label: 'Customer effort',
    better: 'lower',
    format: formatDuration,
    range: true,
  },
  {
    key: 'operationalRisk',
    label: 'Operational risk (0 to 1)',
    better: 'lower',
    format: decimal,
    range: false,
  },
  {
    key: 'informationGainBits',
    label: 'Information gained (bits)',
    better: 'higher',
    format: decimal,
    range: true,
  },
  {
    key: 'unsupportedBranches',
    label: 'Unsupported branches',
    better: 'lower',
    format: count,
    range: false,
  },
];

type Triple = { low: number; mid: number; high: number };
const isTriple = (value: unknown): value is Triple =>
  typeof value === 'object' && value !== null && 'mid' in value;

/** One actual-versus-simulated delta per metric the specification asks to compare. */
export function metricDeltas(scenario: CounterfactualScenario): PathMetricDelta[] {
  return METRIC_SPECS.map((spec) => {
    const actual = scenario.actualMetrics[spec.key];
    const simulated = scenario.counterfactualMetrics[spec.key];
    const actualValue = isTriple(actual) ? actual.mid : actual;
    const simulatedValue = isTriple(simulated) ? simulated.mid : simulated;
    return {
      key: spec.key,
      label: spec.label,
      actual: actualValue,
      counterfactual: simulatedValue,
      low: isTriple(simulated) && spec.range ? simulated.low : null,
      high: isTriple(simulated) && spec.range ? simulated.high : null,
      better: spec.better,
      format: spec.format,
    };
  });
}

export interface ImprovementLine {
  key: string;
  label: string;
  /** Signed fraction of the actual value; positive means the simulation is better. */
  fraction: number;
}

const HEADLINE_KEYS: readonly { key: string; label: string }[] = [
  { key: 'timeToDiagnosisMinutesPct', label: 'time to diagnosis' },
  { key: 'customerEffortMinutesPct', label: 'customer effort' },
  { key: 'tokenEstimatePct', label: 'estimated tokens' },
  { key: 'operationalRiskPct', label: 'operational risk' },
];

/** The headline improvements the API computed (fractions of the actual value), only those it provides. */
export function headlineImprovements(scenario: CounterfactualScenario): ImprovementLine[] {
  return HEADLINE_KEYS.flatMap(({ key, label }) => {
    const value = scenario.improvements[key];
    return typeof value === 'number' && Number.isFinite(value)
      ? [{ key, label, fraction: value }]
      : [];
  });
}

/** `0.852` becomes "85% less" or "21% more"; used only for the estimated improvement summary. */
export function describeImprovement(line: ImprovementLine): string {
  const share = formatProbability(Math.abs(line.fraction));
  return line.fraction >= 0 ? `${share} less ${line.label}` : `${share} more ${line.label}`;
}

export type TimeSavedVerdict = 'faster' | 'slower' | 'unclear';

export interface TimeSaved {
  /**
   * `faster` only when even the pessimistic end of the simulated range is below what happened (and `slower` when even the
   * optimistic end is above it): a range that includes the recorded time says nothing either way, and is never presented
   * as a saving.
   */
  verdict: TimeSavedVerdict;
  /** Minutes from the decision to a diagnosis in the recorded case. */
  recorded: number;
  /** The same for the simulated path, as a range. */
  simulated: Range;
  /** The saving in minutes, as a range, positive when the simulation is faster. */
  saved: Range;
  /** False when the engine says no saving is claimed for this path (an illustration only): no figure may be led with. */
  claimed: boolean;
}

/** The headline of the comparison: how much sooner the simulated path reached a diagnosis, with its estimate range. */
export function timeSaved(scenario: CounterfactualScenario): TimeSaved {
  const recorded = scenario.actualMetrics.timeToDiagnosisMinutes.mid;
  const simulated = scenario.counterfactualMetrics.timeToDiagnosisMinutes;
  const verdict: TimeSavedVerdict =
    simulated.high < recorded ? 'faster' : simulated.low > recorded ? 'slower' : 'unclear';
  return {
    verdict,
    recorded,
    simulated,
    saved: {
      low: recorded - simulated.high,
      mid: recorded - simulated.mid,
      high: recorded - simulated.low,
    },
    claimed: scenario.quality === undefined || scenario.quality.timeSavedClaim !== 'none',
  };
}
