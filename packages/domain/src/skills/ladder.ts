import type { ActionValueConfig, KnowledgeAction, KnowledgeSignal } from '@caseguard/schemas';
import type { CompiledPack } from '../knowledge/compile';
import type { KnowledgeState } from './state';
import { byString } from './util';

/** Likelihood of a signal under one hypothesis (the pack's neutral value when it is not listed). */
export const likelihoodOf = (signal: KnowledgeSignal, hypothesis: string): number =>
  signal.likelihoods[hypothesis] ?? signal.neutral;

/** Hypotheses in the same category as `key` (for example DNS and proxy are both network-path causes). */
export function familyOf(pack: CompiledPack, key: string): string[] {
  const category = pack.hypotheses.get(key)?.category;
  if (!category || category === 'unknown') return [key];
  return pack.pack.hypotheses
    .filter((h) => h.category === category && h.id !== 'hyp.other')
    .map((h) => h.id);
}

/**
 * How strongly a signal singles out the targets: log2 of the best target likelihood over the mean
 * likelihood of every other hypothesis. Positive means the signal is characteristic of the targets.
 */
export function lift(
  pack: CompiledPack,
  signal: KnowledgeSignal,
  targets: readonly string[],
): number {
  const inside = Math.max(...targets.map((t) => likelihoodOf(signal, t)));
  const others = pack.hypothesisIds.filter((h) => !targets.includes(h));
  if (others.length === 0) return 0;
  const mean = others.reduce((s, h) => s + likelihoodOf(signal, h), 0) / others.length;
  return Math.log2(inside / Math.max(mean, 0.01));
}

/** Signals that strongly contradict EVERY hypothesis of the family (they break the skill's premise). */
export function exclusionSignalIds(pack: CompiledPack, family: readonly string[]): string[] {
  return pack.pack.signals
    .filter((s) => s.strength !== 'weak' && family.every((h) => likelihoodOf(s, h) <= 0.12))
    .map((s) => s.id)
    .sort(byString);
}

export const isCheapSafeDiagnostic = (a: KnowledgeAction, config: ActionValueConfig): boolean =>
  isSafeDiagnostic(a, config) && (a.customerEffort === 'none' || a.customerEffort === 'low');

/** Read-only diagnostic at no more than medium customer effort (the bar for listed alternatives). */
export const isSafeDiagnostic = (a: KnowledgeAction, config: ActionValueConfig): boolean =>
  a.valueClass === 'diagnostic' &&
  config.effortScale[a.customerEffort] <= config.effortScale.medium &&
  !a.destructive &&
  !a.requiresApproval &&
  a.operationalRisk < config.riskCeiling;

export interface Ladder {
  /** Steps in stage order. */
  ordered: KnowledgeAction[];
  /** The subset that exists to rule out the skill's exclusions cheaply. */
  guards: KnowledgeAction[];
  /** Same-question checks the skill lists as alternatives but no source case has validated. */
  alternatives: KnowledgeAction[];
}

/**
 * Orders the investigation: the enabling steps of the validated path first, then the cheapest safe
 * checks that can rule out an exclusion (so the skill's premise is proven before it commits), then the
 * rest of the validated path. Guards whose prerequisites can never be met are dropped.
 */
