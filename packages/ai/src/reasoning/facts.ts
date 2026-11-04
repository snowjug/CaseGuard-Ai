import {
  compareIso,
  type CompiledPack,
  type DeterministicAnalysis,
  type TemporalView,
} from '@caseguard/domain';
import type {
  Conflict,
  ForkCategory,
  HypothesisStatus,
  Level,
  StatementModality,
} from '@caseguard/schemas';
import { likelihoodLevel } from '../context/derive';
import { containment, contentWords } from '../util/text';
import { normaliseExcerpt } from './text';

/**
 * What the deterministic engine concluded, as plain data the policy can read. The API fills it from the stored
 * analysis; `deterministicFactsOf` does the same from an analysis in memory. It carries ids and short labels only: no
 * record text. Nothing in `packages/ai` writes to it.
 */

/** Where an event stands in the case: ordered by time, then by sequence. */
export interface Stamp {
  at: string;
  sequence: number;
}

export interface SignalFact {
  /** The engine's observation id. */
  id: string;
  signalId: string;
  eventId: string;
  /**
   * How the engine reads the statement: asserted, attributed (reported from someone else) or corrected, because the other
   * modalities (a denial, a guess, a plan, a condition, a request) never become observations. Null when the facts come
   * from a source that does not say.
   */
  modality: StatementModality | null;
}

export interface ActionFact {
  /** The engine's record id of the action. */
  id: string;
  /** The pack action it recognised, or null for an action the pack does not name. */
  actionId: string | null;
  eventId: string;
  label: string;
}

export interface ForkFact {
  id: string;
  category: ForkCategory;
  eventId: string;
  title: string;
  /** The alternatives the engine listed at this decision (pack action ids and labels). */
  alternativeActionIds: string[];
  alternativeLabels: string[];
}

export interface RequirementFact {
  requirementId: string;
  /** The engine's record id. */
  id: string;
  label: string;
  criticality: 'critical' | 'important' | 'helpful';
  /** The first moment the requirement mattered. */
  firstRelevantAt: string;
  /** When it was met, and by which event; both null while it is unmet. */
  resolvedAt: string | null;
  resolvedByEventId: string | null;
}

export interface HypothesisFact {
  hypothesisId: string;
  name: string;
  /** 1 for the leading hypothesis. */
  rank: number;
  status: HypothesisStatus;
  confidence: number;
  level: Level;
}

export interface RecommendationFact {
  id: string;
  actionId: string | null;
  label: string;
  /** The events the recommendation rests on. */
  eventIds: string[];
}

export interface CounterfactualFact {
  id: string;
  forkEventId: string;
  alternativeActionIds: string[];
  label: string;
}

export interface DeterministicFacts {
  eventOrder: Record<string, Stamp>;
  signals: SignalFact[];
  actions: ActionFact[];
  forks: ForkFact[];
  requirements: RequirementFact[];
  hypotheses: HypothesisFact[];
  recommendations: RecommendationFact[];
  counterfactuals: CounterfactualFact[];
  /**
   * The conflicts the engine found, or null when the facts come from a source that does not carry them (the policy works
   * without them). An empty list means it looked and found none.
   */
  conflicts: Conflict[] | null;
  /**
   * Signals the pack pairs with their denial, by signal id (symmetric). A statement of one side at an event is a
   * statement against the other side at that event.
   */
  signalCounterparts: Record<string, string[]>;
}

/** Facts the analysis does not carry. */
export interface FactsExtras {
  /** The pack the analysis ran with: its signal pairs give the counterparts of a signal. */
  pack?: Pick<CompiledPack, 'signalPairs'>;
  counterfactuals?: readonly CounterfactualFact[];
}

const MAX_RECOMMENDING_HYPOTHESES = 3;

/** Restricts the facts to what was known inside a view: nothing about a later event, and no outcome only a later event shows. */
export interface FactsScope {
  view: TemporalView;
}

/**
 * The facts of an analysis. Pure: the analysis is only read, and the result holds copies, so changing the facts can
 * never change the analysis, and the policy cannot either. With a `scope`, the facts are those of the engine at the
 * boundary of that view (a pre-resolution review never sees later events, and the engine's items that rest on them are
 * left out): items about later events are dropped, a requirement met by a later event reads as unmet, and a hypothesis
 * stands where its timeline stood at the boundary.
 */
