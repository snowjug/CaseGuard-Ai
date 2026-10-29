import {
  AVOIDABLE_EFFORT_COMPONENTS,
  type AvoidableEffortComponentKey,
  type CounterfactualScenario,
  type DecisionFork,
  type EvidenceLink,
  type Level,
  type PathMetrics,
  type Range,
} from '@caseguard/schemas';
import { findDiagnosisIndex } from '../engine/hindsight';
import type { DeterministicAnalysis } from '../engine/pipeline';
import type { CompiledPack } from '../knowledge/compile';
import { evidenceLink, plural, uniqueLinks } from '../quality/links';
import { round } from '../util/math';
import { formatUtcStamp } from '../util/time';
import {
  ASE_COMPONENT_SPECS,
  ASE_NOTICE,
  CF_METRIC_FOR,
  avoidableAgainst,
  range,
  roundRange,
  zeroRange,
  type AvoidableComponentDetail,
  type AvoidableEffortEstimate,
} from './ase-model';

export interface AvoidableEffortInput {
  /** Analysis of the (usually full) case: decision-time flags and the actual path come from here. */
  analysis: DeterministicAnalysis;
  pack: CompiledPack;
  /** Scenarios generated for the decision forks (any strategies). Unusable ones are ignored. */
  scenarios: readonly CounterfactualScenario[];
  /** Overrides for the component weights; they are re-normalised over components that have data. */
  weights?: Partial<Record<AvoidableEffortComponentKey, number>>;
}

/** A scenario a reviewer may rely on: valid, leak-free, completed and not rejected by a human. */
export const isUsableScenario = (s: CounterfactualScenario): boolean =>
  s.status === 'completed' &&
  s.validity.valid &&
  s.boundary.leakCheck.passed &&
  s.reviewState !== 'rejected';

const LEVEL_ORDER: readonly Level[] = ['low', 'medium', 'high'];

function noCounterfactualReason(scenarios: readonly CounterfactualScenario[]): string {
  if (scenarios.length === 0) {
    return 'No counterfactual path has been simulated for the decision forks yet, so there is nothing valid to compare with. Run the counterfactual simulation to estimate avoidable effort.';
  }
  const rejected = scenarios.filter((s) => s.reviewState === 'rejected').length;
  const invalid = scenarios.filter((s) => s.status !== 'completed' || !s.validity.valid).length;
  const parts = [
    rejected > 0 ? `${plural(rejected, 'path')} rejected by a reviewer` : null,
    invalid > 0 ? `${plural(invalid, 'path')} failed the validity checks` : null,
  ].filter((p): p is string => p !== null);
  return `No valid, non-rejected counterfactual path is available (${parts.join('; ') || 'none passed the leak check'}), so avoidable effort cannot be estimated.`;
}

interface WindowFacts {
  forkIndex: number;
  endIndex: number;
  actions: DeterministicAnalysis['actions'];
  escalations: { total: number; flagged: DecisionFork[]; eventIds: string[] };
  computeSeconds: number;
}

/** The slice of the real case the counterfactual replaces: from the fork to the confirmed diagnosis. */
function windowFacts(
  analysis: DeterministicAnalysis,
  pack: CompiledPack,
  fork: DecisionFork,
): WindowFacts {
  const events = analysis.view.events;
  const forkIndex = Math.max(
    0,
    events.findIndex((e) => e.id === fork.eventId),
  );
  const diagnosis = findDiagnosisIndex(
    pack,
    analysis.timeline,
    analysis.requirementStates,
    forkIndex,
  );
  const endIndex = diagnosis?.index ?? events.length - 1;
  const actions = analysis.actions.filter((a) => a.sequence >= forkIndex && a.sequence <= endIndex);
  const inWindow = events.slice(forkIndex, endIndex + 1);
  const actionByEvent = new Map(analysis.actions.map((a) => [a.eventId, a]));
  const escalationIds = inWindow
    .filter((e) => e.type === 'escalation' || actionByEvent.get(e.id)?.kind === 'escalation')
    .map((e) => e.id);
  const flagged = analysis.forks.filter(
    (f) =>
      escalationIds.includes(f.eventId) &&
      (f.category === 'premature_escalation' ||
        f.additionalCategories.includes('premature_escalation')),
  );
  return {
    forkIndex,
    endIndex,
    actions,
    escalations: { total: escalationIds.length, flagged, eventIds: escalationIds },
    computeSeconds: inWindow.reduce((s, e) => s + (e.ai?.computeSeconds ?? 0), 0),
  };
}

