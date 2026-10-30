import { round } from '@caseguard/domain';
import type { EfficiencyOverview, MetricEstimate } from '@caseguard/schemas';

/** One case's real-versus-simulated token comparison (both estimates). */
export interface TokenProcess {
  readonly actualTokens: number;
  readonly counterfactualTokens: number;
  readonly savingsPct: number | null;
}

/**
 * The token comparison of one case, from the token component of its stored avoidable-effort estimate
 * (null when it has none: no decision fork, or no valid simulated path to compare with). Same
 * arithmetic as the domain's `computeEfficiency().caseProcess` (the real path versus the path without
 * the avoidable share), applied to the stored component so no analysis has to be replayed.
 */
export function tokenProcessOf(estimates: readonly MetricEstimate[]): TokenProcess | null {
  const component = estimates
    .find((estimate) => estimate.key === 'avoidable_support_effort')
    ?.ase?.components.find((candidate) => candidate.key === 'token_usage');
  if (component === undefined) return null;
  return {
    actualTokens: Math.round(component.total),
    counterfactualTokens: Math.max(0, Math.round(component.total - component.avoidable)),
    savingsPct: component.total > 0 ? component.avoidablePct : null,
  };
}

const sum = (values: readonly number[]): number => values.reduce((total, v) => total + v, 0);

/**
 * `caseProcess` for the overview. For one case it is that case's comparison; without a case it adds
 * up the analysed cases that have one (`caseId` stays null). When nothing can be compared the answer
 * is `actualTokens: 0` with no counterfactual and no saving: "not available", never a zero saving.
 */
export function caseProcessOf(
  caseId: string | null,
  parts: readonly TokenProcess[],
): EfficiencyOverview['caseProcess'] {
  if (parts.length === 0) {
    return { actualTokens: 0, counterfactualTokens: null, estimatedSavingsPct: null, caseId };
  }
  const actual = sum(parts.map((part) => part.actualTokens));
  const counterfactual = sum(parts.map((part) => part.counterfactualTokens));
  const [only] = parts;
  const savings =
    parts.length === 1 && only !== undefined
      ? only.savingsPct
      : actual > 0
        ? round(((actual - counterfactual) / actual) * 100, 1)
        : null;
  return {
    actualTokens: actual,
    counterfactualTokens: counterfactual,
    estimatedSavingsPct: savings,
    caseId,
  };
}
