import type {
  ActionValueConfig,
  CaseEvent,
  CaseResolution,
  DecisionStep,
  KnowledgeAction,
} from '@caseguard/schemas';
import type { EngineContext } from '../engine/context';
import type { DeterministicAnalysis } from '../engine/pipeline';
import { signalRequirementLinks } from '../engine/requirements';
import type { CompiledPack } from '../knowledge/compile';
import type { CaseInfo } from './evidence';
import { likelihoodOf } from './ladder';

/** A completed, validated case whose outcome may teach an existing skill something new. */
export interface MutationSourceCase {
  caseId: string;
  reference: string;
  synthetic: boolean;
  caseInfo: CaseInfo;
  events: readonly CaseEvent[];
  resolution: CaseResolution | null;
  /** Full post-hoc analysis of the completed case. */
  analysis: DeterministicAnalysis;
  pack: CompiledPack;
  config: ActionValueConfig;
  ctx: EngineContext;
}

/** The diagnostic actions of the case that produced the evidence confirming the recorded cause. */
export function confirmingActions(source: MutationSourceCase, truth: string): KnowledgeAction[] {
  const { pack, analysis } = source;
  const required = pack.hypotheses.get(truth)?.confirmationRequirementIds ?? [];
  const links = signalRequirementLinks(pack);
  const observed = new Set(analysis.observations.map((o) => o.signalId));
  const keys = [
    ...new Set(analysis.actions.map((a) => a.actionKey).filter((k): k is string => k !== null)),
  ];
  return keys
    .map((k) => pack.actions.get(k))
    .filter((a): a is KnowledgeAction => a !== undefined && a.valueClass === 'diagnostic')
    .filter(
      (a) =>
        (a.produces.some((r) => required.includes(r)) ||
          a.outcomes.some((o) =>
            o.emitsSignals.some((s) => [...(links.get(s) ?? [])].some((r) => required.includes(r))),
          )) &&
        a.outcomes.some(
          (o) =>
            o.emitsSignals.length > 0 &&
            o.emitsSignals.every((s) => {
              const signal = pack.signals.get(s);
              return observed.has(s) && signal !== undefined && likelihoodOf(signal, truth) >= 0.8;
            }),
        ),
    );
}

/** The moment the source case first chose how to investigate: its earliest eligible fork, else its first action. */
export function decisionEventOf(analysis: DeterministicAnalysis): string | null {
  const fork = analysis.forks.find((f) => f.eligibility.eligible);
  return fork?.eventId ?? analysis.actions[0]?.eventId ?? null;
}

/** Whether a branch exists because its outcome contradicts the skill's premise (those never continue). */
export function breaksPremise(
  pack: CompiledPack,
  step: DecisionStep,
  outcomeId: string | undefined,
  exclusions: ReadonlySet<string>,
): boolean {
  const action = step.actionKey ? pack.actions.get(step.actionKey) : undefined;
  const outcome = action?.outcomes.find((o) => o.id === outcomeId);
  return outcome?.emitsSignals.some((s) => exclusions.has(s)) ?? false;
}
