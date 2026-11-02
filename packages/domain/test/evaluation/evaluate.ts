import type { CaseBundle } from '@caseguard/schemas';
import type { CompiledPack } from '../../src';
import { prepareBundle } from '../helpers';
import { NEGATIVE_CASES, NOISY_CASES, REORDERED_CASES } from './corpus-other';
import { PARAPHRASE_CASES } from './corpus-paraphrase';
import { toBundle, type EvalCase, type EvalGroup, type SignalId } from './types';

export const EVAL_CASES: readonly EvalCase[] = [
  ...PARAPHRASE_CASES,
  ...NOISY_CASES,
  ...NEGATIVE_CASES,
  ...REORDERED_CASES,
];

export type ForkAgreement = 'exact' | 'near' | 'different' | 'missed' | 'spurious' | 'agree-none';

/**
 * Whether the hypothesis the engine ranks first is one the story's cause allows. `right` means the evidence moved it
 * above its prior; `right-by-prior` that it leads only because it is the favourite before any evidence (so no
 * evidence-driven agreement); `other` that the catch-all leads; `wrong` that another named cause leads.
 */
export type LeaderAgreement = 'right' | 'right-by-prior' | 'other' | 'wrong' | 'n/a';

/** A confidence this close to the prior (as a probability) counts as not moved by evidence. */
const PRIOR_TOLERANCE = 0.02;

/**
 * Why an expected signal was not reported, decided from the detector definitions alone (never from the wording):
 *  - `structured-only`: every detector of the signal reads structured event data, so free text cannot show it;
 *  - `type-or-role-gate`: the signal has text detectors, but none accepts this event's type or author role;
 *  - `wording`: a text detector accepts the event and its pattern did not match what was written.
 */
export type MissCause = 'structured-only' | 'type-or-role-gate' | 'wording';

export interface CaseResult {
  readonly id: string;
  readonly group: EvalGroup;
  readonly bundle: CaseBundle;
  /** `eventKey|signalId` pairs the engine reported and the labels expect. */
  readonly truePositives: readonly string[];
  /** Reported, but not on the event's list. */
  readonly falsePositives: readonly string[];
  /** On the event's list, but not reported. */
  readonly misses: readonly string[];
  readonly missCauses: Readonly<Record<string, MissCause>>;
  readonly forkCount: number;
  readonly earliestFork: string | null;
  readonly expectedFork: string | null;
  readonly forkAgreement: ForkAgreement;
  readonly leader: string;
  readonly leaderConfidence: number;
  readonly leaderAgreement: LeaderAgreement;
  /** Rank (1 = first) and confidence of the best-placed hypothesis the story's cause allows; null with no cause. */
  readonly causeRank: number | null;
  readonly causeConfidence: number | null;
  readonly causePrior: number | null;
  /** Everything an order of events must not change, as one string. */
  readonly fingerprint: string;
}

const pair = (eventKey: string, signal: string): string => `${eventKey}|${signal}`;

function causeOf(
  pack: CompiledPack,
  signalId: string,
  event: { type: string; participantRole: string },
): MissCause {
  const detectors = pack.pack.signals.find((signal) => signal.id === signalId)?.detectors ?? [];
  const text = detectors.filter((detector) => detector.kind === 'regex');
  if (text.length === 0) return 'structured-only';
  const accepted = text.some(
    (detector) =>
      (!detector.eventTypes || detector.eventTypes.some((type) => type === event.type)) &&
      (!detector.roles || detector.roles.some((role) => role === event.participantRole)),
  );
  return accepted ? 'wording' : 'type-or-role-gate';
}

