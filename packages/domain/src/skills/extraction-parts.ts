import {
  DEFAULT_EFFORT_MINUTES,
  FORK_CATEGORY_LABELS,
  type CounterfactualScenario,
  type DecisionFork,
  type KnowledgeAction,
  type SkillContent,
} from '@caseguard/schemas';
import type { EngineContext } from '../engine/context';
import type { DeterministicAnalysis } from '../engine/pipeline';
import type { CompiledPack } from '../knowledge/compile';
import { round } from '../util/math';
import { clip } from './util';

export const HINDSIGHT_NOTICE =
  'Parts listed as hindsight were derived with knowledge of the recorded resolution. They are labelled estimates and are never used to decide whether the skill matches a case.';

/** Reasons the decision fork itself cannot seed a skill (empty when it can). */
export function forkRefusals(fork: DecisionFork, ctx: EngineContext): string[] {
  const reasons: string[] = [];
  if (fork.caseId !== ctx.caseId) reasons.push('The fork belongs to a different case.');
  if (!fork.eligibility.eligible) {
    reasons.push(
      `The decision fork is not eligible for counterfactual simulation: ${fork.eligibility.reasons.join(' ') || 'an eligibility check failed.'}`,
    );
  }
  if (fork.reviewState === 'rejected') reasons.push('A reviewer rejected this decision fork.');
  return reasons;
}

/** Reasons one scenario cannot seed a skill (invalid, leaky, rejected or not yet accepted). */
export function scenarioRefusals(
  scenario: CounterfactualScenario,
  fork: DecisionFork,
  requireAccepted: boolean,
): string[] {
  const reasons: string[] = [];
  if (scenario.forkId !== fork.id) reasons.push('The scenario was generated for a different fork.');
  if (scenario.status !== 'completed') {
    reasons.push(`The scenario status is ${scenario.status}, not completed.`);
  }
  if (!scenario.validity.valid) {
    reasons.push('The scenario failed the counterfactual validity checks.');
  }
  const leak = scenario.boundary.leakCheck;
  if (!leak.passed || leak.futureReferencesFound > 0 || !leak.resolutionExcluded) {
    reasons.push('The scenario did not pass the temporal leak check.');
  }
  if (scenario.reviewState === 'rejected') reasons.push('A reviewer rejected this scenario.');
  if (
    requireAccepted &&
    scenario.reviewState !== 'confirmed' &&
    scenario.reviewState !== 'corrected'
  ) {
    reasons.push('The scenario has not been accepted by a reviewer yet.');
  }
  return reasons;
}

/** Name derived from the pack's inference when the ladder proves it, else from the recorded cause. */
export function skillNameOf(
  pack: CompiledPack,
  truth: string,
  ordered: readonly KnowledgeAction[],
): string {
  const premise = pack.pack.inferences.find((inf) =>
    ordered.some((a) => a.outcomes.some((o) => o.emitsSignals.includes(inf.signalId))),
  );
  const identity = pack.pack.hypotheses.some((h) => h.category === 'identity');
  const truthCategory = pack.hypotheses.get(truth)?.category;
  if (premise && identity && truthCategory !== 'identity') {
    return `Isolate a ${premise.id.replace(/^inf\./, '')} failure before pursuing identity policy`;
  }
  return clip(
    `Isolate “${pack.hypotheses.get(truth)?.name ?? truth}” with the validated check order`,
    160,
  );
}

/** Failure modes the source case showed, described with pack labels only (never raw case text). */
export function knownFailureModesOf(analysis: DeterministicAnalysis, pack: CompiledPack): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const forks = [...analysis.forks].sort((a, b) => b.impactScore - a.impactScore);
  for (const fork of forks) {
    const label = fork.actual.actionKey ? pack.actions.get(fork.actual.actionKey)?.label : null;
    const text = clip(
      `${FORK_CATEGORY_LABELS[fork.category]}${label ? `: ${label}` : ''} (seen in the source case).`,
      300,
    );
    if (seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= 5) break;
  }
  return out;
}

/** Cheaper ways to learn what the step taken at the fork was meant to learn, from the fork's ranking. */
export function cheaperAlternativesOf(
  fork: DecisionFork,
  pack: CompiledPack,
): NonNullable<SkillContent['cheaperAlternatives']> {
  const actual = fork.actual.actionKey ? pack.actions.get(fork.actual.actionKey) : undefined;
  if (!actual) return [];
  return fork.alternatives
    .filter((a) => a.safe && a.actionKey !== actual.id)
    .slice(0, 2)
    .map((alt, i) => ({
      insteadOfActionKey: actual.id,
      insteadOfLabel: clip(actual.label, 200),
      useActionKey: alt.actionKey,
      useLabel: clip(alt.label, 200),
      rationale: clip(
        `Ranked ${i + 1} among the safe options at the decision time (relative value ${round(alt.relativeValue, 2)}); the original step needed ${actual.customerEffort.replace('_', ' ')} customer effort, this one ${alt.customerEffort.replace('_', ' ')}.`,
        400,
      ),
      estimatedCustomerMinutesSaved:
        DEFAULT_EFFORT_MINUTES[actual.customerEffort] - DEFAULT_EFFORT_MINUTES[alt.customerEffort],
      estimated: true as const,
    }));
}
