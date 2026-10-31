import type {
  ActionOverrideRecord,
  ActionRanking,
  DecisionFork,
  DiagnosticAction,
  Evidence,
  Hypothesis,
  HypothesisEvidenceLink,
  HypothesisPoint,
  HypothesisStatus,
  MissingEvidence,
} from '@caseguard/schemas';
import type { LineChartEvent, LineSeries } from '@caseguard/ui';

/** Pure view-model helpers for the Hypothesis Arena (no React, no fetching), so they can be unit-tested. */

/** A hypothesis whose confidence ever reached this share is a serious contender and is always charted. */
export const CONTENDER_THRESHOLD = 0.1;
const MIN_CHARTED = 3;

export const peakConfidence = (hypothesis: Hypothesis): number =>
  hypothesis.timeline.reduce((peak, point) => Math.max(peak, point.confidence), 0);

/**
 * Which hypotheses to draw. By default the serious contenders (and always the focused one); "show all" draws every
 * hypothesis. Nine lines that sit at 1% for most of the case would hide the story, so the default is the contenders.
 */
export function chartedHypotheses(
  hypotheses: readonly Hypothesis[],
  focusId: string | null,
  showAll: boolean,
): Hypothesis[] {
  if (showAll) return [...hypotheses];
  const contenders = hypotheses.filter(
    (h) => h.id === focusId || peakConfidence(h) >= CONTENDER_THRESHOLD,
  );
  if (contenders.length >= MIN_CHARTED) return contenders;
  const byConfidence = [...hypotheses].sort((a, b) => b.currentConfidence - a.currentConfidence);
  return hypotheses.filter(
    (h) => contenders.includes(h) || byConfidence.slice(0, MIN_CHARTED).includes(h),
  );
}

/** Line series; only the focused hypothesis carries its 10-90% band so overlapping bands never hide each other. */
export function buildSeries(charted: readonly Hypothesis[], focusId: string | null): LineSeries[] {
  return charted.map((hypothesis) => ({
    id: hypothesis.id,
    label: hypothesis.name,
    points: hypothesis.timeline.map((point) =>
      hypothesis.id === focusId
        ? { x: point.at, y: point.confidence, low: point.low, high: point.high }
        : { x: point.at, y: point.confidence },
    ),
  }));
}

export interface ChartMarker extends LineChartEvent {
  kind: 'action' | 'fork' | 'both';
}

/**
 * Numbered markers for the chart: the engineer's actions and the decision forks, merged when they share an instant
 * (a fork is always about an action). Only what the API returned for the current boundary is used.
 */
export function chartMarkers(
  actions: readonly DiagnosticAction[],
  forks: readonly DecisionFork[],
): ChartMarker[] {
  const byInstant = new Map<number, { actions: DiagnosticAction[]; forks: DecisionFork[] }>();
  const slot = (at: string) => {
    const key = Date.parse(at);
    let entry = byInstant.get(key);
    if (!entry) {
      entry = { actions: [], forks: [] };
      byInstant.set(key, entry);
    }
    return entry;
  };
  for (const action of actions) slot(action.startedAt).actions.push(action);
  for (const fork of forks) slot(fork.timestamp).forks.push(fork);
  return [...byInstant.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([instant, entry]) => {
      const at = new Date(instant).toISOString();
      const parts = [
        ...entry.actions.map((a) => `Action: ${a.label}`),
        ...entry.forks.map((f) => `Decision fork: ${f.title}`),
      ];
      const kind: ChartMarker['kind'] =
        entry.actions.length > 0 && entry.forks.length > 0
          ? 'both'
          : entry.forks.length > 0
            ? 'fork'
            : 'action';
      return { x: at, label: parts.join(' · '), kind };
    });
}

export interface WeighedEvidence {
  evidence: Evidence;
  link: HypothesisEvidenceLink;
}

export interface HypothesisEvidence {
  supporting: WeighedEvidence[];
  contradicting: WeighedEvidence[];
  neutralCount: number;
}

