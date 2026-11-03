import type { QualityBand } from '@caseguard/schemas';
import type { AcceptedLabels, LabelSet, LabelStatus } from './labels';
import type { EngineCaseOutput, MissCause } from './output';
import {
  NEGATION_REASONS,
  type CaseCategory,
  type Split,
} from './schema';
import {
  addCounts,
  calibrationOf,
  compareSets,
  precisionRecall,
  proportion,
  ZERO_COUNTS,
  type Calibration,
  type Counts,
  type PrecisionRecall,
  type Proportion,
} from './stats';
import { ACTION_DIMENSION, SIGNAL_DIMENSIONS } from './vocabulary';

/**
 * The measures of an evaluation run. Everything here is a pure function of accepted labels and plain engine outputs:
 * this module does not import the engine, reads no file and cannot change what the engine does.
 */

export interface CaseInput {
  readonly id: string;
  readonly split: Split;
  readonly categories: readonly CaseCategory[];
  readonly workload: string;
  /** How the labels of the case were accepted; `unlabelled` when it has no annotation at all. */
  readonly status: LabelStatus | 'unlabelled';
  /** The accepted labels; null when there are none to count (excluded, unadjudicated, unlabelled). */
  readonly labels: LabelSet | null;
  readonly annotators: readonly string[];
  readonly engine: EngineCaseOutput;
}

export function caseInputOf(
  loaded: { id: string; split: Split; categories: readonly CaseCategory[]; workload: string },
  accepted: AcceptedLabels | null,
  engine: EngineCaseOutput,
): CaseInput {
  return {
    id: loaded.id,
    split: loaded.split,
    categories: loaded.categories,
    workload: loaded.workload,
    status: accepted ? accepted.status : 'unlabelled',
    labels: accepted ? accepted.labels : null,
    annotators: accepted ? accepted.annotators : [],
    engine,
  };
}

// ---------------------------------------------------------------- helpers

const pairKey = (event: string, id: string): string => `${event}|${id}`;
const idOfPair = (pair: string): string => pair.slice(pair.indexOf('|') + 1);
const eventOfPair = (pair: string): string => pair.slice(0, pair.indexOf('|'));

