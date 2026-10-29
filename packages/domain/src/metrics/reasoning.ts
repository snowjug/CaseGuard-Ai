import type { ActionValueConfig, DiagnosticAction } from '@caseguard/schemas';
import { DEFAULT_ACTION_VALUE_CONFIG } from '@caseguard/schemas';
import { actionCostOf, isHygieneAction, MIN_MEANINGFUL_COST } from '../engine/actions';
import type { DeterministicAnalysis } from '../engine/pipeline';
import type { CompiledPack } from '../knowledge/compile';
import { clamp, mean, round } from '../util/math';

export interface ReasoningDecision {
  action: DiagnosticAction;
  /** Share of the best safe alternative's value (0-1) after the fairness rules below. */
  ratio: number;
  /** The engine's raw relative value at decision time. */
  rawRatio: number;
  /** Why the ratio was lifted to 1 (trivially cheap or routine hygiene), or null. */
  excused: 'cheap' | 'routine' | null;
}

export interface ReasoningEfficiency {
  /** 0-100, or null when no decision could be ranked. */
  value: number | null;
  decisions: ReasoningDecision[];
  /** Mean of the raw relative values, without the fairness rules (the strict reading). */
  strictValue: number | null;
}

/**
 * Reasoning efficiency: the mean, over ranked decisions, of (value of the chosen action / value of
 * the best safe action at that moment) x 100. Consistent with fork detection, trivially cheap steps
 * and routine hygiene steps (data requests, updates, validation at modest effort) are not held
 * against the engineer unless they were repeats or re-checks of known outcomes. Decision-time data only.
 */
export function computeReasoningEfficiency(
  analysis: DeterministicAnalysis,
  pack: CompiledPack,
  config: ActionValueConfig = DEFAULT_ACTION_VALUE_CONFIG,
): ReasoningEfficiency {
  const decisions: ReasoningDecision[] = [];
  for (const action of analysis.actions) {
    if (action.relativeValueAtDecision === null) continue;
    const raw = action.relativeValueAtDecision;
    const decision = analysis.decisions.get(action.eventId);
    const packAction = action.actionKey ? pack.actions.get(action.actionKey) : undefined;
    // lowValue already encodes repeats, re-checks of known outcomes and costly weak choices, so it
    // is the one case where the fairness rules below must not apply.
    const known = action.lowValue;
    let ratio = raw;
    let excused: ReasoningDecision['excused'] = null;
    if (!known) {
      if (decision && actionCostOf(decision.actual, config) < MIN_MEANINGFUL_COST) {
        ratio = 1;
        excused = 'cheap';
      } else if (packAction?.kind !== 'escalation' && isHygieneAction(packAction, config)) {
        ratio = 1;
        excused = 'routine';
      }
    }
    decisions.push({ action, ratio: clamp(ratio, 0, 1), rawRatio: clamp(raw, 0, 1), excused });
  }
  if (decisions.length === 0) return { value: null, decisions, strictValue: null };
  return {
    value: round(100 * mean(decisions.map((d) => d.ratio)), 1),
    decisions,
    strictValue: round(100 * mean(decisions.map((d) => d.rawRatio)), 1),
  };
}
