import type { HypothesisStatus } from '@caseguard/schemas';
import type { CompiledPack } from '../knowledge/compile';
import { clamp, entropyBits, klBits, normalize, percentile } from '../util/math';
import { createRng } from '../util/rng';
import type { Observation } from './signals';
import type { TemporalView } from './temporal';

export type Belief = Record<string, number>;

/** Exponent applied to a likelihood so strong signals count fully and weak ones less (assumption A-05). */
export function observationWeight(
  pack: CompiledPack,
  signalId: string,
  repeatIndex: number,
): number {
  const signal = pack.signals.get(signalId);
  if (!signal) return 0;
  const strength = pack.pack.policies.strengthWeights[signal.strength];
  // Repeated observations of one signal are not independent evidence, so each repeat counts half as much.
  return strength * (repeatIndex === 0 ? 1 : 0.5 ** repeatIndex);
}

export function likelihoodOf(pack: CompiledPack, signalId: string, hypothesisId: string): number {
  const signal = pack.signals.get(signalId);
  if (!signal) return 0.5;
  return signal.likelihoods[hypothesisId] ?? signal.neutral;
}

export function priorBelief(pack: CompiledPack): Belief {
  return Object.fromEntries(pack.pack.hypotheses.map((h) => [h.id, h.prior]));
}

function floorAndNormalize(values: number[], floor: number): number[] {
  const normalized = normalize(values);
  const floored = normalized.map((v) => Math.max(v, floor));
  return normalize(floored);
}

/** Posterior after applying a list of observations to the prior (log-space, dampened). */
export function posteriorFrom(
  pack: CompiledPack,
  observations: readonly Observation[],
  start?: Belief,
): Belief {
  const ids = pack.hypothesisIds;
  const base = start ?? priorBelief(pack);
  const logw = ids.map((id) => Math.log(Math.max(base[id] ?? 1e-6, 1e-6)));
  for (const obs of observations) {
    if (!obs.affectsBelief) continue;
    const w = observationWeight(pack, obs.signalId, obs.repeatIndex);
    ids.forEach((id, i) => {
      logw[i] =
        (logw[i] ?? 0) + w * Math.log(clamp(likelihoodOf(pack, obs.signalId, id), 0.01, 0.99));
    });
  }
  const max = Math.max(...logw);
  const probs = floorAndNormalize(
    logw.map((l) => Math.exp(l - max)),
    pack.pack.policies.posteriorFloor,
  );
  return Object.fromEntries(ids.map((id, i) => [id, probs[i] ?? 0]));
}

export const beliefToVector = (pack: CompiledPack, belief: Belief): number[] =>
  pack.hypothesisIds.map((id) => belief[id] ?? 0);

export function topHypotheses(belief: Belief, count = 3): { id: string; p: number }[] {
  return Object.entries(belief)
    .map(([id, p]) => ({ id, p }))
    .sort((a, b) => b.p - a.p)
    .slice(0, count);
}

export const beliefEntropy = (pack: CompiledPack, belief: Belief): number =>
  entropyBits(beliefToVector(pack, belief));

/** Information gained moving from one belief to another, in bits (KL divergence after || before). */
export const informationGain = (pack: CompiledPack, before: Belief, after: Belief): number =>
  klBits(beliefToVector(pack, after), beliefToVector(pack, before));

// ---------------------------------------------------------------------------------------------
// Timeline

export interface ObservationEffect {
  observation: Observation;
  /** Posterior change per hypothesis caused by this observation at the moment it arrived. */
  delta: Record<string, number>;
  /** log2 likelihood ratio versus the other hypotheses (dampened). Positive supports. */
  logLr: Record<string, number>;
}

export interface BeliefStep {
  eventIndex: number;
  eventId: string;
  at: string;
  posterior: Belief;
  low: Belief;
  high: Belief;
  /** Observations that arrived at this event and moved beliefs. */
  effects: ObservationEffect[];
  gainBits: number;
}

export interface BeliefTimeline {
  prior: Belief;
  steps: BeliefStep[];
}