/** Evidence that bears on one hypothesis, strongest effect first. Links whose evidence is not in the response are skipped. */
export function evidenceFor(
  hypothesis: Pick<Hypothesis, 'id'>,
  links: readonly HypothesisEvidenceLink[],
  evidence: readonly Evidence[],
): HypothesisEvidence {
  const byId = new Map(evidence.map((item) => [item.id, item]));
  const mine = links.filter((link) => link.hypothesisId === hypothesis.id);
  const weigh = (polarity: HypothesisEvidenceLink['polarity']): WeighedEvidence[] =>
    mine
      .filter((link) => link.polarity === polarity)
      .flatMap((link) => {
        const item = byId.get(link.evidenceId);
        return item ? [{ evidence: item, link }] : [];
      })
      .sort(
        (a, b) =>
          Math.abs(b.link.effectOnConfidence) - Math.abs(a.link.effectOnConfidence) ||
          Date.parse(a.link.observedAt) - Date.parse(b.link.observedAt),
      );
  return {
    supporting: weigh('supports'),
    contradicting: weigh('contradicts'),
    neutralCount: mine.filter((link) => link.polarity === 'neutral').length,
  };
}

/** Evidence the pack says this hypothesis needs, split into still missing and already collected. */
export function missingFor(
  hypothesis: Pick<Hypothesis, 'name'>,
  missing: readonly MissingEvidence[],
): { open: MissingEvidence[]; collected: MissingEvidence[] } {
  const needed = missing.filter((item) => item.neededFor.includes(hypothesis.name));
  return {
    open: needed.filter((item) => item.resolvedAt === null),
    collected: needed.filter((item) => item.resolvedAt !== null),
  };
}

export interface StatusChange {
  at: string;
  eventId: string;
  from: HypothesisStatus | null;
  to: HypothesisStatus;
  confidence: number;
  reason: string;
}

/** The moments a hypothesis was promoted or demoted: where its status differs from the previous point. */
export function statusChanges(timeline: readonly HypothesisPoint[]): StatusChange[] {
  const changes: StatusChange[] = [];
  let previous: HypothesisStatus | null = null;
  for (const point of timeline) {
    if (point.status !== previous) {
      changes.push({
        at: point.at,
        eventId: point.eventId,
        from: previous,
        to: point.status,
        confidence: point.confidence,
        reason: point.reason,
      });
    }
    previous = point.status;
  }
  return changes;
}

/** The newest point of the series (the state at the boundary). */
export const latestPoint = (hypothesis: Hypothesis): HypothesisPoint | null =>
  hypothesis.timeline[hypothesis.timeline.length - 1] ?? null;

/** Matches `?sel=` against a hypothesis record id or its knowledge-pack key (`hyp.dns-resolution`). */
export function findHypothesis(
  hypotheses: readonly Hypothesis[],
  selection: string | null,
): Hypothesis | undefined {
  if (!selection) return undefined;
  return hypotheses.find((h) => h.id === selection || h.key === selection);
}

// ---------------------------------------------------------------- the action ranking and its reviewer overrides

/** True when two ISO instants are the same moment (one may carry milliseconds, the other not). */
export function sameInstant(a: string, b: string): boolean {
  const left = Date.parse(a);
  return Number.isFinite(left) && left === Date.parse(b);
}

/** The overrides a ranking lists, newest decision first. The field is optional in the schema: absent means none. */
export const listedOverrides = (
  ranking: Pick<ActionRanking, 'reviewerOverrides'>,
): readonly ActionOverrideRecord[] => ranking.reviewerOverrides ?? [];

/**
 * True when no candidate is expected to add any information: every score is zero, so the list is not a recommendation
 * and must not be presented as one. A ranking without candidates is a different case (everything is blocked).
 */
export function hasNothingToRank(ranking: Pick<ActionRanking, 'candidates'>): boolean {
  return ranking.candidates.length > 0 && ranking.candidates.every((item) => item.score === 0);
}

