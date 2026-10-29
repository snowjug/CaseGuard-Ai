import type { AvoidableEffortComponent, AvoidableEffortDetails } from '@caseguard/schemas';
import { truncate } from '../quality/links';
import { round } from '../util/math';
import type { AvoidableEffortEstimate } from './ase-model';

/**
 * Projects the estimate onto the shared contract. The contract carries a single value per component;
 * the low-high ranges stay on the richer estimate.
 */
export function toAvoidableEffortDetails(
  estimate: AvoidableEffortEstimate,
): AvoidableEffortDetails {
  // Components without data carry no weight and no information, so the contract lists only the
  // included ones; the exclusions are explained in the estimate's assumptions.
  const components: AvoidableEffortComponent[] = estimate.components
    .filter((c) => c.included)
    .map((c) => ({
      key: c.key,
      label: c.label,
      unit: c.unit,
      total: Math.max(0, c.total),
      avoidable: Math.max(0, round(c.avoidable.mid, 2)),
      avoidablePct: c.pct.mid,
      weight: c.weight,
      assumption: c.assumption,
      evidence: c.evidence,
    }));
  const percent = estimate.percent;
  return {
    components,
    method: estimate.reason
      ? truncate(`${estimate.reason} ${estimate.method}`, 4000)
      : estimate.method,
    counterfactual:
      estimate.basis && percent
        ? {
            scenarioId: estimate.basis.bestScenarioId,
            actualPct: 100,
            counterfactualPct: estimate.basis.remainingPct.mid,
            counterfactualLowPct: estimate.basis.remainingPct.low,
            counterfactualHighPct: estimate.basis.remainingPct.high,
          }
        : null,
  };
}

export interface AvoidableEffortSummary {
  /** Cases with a usable estimate (state "estimated" or "no_decision_forks"). */
  caseCount: number;
  /** Cases that had forks but no valid counterfactual. */
  withoutCounterfactual: number;
  avgPercent: number | null;
  patterns: { component: string; label: string; avgAvoidablePct: number; caseCount: number }[];
}

/** Portfolio roll-up of per-case estimates (average share and the components that contribute most). */
export function summarizeAvoidableEffort(
  estimates: readonly AvoidableEffortEstimate[],
): AvoidableEffortSummary {
  const usable = estimates.filter((e) => e.percent !== null);
  const sums = new Map<string, { label: string; total: number; count: number }>();
  for (const estimate of usable) {
    for (const c of estimate.components) {
      if (!c.included) continue;
      const entry = sums.get(c.key) ?? { label: c.label, total: 0, count: 0 };
      entry.total += c.pct.mid;
      entry.count += 1;
      sums.set(c.key, entry);
    }
  }
  const avg =
    usable.length === 0
      ? null
      : round(usable.reduce((s, e) => s + (e.percent?.mid ?? 0), 0) / usable.length, 1);
  return {
    caseCount: usable.length,
    withoutCounterfactual: estimates.filter((e) => e.state === 'no_valid_counterfactual').length,
    avgPercent: avg,
    patterns: [...sums.entries()]
      .map(([component, v]) => ({
        component,
        label: v.label,
        avgAvoidablePct: round(v.total / v.count, 1),
        caseCount: v.count,
      }))
      .sort(
        (a, b) => b.avgAvoidablePct - a.avgAvoidablePct || (a.component < b.component ? -1 : 1),
      ),
  };
}
