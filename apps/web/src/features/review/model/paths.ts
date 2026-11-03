import {
  STRATEGY_LABELS,
  type CounterfactualScenario,
  type ForkListResponse,
  type Level,
  type PathMetrics,
  type Range,
  type ReviewState,
} from '@caseguard/schemas';
import { formatDuration, formatNumber, formatProbability, type BadgeStatus } from '@caseguard/ui';
import { describeTrust, type TrustView } from '../../counterfactual/trust';
import {
  EFFORT_SHORT_LABELS,
  EXECUTOR_LABELS,
  LEVEL_LABELS,
  REVIEW_STATE_BADGES,
  isAcceptedState,
} from '../../reasoning/labels';
import { earliestFork, orderForks } from './forks';
import { describeRange, plural } from './words';

/** The label every figure of a simulated path carries. Nothing on it happened. */
export const SIMULATED_LABEL = 'Simulated estimate: nothing here happened';

export type Direction = 'better' | 'worse' | 'unclear';

export const DIRECTION_WORDS: Record<Direction, string> = {
  better: 'Better in this simulation',
  worse: 'Worse in this simulation',
  unclear: 'Within the simulation’s uncertainty',
};

/**
 * Whether a simulated range beats a recorded figure on a measure where less is better. It counts as better only when
 * even the pessimistic end of the simulated range is below the record (worse: even the optimistic end is above it);
 * a range that includes the recorded figure says nothing either way, and is never presented as an improvement.
 */
export function compareRanges(recorded: Range, simulated: Range): Direction {
  if (simulated.high < recorded.mid) return 'better';
  if (simulated.low > recorded.mid) return 'worse';
  return 'unclear';
}

const ROWS: readonly {
  key: keyof Pick<
    PathMetrics,
    | 'timeToUsefulEvidenceMinutes'
    | 'timeToDiagnosisMinutes'
    | 'customerInteractions'
    | 'customerEffortMinutes'
  >;
  label: string;
  format: (value: number) => string;
}[] = [
  {
    key: 'timeToUsefulEvidenceMinutes',
    label: 'Time to useful evidence',
    format: formatDuration,
  },
  { key: 'timeToDiagnosisMinutes', label: 'Time to diagnosis', format: formatDuration },
  {
    key: 'customerInteractions',
    label: 'Customer interactions',
    format: (value) => formatNumber(value, { maximumFractionDigits: 0 }),
  },
  { key: 'customerEffortMinutes', label: 'Customer effort', format: formatDuration },
];

export interface PathRow {
  key: string;
  label: string;
  recorded: Range;
  simulated: Range;
  recordedText: string;
  simulatedText: string;
  direction: Direction;
  directionLabel: string;
}

export interface PathStepView {
  index: number;
  label: string;
  ownerLabel: string;
  effortLabel: string;
  /** When the step is expected to finish, counted from the decision moment. */
  timing: string;
  outcome: string;
  supported: boolean;
}

export interface PathModel {
  scenarioId: string;
  forkId: string;
  strategy: CounterfactualScenario['strategy'];
  strategyLabel: string;
  title: string;
  /** The engine's own summary, which already says it is a simulated estimate. */
  summary: string;
  decision: { number: number; title: string; at: string } | null;
  rows: PathRow[];
  headline: string;
  confidence: { level: Level; label: string; scoreText: string; rationale: string };
  /** What the figures rest on and what to check; null for a scenario stored before the engine wrote it down. */
  trust: TrustView | null;
  validity: {
    valid: boolean;
    passed: number;
    total: number;
    failed: { id: string; detail: string }[];
    leakCheckPassed: boolean;
  };
  assumptions: string[];
  steps: PathStepView[];
  review: {
    state: ReviewState;
    label: string;
    badge: BadgeStatus;
    accepted: boolean;
    by: string | null;
    at: string | null;
    reason: string | null;
  };
  /** True when the path completed and passed its validity and leak checks. */
  usable: boolean;
  problems: string[];
  rollouts: { count: number; diagnosisReachedText: string };
  /** The other strategies simulated for the same decision point. */
  others: { id: string; label: string; reviewLabel: string }[];
}

export type PathsView =
  | { kind: 'no-decision-points' }
  | {
      kind: 'not-simulated';
      decision: { forkId: string; number: number; title: string; at: string };
      eligible: boolean;
      reasons: string[];
    }
  | { kind: 'ready'; path: PathModel };

/** The scenario to show for a decision point: an accepted one, else the balanced one, else the first that completed. */
export function chooseScenario(
  scenarios: readonly CounterfactualScenario[],
): CounterfactualScenario | null {
  const own = [...scenarios];
  return (
    own.find(
      (scenario) => isAcceptedState(scenario.reviewState) && scenario.status === 'completed',
    ) ??
    own.find((scenario) => scenario.strategy === 'balanced' && scenario.status === 'completed') ??
    own.find((scenario) => scenario.status === 'completed') ??
    own[0] ??
    null
  );
}

function summarise(rows: readonly PathRow[], confidence: Level): string {
  const better = rows.filter((row) => row.direction === 'better').length;
  const worse = rows.filter((row) => row.direction === 'worse').length;
  const unclear = rows.length - better - worse;
  const parts = [
    `${better} of ${plural(rows.length, 'measure')} come${better === 1 ? 's' : ''} out better than the record`,
  ];
  if (worse > 0) parts.push(`${worse} worse`);
  if (unclear > 0) parts.push(`${unclear} within the simulation’s uncertainty`);
  return `In this simulated estimate, ${parts.join(', ')}. Confidence in the comparison is ${LEVEL_LABELS[confidence].toLowerCase()}.`;
}