export interface OverrideEntry {
  record: ActionOverrideRecord;
  /**
   * The machine's rank for the action in the ranking the override is about, known only when that ranking is the one on
   * screen (the response carries the machine rank of its own instant and no other). Otherwise null: it is not invented.
   */
  machineRank: number | null;
  /** True when the override is about the ranking on screen. */
  aboutThisRanking: boolean;
}

/** The listed overrides with what can be said about each next to the ranking on screen. Order is kept (newest decision first). */
export function overrideEntries(
  records: readonly ActionOverrideRecord[],
  ranking: Pick<ActionRanking, 'asOf' | 'candidates'>,
): OverrideEntry[] {
  return records.map((record) => {
    const aboutThisRanking = sameInstant(record.instant, ranking.asOf);
    const candidate = aboutThisRanking
      ? ranking.candidates.find((item) => item.actionKey === record.actionKey)
      : undefined;
    return { record, machineRank: candidate?.rank ?? null, aboutThisRanking };
  });
}

/**
 * The ranking with the override about its own instant on each candidate, taken from `records` where the response left it
 * out. A window hides a decision made after it, so the ranking just before a decision fork carries no inline override
 * even when a reviewer recorded one about it; the whole-record list has it. Used only where the page is the whole
 * record, never for an earlier view the person chose.
 */
export function withListedOverrides(
  ranking: ActionRanking,
  records: readonly ActionOverrideRecord[],
): ActionRanking {
  return {
    ...ranking,
    candidates: ranking.candidates.map((item) => {
      if (item.override) return item;
      const record = records.find(
        (entry) => entry.actionKey === item.actionKey && sameInstant(entry.instant, ranking.asOf),
      );
      return record
        ? {
            ...item,
            override: { rank: record.rank, reason: record.reason, by: record.by, at: record.at },
          }
        : item;
    }),
  };
}

/** What the "Next best action" panel shows: a ranking, which overrides it lists and whether it is an earlier view. */
export interface RankingView {
  /** The ranking on screen. Its candidates carry the override about their own instant, whichever response it came from. */
  ranking: ActionRanking;
  /** True for an earlier view the person chose with the time cursor: it only shows what was known by its moment. */
  windowed: boolean;
  /** The reviewer overrides to list, newest decision first. */
  overrides: readonly ActionOverrideRecord[];
  /** True when the ranking is the one at the case's last event. */
  atLastEvent: boolean;
  /** True when the case is resolved or closed (the last event then has nothing left to learn). */
  caseResolved: boolean;
  /** Set when the default ranking is the one just before the earliest meaningful decision fork, instead of the last event's. */
  decisionFork: { title: string; at: string } | null;
}

export interface CursorViewOptions {
  /** The page's time cursor: null is the whole record. */
  asOf: string | null;
  /** The case's last event instant, when known. */
  lastInstant: string | null;
  caseResolved: boolean;
}

/** The ranking the time cursor asks for: the whole record, or an earlier view that lists only what was known by then. */
export function cursorView(ranking: ActionRanking, options: CursorViewOptions): RankingView {
  const windowed = options.asOf !== null;
  const atLastEvent =
    options.lastInstant === null
      ? !windowed
      : Date.parse(ranking.asOf) >= Date.parse(options.lastInstant);
  return {
    ranking,
    windowed,
    overrides: listedOverrides(ranking),
    atLastEvent,
    caseResolved: options.caseResolved,
    decisionFork: null,
  };
}

/**
 * The default ranking of a resolved case: the last event has nothing left to rank, so the ranking just before the
 * earliest meaningful decision fork is shown instead. The page is still the whole record (the cursor is untouched), so
 * the list is the whole-record one and the candidates show the override recorded about this very ranking.
 */
export function decisionPointView(
  ranking: ActionRanking,
  whole: ActionRanking,
  fork: Pick<DecisionFork, 'title' | 'timestamp'>,
  caseResolved: boolean,
): RankingView {
  const overrides = listedOverrides(whole);
  return {
    ranking: withListedOverrides(ranking, overrides),
    windowed: false,
    overrides,
    atLastEvent: false,
    caseResolved,
    decisionFork: { title: fork.title, at: fork.timestamp },
  };
}