export function deriveLadder(args: {
  pack: CompiledPack;
  config: ActionValueConfig;
  state0: KnowledgeState;
  path: readonly KnowledgeAction[];
  family: readonly string[];
  exclusionSignals: ReadonlySet<string>;
}): Ladder {
  const { pack, config, state0, path, family, exclusionSignals } = args;
  const inPath = new Set(path.map((a) => a.id));
  const guardCandidates = pack.pack.actions
    .filter(
      (a) =>
        !inPath.has(a.id) &&
        isCheapSafeDiagnostic(a, config) &&
        a.outcomes.some((o) => o.emitsSignals.some((s) => exclusionSignals.has(s))),
    )
    .sort((a, b) => a.timeMinutes.typical - b.timeMinutes.typical || byString(a.id, b.id));
  const guardIds = new Set(guardCandidates.map((a) => a.id));
  const pending = [
    ...path.filter((a) => a.valueClass === 'enabling'),
    ...guardCandidates,
    ...path.filter((a) => a.valueClass !== 'enabling'),
  ];
  const ordered: KnowledgeAction[] = [];
  const available = new Set(state0.satisfied);
  while (pending.length > 0) {
    const ready = pending.findIndex((a) => a.requires.every((r) => available.has(r)));
    if (ready < 0) {
      const next = pending.shift();
      if (next && !guardIds.has(next.id)) ordered.push(next);
      continue;
    }
    const [next] = pending.splice(ready, 1);
    if (!next) continue;
    ordered.push(next);
    for (const r of next.produces) available.add(r);
  }
  const terminal = [...path].reverse().find((a) => a.valueClass !== 'enabling');
  const orderedIds = new Set(ordered.map((a) => a.id));
  const alternatives = terminal
    ? pack.pack.actions
        .filter(
          (a) =>
            !orderedIds.has(a.id) &&
            isSafeDiagnostic(a, config) &&
            a.targets.some((t) => family.includes(t)) &&
            a.produces.some((r) => terminal.produces.includes(r)),
        )
        .sort((a, b) => byString(a.id, b.id))
    : [];
  return { ordered, guards: ordered.filter((a) => guardIds.has(a.id)), alternatives };
}

export interface TriggerSpec {
  signalId: string;
  required: boolean;
  weight: number;
  /** `decision_time` triggers were observable before the fork; `hindsight` ones use the recorded cause. */
  origin: 'decision_time' | 'hindsight';
  lift: number;
}

/**
 * Trigger conditions. Required ones are the customer-reported symptoms that were already on record at
 * the decision time and point at the family of causes. Optional ones are further signals that
 * characterise the recorded cause (hindsight, labelled as such) and that the first step can surface.
 */
export function deriveTriggers(args: {
  pack: CompiledPack;
  family: readonly string[];
  truth: string;
  observedAtDecision: ReadonlySet<string>;
  firstStepSignals: ReadonlySet<string>;
}): TriggerSpec[] {
  const { pack, family, truth, observedAtDecision, firstStepSignals } = args;
  const presence = pack.pack.signals.filter(
    (s) => s.evidenceKind === 'presence' && s.strength !== 'weak',
  );
  const required = presence
    .filter(
      (s) =>
        observedAtDecision.has(s.id) &&
        s.category === 'customer_reported' &&
        Math.max(...family.map((h) => likelihoodOf(s, h))) >= 0.6 &&
        lift(pack, s, family) >= 0.3,
    )
    .map((s) => ({ signalId: s.id, lift: lift(pack, s, family) }));
  const requiredIds = new Set(required.map((r) => r.signalId));
  const optional = presence
    .filter(
      (s) =>
        !requiredIds.has(s.id) &&
        (s.category === 'customer_reported' || firstStepSignals.has(s.id)) &&
        likelihoodOf(s, truth) >= 0.8 &&
        lift(pack, s, [truth]) >= 1,
    )
    .map((s) => ({ signalId: s.id, lift: lift(pack, s, [truth]) }));
  const liftTotal = optional.reduce((s, o) => s + o.lift, 0);
  const requiredShare = optional.length === 0 ? 1 : 0.5;
  const specs: TriggerSpec[] = [
    ...required.map((r) => ({
      signalId: r.signalId,
      required: true,
      weight: round3(requiredShare / required.length),
      origin: 'decision_time' as const,
      lift: r.lift,
    })),
    ...optional.map((o) => ({
      signalId: o.signalId,
      required: false,
      weight: round3((required.length === 0 ? 1 : 0.5) * (o.lift / liftTotal)),
      origin: 'hindsight' as const,
      lift: o.lift,
    })),
  ];
  return specs.sort(
    (a, b) => Number(b.required) - Number(a.required) || byString(a.signalId, b.signalId),
  );
}

const round3 = (x: number): number => Math.round(x * 1000) / 1000;
