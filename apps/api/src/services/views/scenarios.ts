import { formatDuration, formatUtcStamp } from '@caseguard/domain';
import type { CounterfactualScenario, Range } from '@caseguard/schemas';
import { NotFoundError } from '../../errors';
import type { RequestContext } from '../../http/request-context';

/** What the decision-time summary reads: the simulated path alone, never the real one. */
export interface SummarySource {
  readonly label: string;
  readonly boundary: { readonly asOf: string };
  readonly steps: readonly { readonly label: string }[];
  readonly counterfactualMetrics: { readonly timeToDiagnosisMinutes: Range };
}

/** A stored counterfactual scenario of this case; another case's or tenant's scenario is a 404. */
export async function loadScenario(
  ctx: RequestContext,
  caseId: string,
  scenarioId: string,
): Promise<CounterfactualScenario> {
  const scenario = await ctx.repos.counterfactuals.get(caseId, scenarioId);
  if (scenario === null) throw new NotFoundError('Counterfactual scenario', scenarioId);
  return scenario;
}

/**
 * The scenario as an as-of window may show it. A scenario is generated from the information at its
 * decision instant, so it exists in a window only once that instant has been reached; before then it
 * is withheld (the view simply has no overlay). Its stored summary also compares the simulated path
 * with the real one, which is hindsight, so inside a window the summary is rebuilt from the simulated
 * path alone. Simulated steps stay labelled simulated either way.
 */
export function scenarioForWindow<T extends SummarySource & { readonly summary: string }>(
  scenario: T | null,
  asOf: string | null,
): T | null {
  if (scenario === null || asOf === null) return scenario;
  if (Date.parse(scenario.boundary.asOf) > Date.parse(asOf)) return null;
  return { ...scenario, summary: decisionTimeSummary(scenario) };
}

export function decisionTimeSummary(scenario: SummarySource): string {
  const from = formatUtcStamp(scenario.boundary.asOf);
  const count = scenario.steps.length;
  if (count === 0) return `No supported next step could be ranked from ${from}.`;
  const names = scenario.steps.slice(0, 3).map((step) => step.label);
  const time = scenario.counterfactualMetrics.timeToDiagnosisMinutes;
  return (
    `From ${from}, the “${scenario.label}” strategy would take ${count} step${count === 1 ? '' : 's'} ` +
    `(${names.join(' → ')}${count > 3 ? ' → …' : ''}) and is simulated to need about ` +
    `${formatDuration(time.mid)} (range ${formatDuration(time.low)}–${formatDuration(time.high)}) ` +
    'to reach a diagnosis. Simulated estimate, not a measurement.'
  );
}