interface ScenarioEvaluation {
  scenario: CounterfactualScenario;
  pct: Map<AvoidableEffortComponentKey, Range>;
  avoidable: Map<AvoidableEffortComponentKey, Range>;
  composite: Range;
}

function emptyEstimate(
  state: AvoidableEffortEstimate['state'],
  reason: string,
  percent: Range | null,
  confidence: Level,
): AvoidableEffortEstimate {
  return {
    state,
    estimated: true,
    simulated: false,
    reason,
    percent,
    confidence,
    components: [],
    basis: null,
    method:
      'Avoidable Support Effort compares the real path from the earliest decision fork with the best valid simulated alternative. It cannot be computed without one.',
    assumptions: [],
    notice: ASE_NOTICE,
  };
}

/**
 * Estimates Avoidable Support Effort: the share of the effort between the earliest usable decision
 * fork and the confirmed diagnosis that the best VALID simulated alternative would have avoided.
 *
 * Every component is clamped to 0-100%, the weights are re-normalised over the components that have
 * data, and the result is an estimate with a low-high range (rollout 10th-90th percentiles across all
 * valid strategies). It is never a measurement. With no decision fork the estimate is 0%; with forks
 * but no valid counterfactual it is null and carries the reason.
 */
export function computeAvoidableEffort(input: AvoidableEffortInput): AvoidableEffortEstimate {
  const { analysis, pack, scenarios } = input;
  if (analysis.forks.length === 0) {
    return emptyEstimate(
      'no_decision_forks',
      'No decision fork was detected: at each decision the step taken was close to the best safe alternative available, so no avoidable effort was identified. No counterfactual was needed.',
      zeroRange(),
      'medium',
    );
  }
  const usable = scenarios.filter(isUsableScenario);
  const forkOrder = [...analysis.forks].sort((a, b) => a.sequence - b.sequence);
  const withScenarios = forkOrder.filter((f) => usable.some((s) => s.forkId === f.id));
  const preferred = withScenarios.find((f) => f.id === analysis.earliestMeaningfulForkId);
  const fork = preferred ?? withScenarios[0];
  if (!fork) {
    return emptyEstimate('no_valid_counterfactual', noCounterfactualReason(scenarios), null, 'low');
  }
  const chosen = usable.filter((s) => s.forkId === fork.id);
  const win = windowFacts(analysis, pack, fork);
  const reference = chosen[0];
  if (!reference)
    return emptyEstimate('no_valid_counterfactual', noCounterfactualReason(scenarios), null, 'low');
  const actual: PathMetrics = reference.actualMetrics;

  const lowValue = win.actions.filter((a) => a.lowValue);
  const totals: Record<AvoidableEffortComponentKey, number> = {
    engineer_effort: actual.actionCount.mid,
    customer_effort: actual.customerEffortMinutes.mid,
    repeated_interactions: actual.customerInteractions.mid,
    diagnostic_executions: actual.diagnosticVolume.mid,
    escalations: win.escalations.total,
    waiting_time: actual.timeToDiagnosisMinutes.mid,
    token_usage: actual.tokenEstimate.mid,
    compute_usage: win.computeSeconds,
    low_information_actions: win.actions.length,
  };
  const overrides = input.weights ?? {};
  const rawWeight = (key: AvoidableEffortComponentKey): number =>
    Math.max(0, overrides[key] ?? ASE_COMPONENT_SPECS[key].weight);
  const included = AVOIDABLE_EFFORT_COMPONENTS.filter((k) => totals[k] > 0 && rawWeight(k) > 0);
  const weightSum = included.reduce((s, k) => s + rawWeight(k), 0);
  if (included.length === 0 || weightSum <= 0) {
    return emptyEstimate(
      'no_valid_counterfactual',
      'The real path from the decision fork contains no measurable effort to compare.',
      null,
      'low',
    );
  }
  const weightOf = (key: AvoidableEffortComponentKey): number =>
    included.includes(key) ? rawWeight(key) / weightSum : 0;

  // Decision-time components: flagged steps may have had a rationale the record does not show, so the
  // low end counts half of them.
  const flaggedShare = (flagged: number, total: number): Range =>
    total > 0
      ? range(50 * (flagged / total), (100 * flagged) / total, (100 * flagged) / total)
      : zeroRange();
  const decisionPct = new Map<AvoidableEffortComponentKey, Range>([
    ['escalations', flaggedShare(win.escalations.flagged.length, win.escalations.total)],
    ['low_information_actions', flaggedShare(lowValue.length, win.actions.length)],
  ]);

  const evaluations: ScenarioEvaluation[] = chosen.map((scenario) => {
    const pct = new Map<AvoidableEffortComponentKey, Range>();
    const avoidable = new Map<AvoidableEffortComponentKey, Range>();
    for (const key of AVOIDABLE_EFFORT_COMPONENTS) {
      const select = CF_METRIC_FOR[key];
      if (select) {
        const result = avoidableAgainst(totals[key], select(scenario.counterfactualMetrics));
        if (result) {
          pct.set(key, result.pct);
          avoidable.set(key, result.avoidable);
        }
      }
    }
    // Compute scales with the simulated diagnostic volume: no separate compute simulation exists.
    const volume = pct.get('diagnostic_executions');
    if (volume) {
      pct.set('compute_usage', volume);
      avoidable.set(
        'compute_usage',
        range(
          (volume.low / 100) * totals.compute_usage,
          (volume.mid / 100) * totals.compute_usage,
          (volume.high / 100) * totals.compute_usage,
        ),
      );
    }
    for (const [key, value] of decisionPct) {
      pct.set(key, value);
      const total = totals[key];
      avoidable.set(
        key,
        range((value.low / 100) * total, (value.mid / 100) * total, (value.high / 100) * total),
      );
    }
    const sumOf = (pick: (r: Range) => number): number =>
      included.reduce((s, key) => s + weightOf(key) * pick(pct.get(key) ?? zeroRange()), 0);
    return {
      scenario,
      pct,
      avoidable,
      composite: range(
        sumOf((r) => r.low),
        sumOf((r) => r.mid),
        sumOf((r) => r.high),
      ),
    };
  });

  const best = evaluations.reduce((a, b) => (b.composite.mid > a.composite.mid + 1e-9 ? b : a));
  const lowAll = Math.min(...evaluations.map((e) => e.composite.low));
  const highAll = Math.max(...evaluations.map((e) => e.composite.high));
  const percent = roundRange(
    range(
      Math.min(lowAll, best.composite.mid),
      best.composite.mid,
      Math.max(highAll, best.composite.mid),
    ),
  );

  const forkLink = evidenceLink('fork', fork.id, fork.title);
  const scenarioLink = evidenceLink('scenario', best.scenario.id, best.scenario.label);
  const actionLinks = (ids: string[]): EvidenceLink[] =>
    ids.map((id) => {
      const action = analysis.actions.find((a) => a.eventId === id);
      return action ? evidenceLink('action', action.id, action.label) : evidenceLink('event', id);
    });

  const assumptionFor = (key: AvoidableEffortComponentKey): string => {
    switch (key) {
      case 'engineer_effort':
        return 'Counted as the number of steps on the path; the simulated alternative needs the median number of steps from its rollouts.';
      case 'customer_effort':
        return 'Customer minutes use the estimated effort scale (none 0, low 10, medium 30, high 90, very high 180), not measured time.';
      case 'repeated_interactions':
        return 'Counts requests that needed the customer to act; the alternative is the simulated median.';
      case 'diagnostic_executions':
        return 'Diagnostic volume is the sum of knowledge-pack compute units of the steps; both sides are estimates.';
      case 'escalations':
        return 'An escalation counts as avoidable when the minimum evidence was missing at the time; the low end counts half of the flagged ones.';
      case 'waiting_time':
        return 'Time runs from the decision fork to a confirmed diagnosis; the alternative uses a response-time prior for customer steps, never the observed future.';
      case 'token_usage':
        return 'Tokens combine recorded telemetry where an event carries it and knowledge-pack estimates elsewhere; the alternative uses pack estimates.';
      case 'compute_usage':
        return 'Measured compute seconds from event telemetry; the avoidable share is assumed to follow the simulated diagnostic volume.';
      case 'low_information_actions':
        return 'Steps flagged at decision time as repeats, re-checks of known outcomes, or far weaker than the best safe alternative; the low end counts half.';
    }
  };
  const evidenceFor = (key: AvoidableEffortComponentKey): EvidenceLink[] => {
    if (key === 'escalations')
      return uniqueLinks([forkLink, ...actionLinks(win.escalations.eventIds)], 6);
    if (key === 'low_information_actions')
      return uniqueLinks(
        [forkLink, ...lowValue.slice(0, 4).map((a) => evidenceLink('action', a.id, a.label))],
        6,
      );
    return uniqueLinks([scenarioLink, forkLink], 6);
  };

  const components: AvoidableComponentDetail[] = AVOIDABLE_EFFORT_COMPONENTS.map((key) => {
    const spec = ASE_COMPONENT_SPECS[key];
    const isIncluded = included.includes(key);
    const midPct = best.pct.get(key) ?? zeroRange();
    const lows = evaluations.map((e) => e.pct.get(key)?.low ?? 0);
    const highs = evaluations.map((e) => e.pct.get(key)?.high ?? 0);
    const pct = isIncluded
      ? roundRange(range(Math.min(...lows, midPct.mid), midPct.mid, Math.max(...highs, midPct.mid)))
      : zeroRange();
    const avoidable = isIncluded
      ? roundRange(best.avoidable.get(key) ?? zeroRange(), 2)
      : zeroRange();
    return {
      key,
      label: spec.label,
      unit: spec.unit,
      source: spec.source,
      included: isIncluded,
      total: round(totals[key], 2),
      avoidable,
      pct,
      weight: round(weightOf(key), 4),
      assumption: isIncluded
        ? assumptionFor(key)
        : `Excluded: ${key === 'compute_usage' ? 'no compute telemetry was recorded on the real path' : 'the real path has no such effort'}. Its weight is redistributed to the other components.`,
      evidence: isIncluded ? evidenceFor(key) : [],
    };
  });

  const comparison = best.scenario.comparisonConfidence.level;
  const width = percent.high - percent.low;
  let confidence: Level = comparison;
  if (width > 50) confidence = 'low';
  else if (width > 30 && comparison === 'high') confidence = 'medium';
  const lowest = chosen
    .map((s) => s.comparisonConfidence.level)
    .reduce<Level>((a, b) => (LEVEL_ORDER.indexOf(b) < LEVEL_ORDER.indexOf(a) ? b : a), 'high');
  if (LEVEL_ORDER.indexOf(lowest) < LEVEL_ORDER.indexOf(confidence)) confidence = lowest;

  const assumptions = [
    ...new Set([
      ...best.scenario.assumptions.slice(0, 4),
      `The comparison starts at the earliest decision fork with a valid alternative (${formatUtcStamp(fork.timestamp)}) and runs to the confirmed diagnosis.`,
      `The range combines the 10th-90th percentile of the simulated rollouts across ${plural(chosen.length, 'valid strategy', 'valid strategies')}; the central value is the most favourable valid strategy.`,
      'Flagged steps may have had a justification that the case record does not show.',
    ]),
  ];

  return {
    state: 'estimated',
    estimated: true,
    simulated: true,
    reason: null,
    percent,
    confidence,
    components,
    basis: {
      forkId: fork.id,
      forkEventId: fork.eventId,
      forkAt: fork.timestamp,
      bestScenarioId: best.scenario.id,
      bestStrategy: best.scenario.strategy,
      scenarioIds: chosen.map((s) => s.id),
      comparisonConfidence: comparison,
      remainingPct: roundRange(range(100 - percent.high, 100 - percent.mid, 100 - percent.low)),
    },
    method: `ASE = sum(weight x avoidable share) over the ${included.length} effort components that have data (weights re-normalised). For each component the avoidable share is (actual - simulated alternative) / actual on the path from ${formatUtcStamp(fork.timestamp)} to the confirmed diagnosis, clamped to 0-100%. Counterfactual paths are simulated from the knowledge pack using only information available at that moment, so every figure is an estimate.`,
    assumptions,
    notice: ASE_NOTICE,
  };
}