/** The case the way the engine sees it: events by time, hypotheses, evidence and forks. */
export function evaluateCase(source: EvalCase): CaseResult {
  const bundle = toBundle(source);
  const prepared = prepareBundle(bundle, `case_${source.id.replace(/[^a-z0-9]/g, '_')}`);
  const { normalized, analysis, pack } = prepared;

  const keyOf = new Map<string, string>();
  const position = new Map<string, number>();
  const eventOf = new Map<string, (typeof normalized.events)[number]>();
  normalized.events.forEach((event, index) => {
    const key = source.events.find((candidate) => event.id.endsWith(candidate.key))?.key;
    if (!key) throw new Error(`${source.id}: no authored event for ${event.id}`);
    keyOf.set(event.id, key);
    position.set(key, index);
    eventOf.set(key, event);
  });

  const reported = new Set<string>();
  for (const item of analysis.evidence) {
    const key = keyOf.get(item.eventId);
    if (key) reported.add(pair(key, item.signalId));
  }
  const expected = new Set<string>();
  for (const event of source.events)
    for (const id of event.signals ?? []) expected.add(pair(event.key, id));

  const truePositives = [...reported].filter((item) => expected.has(item)).sort();
  const falsePositives = [...reported].filter((item) => !expected.has(item)).sort();
  const misses = [...expected].filter((item) => !reported.has(item)).sort();
  const missCauses: Record<string, MissCause> = {};
  for (const item of misses) {
    const [key = '', signalId = ''] = item.split('|');
    const event = eventOf.get(key);
    if (event) missCauses[item] = causeOf(pack, signalId, event);
  }

  const earliest = analysis.forks.find((fork) => fork.isEarliestMeaningful);
  const earliestFork = earliest ? (keyOf.get(earliest.eventId) ?? null) : null;
  const expectedFork = source.earliestMissed;
  let forkAgreement: ForkAgreement;
  if (expectedFork === null) forkAgreement = earliestFork === null ? 'agree-none' : 'spurious';
  else if (earliestFork === null) forkAgreement = 'missed';
  else if (earliestFork === expectedFork) forkAgreement = 'exact';
  else
    forkAgreement =
      Math.abs((position.get(earliestFork) ?? 99) - (position.get(expectedFork) ?? -99)) <= 1
        ? 'near'
        : 'different';

  const ranked = [...analysis.hypotheses].sort((a, b) => b.currentConfidence - a.currentConfidence);
  const top = ranked[0];
  const leader = top?.key ?? 'none';
  let leaderAgreement: LeaderAgreement = 'n/a';
  if (source.causes) {
    if (source.causes.some((cause) => cause === leader))
      leaderAgreement =
        top && top.currentConfidence - top.prior > PRIOR_TOLERANCE ? 'right' : 'right-by-prior';
    else leaderAgreement = leader === 'hyp.other' ? 'other' : 'wrong';
  }
  const causeIndex = source.causes
    ? ranked.findIndex((hypothesis) => source.causes?.some((cause) => cause === hypothesis.key))
    : -1;
  const cause = causeIndex >= 0 ? ranked[causeIndex] : undefined;

  const fingerprint = JSON.stringify({
    evidence: [...reported].sort(),
    forks: analysis.forks.map((fork) => [keyOf.get(fork.eventId), fork.category, fork.severity]),
    hypotheses: analysis.hypotheses.map((hypothesis) => [
      hypothesis.key,
      Math.round(hypothesis.currentConfidence * 1e6),
    ]),
  });

  return {
    id: source.id,
    group: source.group,
    bundle,
    truePositives,
    falsePositives,
    misses,
    missCauses,
    forkCount: analysis.forks.length,
    earliestFork,
    expectedFork,
    forkAgreement,
    leader,
    leaderConfidence: top?.currentConfidence ?? 0,
    leaderAgreement,
    causeRank: cause ? causeIndex + 1 : null,
    causeConfidence: cause?.currentConfidence ?? null,
    causePrior: cause?.prior ?? null,
    fingerprint,
  };
}

export interface Rate {
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  /** Null when nothing was reported (no precision) or nothing was expected (no recall). */
  readonly precision: number | null;
  readonly recall: number | null;
}

export function rate(results: readonly CaseResult[]): Rate {
  const tp = results.reduce((sum, result) => sum + result.truePositives.length, 0);
  const fp = results.reduce((sum, result) => sum + result.falsePositives.length, 0);
  const fn = results.reduce((sum, result) => sum + result.misses.length, 0);
  return {
    tp,
    fp,
    fn,
    precision: tp + fp === 0 ? null : tp / (tp + fp),
    recall: tp + fn === 0 ? null : tp / (tp + fn),
  };
}

/** Expected signals that were not reported, counted by why (see `MissCause`). */
export function missSummary(results: readonly CaseResult[]): Record<MissCause, number> {
  const counts: Record<MissCause, number> = {
    'structured-only': 0,
    'type-or-role-gate': 0,
    wording: 0,
  };
  for (const result of results)
    for (const cause of Object.values(result.missCauses)) counts[cause] += 1;
  return counts;
}

/** Recall over the expected signals that a text detector could report for the event as it is typed and authored. */
export function reachableRecall(results: readonly CaseResult[]): number | null {
  const tp = results.reduce((sum, result) => sum + result.truePositives.length, 0);
  const wording = missSummary(results).wording;
  return tp + wording === 0 ? null : tp / (tp + wording);
}

export function rateBySignal(results: readonly CaseResult[]): Map<SignalId, Rate> {
  const ids = new Set<string>();
  for (const result of results)
    for (const item of [...result.truePositives, ...result.falsePositives, ...result.misses])
      ids.add(item.split('|')[1] ?? '');
  const out = new Map<SignalId, Rate>();
  for (const id of [...ids].sort()) {
    const tp = results.reduce(
      (sum, r) => sum + r.truePositives.filter((i) => i.endsWith(`|${id}`)).length,
      0,
    );
    const fp = results.reduce(
      (sum, r) => sum + r.falsePositives.filter((i) => i.endsWith(`|${id}`)).length,
      0,
    );
    const fn = results.reduce(
      (sum, r) => sum + r.misses.filter((i) => i.endsWith(`|${id}`)).length,
      0,
    );
    out.set(id as SignalId, {
      tp,
      fp,
      fn,
      precision: tp + fp === 0 ? null : tp / (tp + fp),
      recall: tp + fn === 0 ? null : tp / (tp + fn),
    });
  }
  return out;
}

export function leaderSummary(results: readonly CaseResult[]): Record<LeaderAgreement, number> {
  const counts: Record<LeaderAgreement, number> = {
    right: 0,
    'right-by-prior': 0,
    other: 0,
    wrong: 0,
    'n/a': 0,
  };
  for (const result of results) counts[result.leaderAgreement] += 1;
  return counts;
}

export function forkSummary(results: readonly CaseResult[]): Record<ForkAgreement, number> {
  const counts: Record<ForkAgreement, number> = {
    exact: 0,
    near: 0,
    different: 0,
    missed: 0,
    spurious: 0,
    'agree-none': 0,
  };
  for (const result of results) counts[result.forkAgreement] += 1;
  return counts;
}

/** Everything the measures are computed from. Reordered cases repeat other cases and are only checked for invariance. */
export function evaluateAll(): { results: CaseResult[]; scored: CaseResult[] } {
  const results = EVAL_CASES.map(evaluateCase);
  return { results, scored: results.filter((result) => result.group !== 'reordered') };
}