export function deterministicFactsOf(
  analysis: DeterministicAnalysis,
  extras: FactsExtras = {},
  scope?: FactsScope,
): DeterministicFacts {
  const view = scope?.view ?? analysis.view;
  const inView = new Set(view.events.map((e) => e.id));
  const known = (eventId: string): boolean => inView.has(eventId);
  const relevantBy = (iso: string): boolean => {
    const cmp = compareIso(iso, view.asOf);
    return view.mode === 'before' ? cmp < 0 : cmp <= 0;
  };

  const eventOrder: Record<string, Stamp> = {};
  for (const event of view.events) {
    eventOrder[event.id] = { at: event.timestamp, sequence: event.sequence };
  }

  const signals: SignalFact[] = analysis.observations
    .filter((o) => known(o.eventId))
    .map((o) => ({
      id: o.id,
      signalId: o.signalId,
      eventId: o.eventId,
      modality: o.modality,
    }));

  const actions: ActionFact[] = analysis.actions
    .filter((a) => known(a.eventId))
    .map((a) => ({
      id: a.id,
      actionId: a.actionKey,
      eventId: a.eventId,
      label: a.label,
    }));

  const visibleForks = analysis.forks.filter((f) => known(f.eventId));
  const forks: ForkFact[] = visibleForks.map((f) => ({
    id: f.id,
    category: f.category,
    eventId: f.eventId,
    title: f.title,
    alternativeActionIds: f.alternatives.map((alt) => alt.actionKey),
    alternativeLabels: f.alternatives.map((alt) => alt.label),
  }));

  const visibleMissing = analysis.missing
    .filter((m) => relevantBy(m.firstRelevantAt))
    .map((m) => {
      const metInView = m.resolvedByEventId !== null && known(m.resolvedByEventId);
      return {
        ...m,
        resolvedAt: metInView ? m.resolvedAt : null,
        resolvedByEventId: metInView ? m.resolvedByEventId : null,
      };
    });
  const requirements: RequirementFact[] = visibleMissing.map((m) => ({
    requirementId: m.requirementId,
    id: m.id,
    label: m.label,
    criticality: m.criticality,
    firstRelevantAt: m.firstRelevantAt,
    resolvedAt: m.resolvedAt,
    resolvedByEventId: m.resolvedByEventId,
  }));

  // Where each hypothesis stood at the boundary: the last point of its timeline inside the view.
  const standing = analysis.hypotheses.map((h) => {
    const inside = h.timeline.filter((p) => known(p.eventId));
    const complete = inside.length === h.timeline.length;
    const last = inside[inside.length - 1];
    return {
      h,
      last,
      complete,
      confidence: complete ? h.currentConfidence : (last?.confidence ?? h.prior),
      status: complete ? h.currentStatus : (last?.status ?? ('active' as const)),
    };
  });
  const ranked = [...standing].sort(
    (a, b) => b.confidence - a.confidence || a.h.key.localeCompare(b.h.key),
  );
  const hypotheses: HypothesisFact[] = ranked.map((entry, i) => ({
    hypothesisId: entry.h.key,
    name: entry.h.name,
    rank: i + 1,
    status: entry.status,
    confidence: entry.confidence,
    level: likelihoodLevel(entry.confidence),
  }));

  const recommendations: RecommendationFact[] = [];
  for (const { h, last, complete } of ranked.slice(0, MAX_RECOMMENDING_HYPOTHESES)) {
    if (h.cheapestSafeAction === null) continue;
    // The final advice is the boundary's advice only when the timeline had already arrived at it.
    if (!complete && last?.cheapestSafeActionKey !== h.cheapestSafeAction.actionKey) continue;
    recommendations.push({
      id: `hypothesis:${h.key}`,
      actionId: h.cheapestSafeAction.actionKey,
      label: h.cheapestSafeAction.label,
      eventIds: last ? [last.eventId] : [],
    });
  }
  for (const f of visibleForks) {
    const best = f.alternatives.find((alt) => alt.safe);
    if (!best) continue;
    recommendations.push({
      id: `fork:${f.id}`,
      actionId: best.actionKey,
      label: best.label,
      eventIds: [f.eventId, ...f.informationAvailable.eventIds.filter(known).slice(-3)],
    });
  }
  for (const m of visibleMissing) {
    if (m.resolvedAt !== null || m.criticality === 'helpful') continue;
    recommendations.push({
      id: `requirement:${m.id}`,
      actionId: null,
      label: m.askText,
      eventIds: [],
    });
  }

  return structuredClone({
    eventOrder,
    signals,
    actions,
    forks,
    requirements,
    hypotheses,
    recommendations,
    counterfactuals: (extras.counterfactuals ?? []).filter((c) => known(c.forkEventId)),
    conflicts: analysis.conflicts.filter((c) => c.sides.every((side) => known(side.eventId))),
    signalCounterparts: counterpartsOf(extras.pack),
  });
}

function counterpartsOf(pack: FactsExtras['pack']): Record<string, string[]> {
  const counterparts: Record<string, string[]> = {};
  for (const [signalId, link] of pack?.signalPairs ?? [])
    counterparts[signalId] = [link.counterpart];
  return counterparts;
}

// ---------------------------------------------------------------- reading the facts

/** True when `a` came strictly before `b`. An event the facts do not know is never before anything. */
export function isBefore(facts: DeterministicFacts, a: string, b: string): boolean {
  const x = facts.eventOrder[a];
  const y = facts.eventOrder[b];
  if (!x || !y) return false;
  const dt = Date.parse(x.at) - Date.parse(y.at);
  return dt !== 0 ? dt < 0 : x.sequence < y.sequence;
}

/** True when `a` is `b` or came before it. */
export const isAtOrBefore = (facts: DeterministicFacts, a: string, b: string): boolean =>
  a === b || isBefore(facts, a, b);

/**
 * The requirements that mattered and were still unmet at the moment of an event (before it happened): relevant by then,
 * and not met by an event strictly before it.
 */
export function unmetRequirementsAt(facts: DeterministicFacts, eventId: string): RequirementFact[] {
  const at = facts.eventOrder[eventId];
  if (!at) return [];
  return facts.requirements.filter((r) => {
    if (Date.parse(r.firstRelevantAt) > Date.parse(at.at)) return false;
    return r.resolvedByEventId === null || !isBefore(facts, r.resolvedByEventId, eventId);
  });
}

/**
 * True when a text names a label or an id: it contains the label (or the id), or (for a label of at least two content
 * words) it carries at least three quarters of the label's content words. Case and spacing do not matter.
 */
export function mentions(text: string, label: string, id: string | null = null): boolean {
  const haystack = normaliseExcerpt(text).toLowerCase();
  if (id !== null && haystack.includes(id.toLowerCase())) return true;
  const needle = normaliseExcerpt(label).toLowerCase();
  if (needle !== '' && haystack.includes(needle)) return true;
  const words = new Set(contentWords(label));
  return words.size >= 2 && containment(words, new Set(contentWords(text))) >= 0.75;
}