export function describeScenario(
  scenario: CounterfactualScenario,
  forks: ForkListResponse,
  all: readonly CounterfactualScenario[],
): PathModel {
  const ordered = orderForks(forks.items);
  const index = ordered.findIndex((fork) => fork.id === scenario.forkId);
  const fork = index >= 0 ? ordered[index] : undefined;
  const rows: PathRow[] = ROWS.map((row) => {
    const recorded = scenario.actualMetrics[row.key];
    const simulated = scenario.counterfactualMetrics[row.key];
    const direction = compareRanges(recorded, simulated);
    return {
      key: row.key,
      label: row.label,
      recorded,
      simulated,
      recordedText: describeRange(recorded, row.format),
      simulatedText: describeRange(simulated, row.format),
      direction,
      directionLabel: DIRECTION_WORDS[direction],
    };
  });
  const failed = scenario.validity.checks.filter((check) => !check.passed);
  const leak = scenario.boundary.leakCheck;
  const leakCheckPassed =
    leak.passed && leak.futureReferencesFound === 0 && leak.resolutionExcluded;
  const problems: string[] = [];
  if (scenario.status !== 'completed')
    problems.push(`The engine marked this path ${scenario.status}.`);
  if (!scenario.validity.valid || failed.length > 0)
    problems.push('It failed one or more validity checks.');
  if (!leakCheckPassed)
    problems.push('It did not pass the check that it used only what was known then.');
  const state = REVIEW_STATE_BADGES[scenario.reviewState];
  return {
    scenarioId: scenario.id,
    forkId: scenario.forkId,
    strategy: scenario.strategy,
    strategyLabel: STRATEGY_LABELS[scenario.strategy],
    title: scenario.label,
    summary: scenario.summary,
    decision: fork ? { number: index + 1, title: fork.title, at: fork.timestamp } : null,
    rows,
    headline: summarise(rows, scenario.comparisonConfidence.level),
    confidence: {
      level: scenario.comparisonConfidence.level,
      label: `${LEVEL_LABELS[scenario.comparisonConfidence.level]} confidence`,
      scoreText: formatProbability(scenario.comparisonConfidence.score, 0),
      rationale: scenario.comparisonConfidence.rationale,
    },
    trust: describeTrust(scenario.quality),
    validity: {
      valid: scenario.validity.valid,
      passed: scenario.validity.checks.length - failed.length,
      total: scenario.validity.checks.length,
      failed: failed.map((check) => ({ id: check.id, detail: check.detail })),
      leakCheckPassed,
    },
    assumptions: scenario.assumptions,
    steps: scenario.steps.map((step) => ({
      index: step.index + 1,
      label: step.label,
      ownerLabel: EXECUTOR_LABELS[step.executor],
      effortLabel: EFFORT_SHORT_LABELS[step.customerEffort],
      timing: describeRange(step.offsetMinutes, formatDuration),
      outcome: step.predictedOutcome.label,
      supported: step.supported,
    })),
    review: {
      state: scenario.reviewState,
      label: state.label,
      badge: state.status,
      accepted: isAcceptedState(scenario.reviewState),
      by: scenario.reviewedBy,
      at: scenario.reviewedAt,
      reason: scenario.reviewReason,
    },
    usable: problems.length === 0,
    problems,
    rollouts: {
      count: scenario.rollouts.count,
      diagnosisReachedText: formatProbability(scenario.rollouts.diagnosisReachedShare, 0),
    },
    others: all
      .filter((other) => other.forkId === scenario.forkId && other.id !== scenario.id)
      .map((other) => ({
        id: other.id,
        label: STRATEGY_LABELS[other.strategy],
        reviewLabel: REVIEW_STATE_BADGES[other.reviewState].label,
      })),
  };
}

/**
 * What should have happened at the earliest important missed moment: the simulated better-supported path set beside the
 * record, or the reason there is none to show (no decision point, or nobody has simulated one yet).
 */
export function derivePaths(
  forks: ForkListResponse,
  scenarios: readonly CounterfactualScenario[],
): PathsView {
  const fork = earliestFork(forks);
  if (!fork) return { kind: 'no-decision-points' };
  const own = scenarios.filter((scenario) => scenario.forkId === fork.id);
  const chosen = chooseScenario(own);
  if (!chosen) {
    return {
      kind: 'not-simulated',
      decision: {
        forkId: fork.id,
        number: orderForks(forks.items).findIndex((item) => item.id === fork.id) + 1,
        title: fork.title,
        at: fork.timestamp,
      },
      eligible: fork.eligibility.eligible,
      reasons: fork.eligibility.reasons,
    };
  }
  return { kind: 'ready', path: describeScenario(chosen, forks, scenarios) };
}

/** A scenario a reviewer accepted: the only kind a reusable skill may be extracted from. */
export function acceptedScenario(
  scenarios: readonly CounterfactualScenario[],
): CounterfactualScenario | null {
  return (
    scenarios.find(
      (scenario) => isAcceptedState(scenario.reviewState) && scenario.status === 'completed',
    ) ?? null
  );
}