const sortedRecord = <T>(map: ReadonlyMap<string, T>): Record<string, T> =>
  Object.fromEntries([...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

function bump(map: Map<string, Counts>, key: string, delta: Counts): void {
  map.set(key, addCounts(map.get(key) ?? ZERO_COUNTS, delta));
}

const recordOfPR = (map: ReadonlyMap<string, Counts>): Record<string, PrecisionRecall> =>
  sortedRecord(new Map([...map.entries()].map(([key, counts]) => [key, precisionRecall(counts)])));

const engineEvents = (input: CaseInput): ReadonlyMap<string, EngineCaseOutput['events'][number]> =>
  new Map(input.engine.events.map((event) => [event.key, event]));

const supported = (input: CaseInput): boolean => !input.engine.refused;

// ---------------------------------------------------------------- signals and actions

export interface LabelKindMeasures {
  /** Cases whose labels were counted. */
  readonly cases: number;
  readonly overall: PrecisionRecall;
  readonly byCategory: Readonly<Record<string, PrecisionRecall>>;
  readonly byDimension: Readonly<Record<string, PrecisionRecall>>;
  readonly byId: Readonly<Record<string, PrecisionRecall>>;
}

interface Comparison {
  readonly input: CaseInput;
  readonly tp: string[];
  readonly fp: string[];
  readonly fn: string[];
}

function measure(
  comparisons: readonly Comparison[],
  dimensionOf: (id: string) => string,
): LabelKindMeasures {
  let overall: Counts = ZERO_COUNTS;
  const byCategory = new Map<string, Counts>();
  const byDimension = new Map<string, Counts>();
  const byId = new Map<string, Counts>();
  for (const { input, tp, fp, fn } of comparisons) {
    const record = (pairs: readonly string[], delta: Counts): void => {
      for (const pair of pairs) {
        const id = idOfPair(pair);
        overall = addCounts(overall, delta);
        bump(byId, id, delta);
        bump(byDimension, dimensionOf(id), delta);
        for (const category of input.categories) bump(byCategory, category, delta);
      }
    };
    record(tp, { tp: 1, fp: 0, fn: 0 });
    record(fp, { tp: 0, fp: 1, fn: 0 });
    record(fn, { tp: 0, fp: 0, fn: 1 });
    // A case with no labelled or reported pair still counts as a case of its categories.
    for (const category of input.categories) if (!byCategory.has(category)) byCategory.set(category, ZERO_COUNTS);
  }
  return {
    cases: comparisons.length,
    overall: precisionRecall(overall),
    byCategory: recordOfPR(byCategory),
    byDimension: recordOfPR(byDimension),
    byId: recordOfPR(byId),
  };
}

export interface SignalMeasures extends LabelKindMeasures {
  /** Expected signals the engine did not report, by why (only when the run asked for the explanation). */
  readonly missCauses: Readonly<Record<MissCause | 'unexplained', number>>;
  /** Recall over the expected occurrences a text detector could report for the event as it is typed and authored. */
  readonly reachableRecall: Proportion;
}

export function signalMeasures(cases: readonly CaseInput[]): SignalMeasures {
  const comparisons: Comparison[] = [];
  const causes: Record<MissCause | 'unexplained', number> = {
    'structured-only': 0,
    'type-or-role-gate': 0,
    wording: 0,
    unexplained: 0,
  };
  for (const input of cases) {
    if (input.labels === null || !supported(input)) continue;
    const expected = new Set(input.labels.signals.map((label) => pairKey(label.event, label.id)));
    const result = compareSets(expected, new Set(input.engine.signals));
    comparisons.push({ input, ...result });
    for (const pair of result.fn) causes[input.engine.missCauses[pair] ?? 'unexplained'] += 1;
  }
  const base = measure(comparisons, (id) => SIGNAL_DIMENSIONS[id] ?? 'unknown');
  return {
    ...base,
    missCauses: causes,
    reachableRecall: proportion(base.overall.tp, base.overall.tp + causes.wording),
  };
}

export type ActionMeasures = LabelKindMeasures;

/** Actions are labelled on the events an engineer wrote, so only those events are compared. */
export function actionMeasures(cases: readonly CaseInput[]): ActionMeasures {
  const comparisons: Comparison[] = [];
  for (const input of cases) {
    if (input.labels?.actions === undefined || !supported(input)) continue;
    const events = engineEvents(input);
    const engineerSide = (pair: string): boolean => events.get(eventOfPair(pair))?.who === 'engineer';
    const expected = new Set(input.labels.actions.map((label) => pairKey(label.event, label.id)));
    const reported = new Set(input.engine.actions.filter(engineerSide));
    comparisons.push({ input, ...compareSets(expected, reported) });
  }
  return measure(comparisons, () => ACTION_DIMENSION);
}

// ---------------------------------------------------------------- negation

export interface NegationMeasures {
  readonly cases: number;
  /** Every decision on an event: the engine is right when it fires exactly for what is present. */
  readonly all: Proportion;
  /** The labelled absences (words of a signal or action, fact denied, guessed, intended...): the engine stayed silent. */
  readonly onAbsent: Proportion;
  /** The labelled presences: the engine fired. */
  readonly onPresent: Proportion;
  /** Silence rate on absences, by reason. */
  readonly byReason: Readonly<Record<string, Proportion>>;
}

export function negationMeasures(cases: readonly CaseInput[]): NegationMeasures {
  let counted = 0;
  let right = 0;
  let total = 0;
  let silent = 0;
  let absences = 0;
  let fired = 0;
  let presences = 0;
  const reasons = new Map<string, { silent: number; n: number }>();
  for (const input of cases) {
    const labels = input.labels;
    if (labels === null || labels.absent === undefined || !supported(input)) continue;
    counted += 1;
    const signals = new Set(input.engine.signals);
    const actions = new Set(input.engine.actions);
    const reportedPair = (event: string, id: string): boolean =>
      (id.startsWith('act.') ? actions : signals).has(pairKey(event, id));
    for (const label of labels.signals) {
      presences += 1;
      total += 1;
      if (reportedPair(label.event, label.id)) {
        fired += 1;
        right += 1;
      }
    }
    for (const label of labels.actions ?? []) {
      presences += 1;
      total += 1;
      if (reportedPair(label.event, label.id)) {
        fired += 1;
        right += 1;
      }
    }
    for (const label of labels.absent) {
      if (!NEGATION_REASONS.has(label.reason)) continue;
      absences += 1;
      total += 1;
      const quiet = !reportedPair(label.event, label.id);
      const entry = reasons.get(label.reason) ?? { silent: 0, n: 0 };
      entry.n += 1;
      if (quiet) {
        silent += 1;
        right += 1;
        entry.silent += 1;
      }
      reasons.set(label.reason, entry);
    }
  }
  return {
    cases: counted,
    all: proportion(right, total),
    onAbsent: proportion(silent, absences),
    onPresent: proportion(fired, presences),
    byReason: sortedRecord(
      new Map([...reasons.entries()].map(([reason, entry]) => [reason, proportion(entry.silent, entry.n)])),
    ),
  };
}

// ---------------------------------------------------------------- contradictions

export interface ContradictionMeasures {
  /** `not_available`: the engine does not report conflicts yet, so only the number of labelled ones is known. */
  readonly status: 'measured' | 'not_available' | 'no_labels';
  readonly cases: number;
  readonly labelled: number;
  readonly reported: number | null;
  /** Labelled conflicts for which the engine reports a conflict between the same two events (either order). */
  readonly foundPairs: Proportion | null;
  /** Among the found pairs, the engine's class is the labelled one. */
  readonly classAccuracy: Proportion | null;
  /** Among the found pairs, the subject is the labelled one. Secondary: an annotator cannot know the engine's keys. */
  readonly subjectAgreement: Proportion | null;
  /** Engine conflicts that match a labelled one, over all the engine reports (in the labelled cases). */
  readonly precision: Proportion | null;
}

const unorderedPair = (events: readonly [string, string]): string => [...events].sort().join('+');
const normalizeSubject = (subject: string): string => subject.trim().toLowerCase();

export function contradictionMeasures(cases: readonly CaseInput[]): ContradictionMeasures {
  let counted = 0;
  let labelled = 0;
  let reported = 0;
  let found = 0;
  let classRight = 0;
  let subjectRight = 0;
  let matchedEngine = 0;
  let available = 0;
  for (const input of cases) {
    const labels = input.labels?.conflicts;
    if (labels === undefined || !supported(input)) continue;
    counted += 1;
    labelled += labels.length;
    const conflicts = input.engine.conflicts;
    if (conflicts === 'not_available') continue;
    available += 1;
    reported += conflicts.length;
    const used = new Set<number>();
    for (const label of labels) {
      const pair = unorderedPair(label.events);
      const candidates = conflicts
        .map((conflict, index) => ({ conflict, index }))
        .filter(({ conflict, index }) => !used.has(index) && unorderedPair([conflict.events[0], conflict.events[1]]) === pair);
      const match = candidates.find(({ conflict }) => conflict.class === label.class) ?? candidates[0];
      if (!match) continue;
      used.add(match.index);
      found += 1;
      matchedEngine += 1;
      if (match.conflict.class === label.class) classRight += 1;
      if (normalizeSubject(match.conflict.subject) === normalizeSubject(label.subject)) subjectRight += 1;
    }
  }
  if (counted === 0) {
    return {
      status: 'no_labels',
      cases: 0,
      labelled: 0,
      reported: null,
      foundPairs: null,
      classAccuracy: null,
      subjectAgreement: null,
      precision: null,
    };
  }
  if (available === 0) {
    return {
      status: 'not_available',
      cases: counted,
      labelled,
      reported: null,
      foundPairs: null,
      classAccuracy: null,
      subjectAgreement: null,
      precision: null,
    };
  }
  return {
    status: 'measured',
    cases: counted,
    labelled,
    reported,
    foundPairs: proportion(found, labelled),
    classAccuracy: proportion(classRight, found),
    subjectAgreement: proportion(subjectRight, found),
    precision: proportion(matchedEngine, reported),
  };
}

// ---------------------------------------------------------------- unsupported cases and negative controls

export interface RejectionMeasures {
  /** Cases for another workload: the engine refuses them (no knowledge pack). */
  readonly unsupported: Proportion;
  /** Negative controls with nothing to find: no evidence reported and no decision point raised. */
  readonly negativeControls: Proportion;
}

export function rejectionMeasures(cases: readonly CaseInput[]): RejectionMeasures {
  const unsupported = cases.filter((input) => input.categories.includes('unsupported'));
  const controls = cases.filter(
    (input) =>
      input.categories.includes('negative-control') &&
      input.labels !== null &&
      input.labels.signals.length === 0,
  );
  return {
    unsupported: proportion(unsupported.filter((input) => input.engine.refused).length, unsupported.length),
    negativeControls: proportion(
      controls.filter((input) => input.engine.signals.length === 0 && input.engine.forks.length === 0).length,
      controls.length,
    ),
  };
}

// ---------------------------------------------------------------- decision points

export interface ForkMeasures {
  readonly cases: number;
  readonly labelled: number;
  readonly reported: number;
  /** Engine forks at an event and category some label names (the engine's additional categories count too). */
  readonly precision: Proportion;
  /** Labelled forks that some engine fork at the same event covers. */
  readonly recall: Proportion;
  readonly recallByCategory: Readonly<Record<string, Proportion>>;
}

export function forkMeasures(cases: readonly CaseInput[]): ForkMeasures {
  let counted = 0;
  let labelled = 0;
  let reported = 0;
  let engineMatched = 0;
  let labelMatched = 0;
  const byCategory = new Map<string, { found: number; n: number }>();
  for (const input of cases) {
    const labels = input.labels?.forks;
    if (labels === undefined || !supported(input)) continue;
    counted += 1;
    labelled += labels.length;
    reported += input.engine.forks.length;
    for (const fork of input.engine.forks) {
      if (labels.some((label) => label.event === fork.event && fork.categories.includes(label.category))) {
        engineMatched += 1;
      }
    }
    for (const label of labels) {
      const hit = input.engine.forks.some(
        (fork) => fork.event === label.event && fork.categories.includes(label.category),
      );
      if (hit) labelMatched += 1;
      const entry = byCategory.get(label.category) ?? { found: 0, n: 0 };
      entry.n += 1;
      if (hit) entry.found += 1;
      byCategory.set(label.category, entry);
    }
  }
  return {
    cases: counted,
    labelled,
    reported,
    precision: proportion(engineMatched, reported),
    recall: proportion(labelMatched, labelled),
    recallByCategory: sortedRecord(
      new Map([...byCategory.entries()].map(([category, entry]) => [category, proportion(entry.found, entry.n)])),
    ),
  };
}

export type EarliestAgreement = 'exact' | 'near' | 'different' | 'missed' | 'spurious' | 'agree-none';
export const EARLIEST_AGREEMENTS: readonly EarliestAgreement[] = [
  'exact',
  'near',
  'different',
  'missed',
  'spurious',
  'agree-none',
];

/** How the engine's earliest decision point compares with the labelled earliest missed moment. */
export function earliestAgreement(input: CaseInput): EarliestAgreement | null {
  const expected = input.labels?.earliestMissed;
  if (expected === undefined || input.labels === null || !supported(input)) return null;
  const actual = input.engine.earliestFork;
  if (expected === null) return actual === null ? 'agree-none' : 'spurious';
  if (actual === null) return 'missed';
  if (actual === expected) return 'exact';
  const position = new Map(input.engine.events.map((event, index) => [event.key, index]));
  return Math.abs((position.get(actual) ?? 99) - (position.get(expected) ?? -99)) <= 1 ? 'near' : 'different';
}

export interface EarliestMeasures {
  readonly cases: number;
  readonly counts: Readonly<Record<EarliestAgreement, number>>;
  /** Exact, or both say there is none. */
  readonly agree: Proportion;
  /** Exact, one event off, or both say there is none. */
  readonly withinOne: Proportion;
}

export function earliestMeasures(cases: readonly CaseInput[]): EarliestMeasures {
  const counts: Record<EarliestAgreement, number> = {
    exact: 0,
    near: 0,
    different: 0,
    missed: 0,
    spurious: 0,
    'agree-none': 0,
  };
  let n = 0;
  for (const input of cases) {
    const agreement = earliestAgreement(input);
    if (agreement === null) continue;
    counts[agreement] += 1;
    n += 1;
  }
  return {
    cases: n,
    counts,
    agree: proportion(counts.exact + counts['agree-none'], n),
    withinOne: proportion(counts.exact + counts.near + counts['agree-none'], n),
  };
}

// ---------------------------------------------------------------- hypotheses

/**
 * Whether the hypothesis the engine ranks first is one the story's cause allows. `right` means the evidence moved it
 * above its prior; `right-by-prior` that it leads only because it is the favourite before any evidence; `other` that
 * the catch-all leads; `wrong` that another named cause leads; `n/a` that the story names no cause.
 */
export type LeaderAgreement = 'right' | 'right-by-prior' | 'other' | 'wrong' | 'n/a';
export const LEADER_AGREEMENTS: readonly LeaderAgreement[] = ['right', 'right-by-prior', 'other', 'wrong', 'n/a'];

/** A confidence this close to the prior counts as not moved by evidence. */
export const PRIOR_TOLERANCE = 0.02;

export function leaderAgreement(input: CaseInput): LeaderAgreement | null {
  if (input.labels === null || !supported(input)) return null;
  const causes = input.labels.causes;
  if (causes === undefined || causes.length === 0) return 'n/a';
  const ranked = [...input.engine.hypotheses].sort((a, b) => b.confidence - a.confidence);
  const top = ranked[0];
  if (!top) return 'n/a';
  if (causes.includes(top.key)) {
    return top.confidence - top.prior > PRIOR_TOLERANCE ? 'right' : 'right-by-prior';
  }
  return top.key === 'hyp.other' ? 'other' : 'wrong';
}

export interface HypothesisMeasures {
  /** Cases with a labelled cause. */
  readonly cases: number;
  readonly leader: Readonly<Record<LeaderAgreement, number>>;
  /** The engine's leading hypothesis is a labelled cause (moved by evidence or not). */
  readonly leaderIsCause: Proportion;
  /** Of the cases where it is a labelled cause, how many were moved by evidence above the prior. */
  readonly leaderMovedByEvidence: Proportion;
  /** Engine confidence of each named hypothesis against whether it is a labelled cause. */
  readonly calibration: Calibration;
}

export function hypothesisMeasures(cases: readonly CaseInput[]): HypothesisMeasures {
  const leader: Record<LeaderAgreement, number> = { right: 0, 'right-by-prior': 0, other: 0, wrong: 0, 'n/a': 0 };
  const points: { p: number; outcome: boolean }[] = [];
  let withCause = 0;
  for (const input of cases) {
    const agreement = leaderAgreement(input);
    if (agreement === null) continue;
    leader[agreement] += 1;
    const causes = input.labels?.causes;
    if (causes === undefined || causes.length === 0) continue;
    withCause += 1;
    for (const hypothesis of input.engine.hypotheses) {
      if (hypothesis.key === 'hyp.other') continue;
      points.push({ p: hypothesis.confidence, outcome: causes.includes(hypothesis.key) });
    }
  }
  return {
    cases: withCause,
    leader,
    leaderIsCause: proportion(leader.right + leader['right-by-prior'], withCause),
    leaderMovedByEvidence: proportion(leader.right, leader.right + leader['right-by-prior']),
    calibration: calibrationOf(points),
  };
}

// ---------------------------------------------------------------- citations, recommendations

export interface CitationMeasures {
  readonly cases: number;
  readonly total: number;
  readonly verified: Proportion;
  readonly mismatch: number;
  readonly notCheckable: number;
}

export function citationMeasures(cases: readonly CaseInput[]): CitationMeasures {
  let counted = 0;
  let total = 0;
  let verified = 0;
  let mismatch = 0;
  let notCheckable = 0;
  for (const input of cases) {
    if (!supported(input)) continue;
    counted += 1;
    total += input.engine.citations.total;
    verified += input.engine.citations.verified;
    mismatch += input.engine.citations.mismatch;
    notCheckable += input.engine.citations.notCheckable;
  }
  return { cases: counted, total, verified: proportion(verified, total), mismatch, notCheckable };
}

export interface RecommendationMeasures {
  readonly cases: number;
  readonly total: number;
  /** Recommendation-like outputs that carry evidence ids or are explicitly general guidance. */
  readonly linked: Proportion;
  readonly withEvidence: number;
  readonly general: number;
}

export function recommendationMeasures(cases: readonly CaseInput[]): RecommendationMeasures {
  let counted = 0;
  let total = 0;
  let withEvidence = 0;
  let general = 0;
  for (const input of cases) {
    const counts = input.engine.recommendations;
    if (counts === null || !supported(input)) continue;
    counted += 1;
    total += counts.total;
    withEvidence += counts.withEvidence;
    general += counts.general;
  }
  return { cases: counted, total, linked: proportion(withEvidence + general, total), withEvidence, general };
}

// ---------------------------------------------------------------- counterfactual direction, quality band

export interface CounterfactualMeasures {
  readonly status: 'measured' | 'not_run';
  readonly cases: number;
  readonly agreement: Proportion;
  /** Rows: the label. Columns: what the engine's simulated better path says. */
  readonly confusion: Readonly<Record<'better' | 'none', Readonly<Record<'better' | 'none', number>>>>;
}

export function counterfactualMeasures(cases: readonly CaseInput[]): CounterfactualMeasures {
  const confusion = { better: { better: 0, none: 0 }, none: { better: 0, none: 0 } };
  let n = 0;
  let agree = 0;
  let anyRun = false;
  for (const input of cases) {
    if (input.engine.counterfactual !== null) anyRun = true;
    const label = input.labels?.counterfactualDirection;
    if ((label !== 'better' && label !== 'none') || input.engine.counterfactual === null) continue;
    const engine = input.engine.counterfactual.clearlyBetter ? 'better' : 'none';
    confusion[label][engine] += 1;
    n += 1;
    if (label === engine) agree += 1;
  }
  return { status: anyRun ? 'measured' : 'not_run', cases: n, agreement: proportion(agree, n), confusion };
}

const BAND_ORDER: readonly QualityBand[] = ['poor', 'needs_attention', 'adequate', 'strong'];

export interface QualityMeasures {
  readonly cases: number;
  readonly exact: Proportion;
  readonly withinOne: Proportion;
}

export function qualityMeasures(cases: readonly CaseInput[]): QualityMeasures {
  let n = 0;
  let exact = 0;
  let near = 0;
  for (const input of cases) {
    const label = input.labels?.qualityBand;
    if (label === undefined || label === null || input.engine.qualityBand === null) continue;
    const engineIndex = BAND_ORDER.indexOf(input.engine.qualityBand as QualityBand);
    if (engineIndex < 0) continue;
    const distance = Math.abs(BAND_ORDER.indexOf(label) - engineIndex);
    n += 1;
    if (distance === 0) exact += 1;
    if (distance <= 1) near += 1;
  }
  return { cases: n, exact: proportion(exact, n), withinOne: proportion(near, n) };
}

// ---------------------------------------------------------------- the whole run

export interface CaseSummary {
  readonly total: number;
  readonly byStatus: Readonly<Record<string, number>>;
  readonly byCategory: Readonly<Record<string, number>>;
  readonly annotators: readonly string[];
  /** Labelled signal occurrences and engine events counted. */
  readonly labelledSignals: number;
  readonly events: number;
}

export interface MetricsResult {
  readonly cases: CaseSummary;
  readonly signals: SignalMeasures;
  readonly actions: ActionMeasures;
  readonly negation: NegationMeasures;
  readonly contradiction: ContradictionMeasures;
  readonly rejection: RejectionMeasures;
  readonly forks: ForkMeasures;
  readonly earliest: EarliestMeasures;
  readonly hypotheses: HypothesisMeasures;
  readonly citations: CitationMeasures;
  readonly recommendations: RecommendationMeasures;
  readonly counterfactual: CounterfactualMeasures;
  readonly quality: QualityMeasures;
}

function summarizeCases(cases: readonly CaseInput[]): CaseSummary {
  const byStatus = new Map<string, number>();
  const byCategory = new Map<string, number>();
  const annotators = new Set<string>();
  let labelledSignals = 0;
  let events = 0;
  for (const input of cases) {
    byStatus.set(input.status, (byStatus.get(input.status) ?? 0) + 1);
    for (const category of input.categories) byCategory.set(category, (byCategory.get(category) ?? 0) + 1);
    for (const annotator of input.annotators) annotators.add(annotator);
    labelledSignals += input.labels?.signals.length ?? 0;
    events += input.engine.events.length;
  }
  return {
    total: cases.length,
    byStatus: sortedRecord(byStatus),
    byCategory: sortedRecord(byCategory),
    annotators: [...annotators].sort(),
    labelledSignals,
    events,
  };
}

/** Every measure of a set of cases. Reordered copies are not part of it: they are checked for invariance only. */
export function computeMetrics(cases: readonly CaseInput[]): MetricsResult {
  return {
    cases: summarizeCases(cases),
    signals: signalMeasures(cases),
    actions: actionMeasures(cases),
    negation: negationMeasures(cases),
    contradiction: contradictionMeasures(cases),
    rejection: rejectionMeasures(cases),
    forks: forkMeasures(cases),
    earliest: earliestMeasures(cases),
    hypotheses: hypothesisMeasures(cases),
    citations: citationMeasures(cases),
    recommendations: recommendationMeasures(cases),
    counterfactual: counterfactualMeasures(cases),
    quality: qualityMeasures(cases),
  };
}

// ---------------------------------------------------------------- per-case detail and invariance

export interface CaseDetail {
  readonly id: string;
  readonly split: Split;
  readonly status: string;
  readonly categories: readonly CaseCategory[];
  readonly refused: boolean;
  readonly signals: { readonly tp: readonly string[]; readonly fp: readonly string[]; readonly fn: readonly string[] } | null;
  readonly actions: { readonly tp: readonly string[]; readonly fp: readonly string[]; readonly fn: readonly string[] } | null;
  readonly earliest: { readonly engine: string | null; readonly label: string | null; readonly agreement: EarliestAgreement } | null;
  readonly leader: { readonly key: string; readonly confidence: number; readonly agreement: LeaderAgreement } | null;
  /** The best-placed accepted cause: its rank among the hypotheses, its confidence and its prior. */
  readonly cause: { readonly rank: number; readonly confidence: number; readonly prior: number } | null;
  readonly forkCount: number;
}

/** The per-case lines of a run. Never printed for the locked test split unless asked for, and then recorded as such. */
export function caseDetail(input: CaseInput): CaseDetail {
  const labels = input.labels;
  const supportedCase = supported(input);
  let signals: CaseDetail['signals'] = null;
  if (labels !== null && supportedCase) {
    signals = compareSets(
      new Set(labels.signals.map((label) => pairKey(label.event, label.id))),
      new Set(input.engine.signals),
    );
  }
  let actions: CaseDetail['actions'] = null;
  if (labels?.actions !== undefined && supportedCase) {
    const events = engineEvents(input);
    actions = compareSets(
      new Set(labels.actions.map((label) => pairKey(label.event, label.id))),
      new Set(input.engine.actions.filter((pair) => events.get(eventOfPair(pair))?.who === 'engineer')),
    );
  }
  const agreement = earliestAgreement(input);
  const ranked = [...input.engine.hypotheses].sort((a, b) => b.confidence - a.confidence);
  const top = ranked[0];
  const leader = leaderAgreement(input);
  const causes = labels?.causes ?? [];
  const causeIndex = ranked.findIndex((hypothesis) => causes.includes(hypothesis.key));
  const cause = causeIndex >= 0 ? ranked[causeIndex] : undefined;
  return {
    id: input.id,
    split: input.split,
    status: input.status,
    categories: input.categories,
    refused: input.engine.refused,
    signals,
    actions,
    earliest:
      agreement === null
        ? null
        : { engine: input.engine.earliestFork, label: labels?.earliestMissed ?? null, agreement },
    leader: top && leader !== null ? { key: top.key, confidence: top.confidence, agreement: leader } : null,
    cause: cause ? { rank: causeIndex + 1, confidence: cause.confidence, prior: cause.prior } : null,
    forkCount: input.engine.forks.length,
  };
}

export interface InvarianceResult {
  readonly caseId: string;
  readonly derivedFrom: string;
  readonly identical: boolean;
  /** Which parts of the analysis differ between the copy and its source (empty when identical). */
  readonly differences: readonly string[];
}

/** A reordered copy must give exactly the analysis of its source: the engine reads events by time, not by position. */
export function invariance(source: EngineCaseOutput, copy: EngineCaseOutput): InvarianceResult {
  const differences: string[] = [];
  if (source.refused !== copy.refused) differences.push('refusal');
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  if (source.fingerprint !== copy.fingerprint) differences.push('fingerprint');
  if (!same(source.signals, copy.signals)) differences.push('signals');
  if (!same(source.actions, copy.actions)) differences.push('actions');
  if (!same(source.forks, copy.forks)) differences.push('forks');
  if (source.earliestFork !== copy.earliestFork) differences.push('earliest fork');
  if (!same(source.hypotheses, copy.hypotheses)) differences.push('hypotheses');
  if (!same(source.conflicts, copy.conflicts)) differences.push('conflicts');
  return {
    caseId: copy.caseId,
    derivedFrom: source.caseId,
    identical: differences.length === 0,
    differences,
  };
}