/** Perturbed likelihood table for one Monte-Carlo sample. */
function perturbedLikelihood(
  cache: Map<string, number>,
  rng: ReturnType<typeof createRng>,
  pack: CompiledPack,
  signalId: string,
  hypothesisId: string,
): number {
  const key = `${signalId}|${hypothesisId}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const base = likelihoodOf(pack, signalId, hypothesisId);
  const value = clamp(base * Math.exp(0.35 * rng.normal()), 0.01, 0.99);
  cache.set(key, value);
  return value;
}

/**
 * Builds the confidence-over-time series: the posterior after every event, with a 10-90 percent
 * band from a seeded Monte-Carlo perturbation of priors and likelihoods ("confidence range").
 */
export function buildBeliefTimeline(
  view: TemporalView,
  pack: CompiledPack,
  observations: readonly Observation[],
  options: { seed: string; samples?: number },
): BeliefTimeline {
  const ids = pack.hypothesisIds;
  const samples = options.samples ?? 80;
  const byEvent = new Map<number, Observation[]>();
  for (const obs of observations) {
    const list = byEvent.get(obs.eventIndex) ?? [];
    list.push(obs);
    byEvent.set(obs.eventIndex, list);
  }

  const prior = priorBelief(pack);
  const steps: BeliefStep[] = [];
  let current: Belief = prior;
  for (let i = 0; i < view.events.length; i++) {
    const event = view.events[i];
    if (!event) continue;
    const before = current;
    const effects: ObservationEffect[] = [];
    let running = current;
    for (const obs of byEvent.get(i) ?? []) {
      if (!obs.affectsBelief) continue;
      const after = posteriorFrom(pack, [obs], running);
      const w = observationWeight(pack, obs.signalId, obs.repeatIndex);
      const delta: Record<string, number> = {};
      const logLr: Record<string, number> = {};
      for (const id of ids) {
        delta[id] = (after[id] ?? 0) - (running[id] ?? 0);
        const p = running[id] ?? 0;
        const lh = clamp(likelihoodOf(pack, obs.signalId, id), 0.01, 0.99) ** w;
        let denom = 0;
        for (const other of ids) {
          if (other === id) continue;
          denom +=
            (running[other] ?? 0) * clamp(likelihoodOf(pack, obs.signalId, other), 0.01, 0.99) ** w;
        }
        const mixture = denom / Math.max(1 - p, 1e-6);
        logLr[id] = Math.log2(lh / Math.max(mixture, 1e-9));
      }
      effects.push({ observation: obs, delta, logLr });
      running = after;
    }
    current = running;
    steps.push({
      eventIndex: i,
      eventId: event.id,
      at: event.timestamp,
      posterior: current,
      low: current,
      high: current,
      effects,
      gainBits: informationGain(pack, before, current),
    });
  }

  // Uncertainty band: one perturbed model per sample, evaluated along the whole timeline.
  const rng = createRng(`${options.seed}|band`);
  const perStep: number[][][] = steps.map(() => ids.map(() => [] as number[]));
  for (let s = 0; s < samples; s++) {
    const cache = new Map<string, number>();
    const sampleRng = createRng(`${options.seed}|sample|${s}|${rng.next()}`);
    const logPrior = normalize(
      ids.map((id) => (prior[id] ?? 0.01) * Math.exp(0.3 * sampleRng.normal())),
    );
    const logw = logPrior.map((p) => Math.log(Math.max(p, 1e-6)));
    for (let i = 0; i < steps.length; i++) {
      for (const obs of byEvent.get(i) ?? []) {
        if (!obs.affectsBelief) continue;
        const w = observationWeight(pack, obs.signalId, obs.repeatIndex);
        ids.forEach((id, h) => {
          logw[h] =
            (logw[h] ?? 0) +
            w * Math.log(perturbedLikelihood(cache, sampleRng, pack, obs.signalId, id));
        });
      }
      const max = Math.max(...logw);
      const probs = floorAndNormalize(
        logw.map((l) => Math.exp(l - max)),
        pack.pack.policies.posteriorFloor,
      );
      probs.forEach((p, h) => perStep[i]?.[h]?.push(p));
    }
  }
  steps.forEach((step, i) => {
    const low: Belief = {};
    const high: Belief = {};
    ids.forEach((id, h) => {
      const draws = perStep[i]?.[h] ?? [];
      const point = step.posterior[id] ?? 0;
      low[id] = Math.min(point, draws.length ? percentile(draws, 0.1) : point);
      high[id] = Math.max(point, draws.length ? percentile(draws, 0.9) : point);
    });
    step.low = low;
    step.high = high;
  });

  return { prior, steps };
}

export interface StatusContext {
  /** Peak posterior seen so far per hypothesis (to detect demotion). */
  peak: Belief;
  /** Whether each hypothesis' confirmation requirements are satisfied at this step. */
  confirmationMet: (hypothesisId: string) => boolean;
}

/** Status of one hypothesis at one step (see FR-HY-02 status over time). */
export function hypothesisStatus(
  pack: CompiledPack,
  posterior: Belief,
  hypothesisId: string,
  ctx: StatusContext,
): HypothesisStatus {
  const p = posterior[hypothesisId] ?? 0;
  const ranked = topHypotheses(posterior, 2);
  const top = ranked[0];
  const second = ranked[1];
  if (p >= pack.pack.policies.diagnosisThreshold && ctx.confirmationMet(hypothesisId))
    return 'confirmed';
  if (top?.id === hypothesisId && p >= 0.3 && p - (second?.p ?? 0) >= 0.1) return 'leading';
  const peak = ctx.peak[hypothesisId] ?? p;
  if (p < 0.03 && peak >= 0.1) return 'ruled_out';
  if (peak >= 0.15 && p < 0.6 * peak) return 'demoted';
  return 'active';
}
