import {
  PARTICIPANT_ROLE_LABELS,
  type CaseEvent,
  type Conflict,
  type ConflictClass,
  type ConflictSide,
  type StatementModality,
} from '@caseguard/schemas';
import type { CompiledPack } from '../knowledge/compile';
import { stableId } from '../util/ids';
import { readAttributes } from './attributes';
import { hedgeNear } from './modality';
import { eventText, type Observation } from './signals';
import { sourcePointerFor } from './source-ref';
import type { TemporalView } from './temporal';

/**
 * Conflicts in the record (wave 2): two statements of one case that cannot both stand, with both sides, where each came
 * from and what kind of disagreement it is. It reads only the events of the view it is given, so a conflict never
 * depends on anything said after the view's boundary.
 *
 * What it can see is limited to what the knowledge pack models: a signal pair (an incident is active / no incident is
 * active) stated from both sides, and an attribute of the case (how many users) stated with two values. A clash about
 * anything else is not found, and none of this is a reading of meaning: each conflict says which wording it rests on
 * and carries an uncertainty a reviewer can weigh. A sentence that does not state the fact (a denial, a plan, a
 * condition, a request) is not a side, and a summary written at the end of the case recounts how things were, so it is
 * not read as a later change of state.
 */

/** Events that sum the case up instead of observing it at their own time. */
const RECAP_EVENT_TYPES: ReadonlySet<string> = new Set(['resolution_note', 'status_change']);

export interface ConflictInput {
  view: TemporalView;
  pack: CompiledPack;
  caseId: string;
  /** The observations of the view, including the ones that read a denial as the other side of a pair. */
  observations: readonly Observation[];
}

/** A statement of one event about one subject: either side of a pair, or one value of an attribute. */
interface Statement {
  event: CaseEvent;
  eventIndex: number;
  subject: string;
  /** What this statement says, in words. */
  text: string;
  polarity: 'asserts' | 'denies';
  /** Which value or side it takes: the same for two statements that agree. */
  stance: string;
  modality: StatementModality;
  span: { field: 'title' | 'body' | 'titleAndBody'; start: number; end: number } | null;
  excerpt: string;
  /** What softens the statement ("seems", "probably"), or null. */
  hedge: string | null;
  /** The word that says the figure is rounded ("roughly", "about"), or null; only a figure has one. */
  approximate: string | null;
}

const roleOf = (event: CaseEvent): string =>
  PARTICIPANT_ROLE_LABELS[event.participantRole].toLowerCase();

const sideOf = (statement: Statement): ConflictSide => ({
  eventId: statement.event.id,
  participantRole: statement.event.participantRole,
  timestamp: statement.event.timestamp,
  statement: statement.text.slice(0, 300),
  subject: statement.subject.slice(0, 120),
  polarity: statement.polarity,
  modality: statement.modality,
  sourceRef: {
    eventId: statement.event.id,
    sourceId: statement.event.sourceId,
    pointer: sourcePointerFor(statement.event, statement.span?.field ?? null),
    ...(statement.span
      ? { field: statement.span.field, start: statement.span.start, end: statement.span.end }
      : {}),
    excerpt: statement.excerpt.slice(0, 600),
  },
});

interface Verdict {
  conflictClass: ConflictClass;
  favours: 'first' | 'second' | null;
  rule: string;
  because: string;
  level: 'low' | 'medium' | 'high';
}

/**
 * Which kind of disagreement two statements make. The first rule that applies decides:
 *  1. the later statement says it corrects the earlier one: `corrected_information`;
 *  2. either statement is hedged ("seems", "mostly"): `ambiguous_wording`;
 *  3. the same person made both: a changed state (`temporal_update`) when the subject can change, else a
 *     `direct_contradiction`;
 *  4. two people made them: `source_disagreement` when a later statement settles it (it takes one side), else
 *     `unresolved_conflict`.
 */
function judge(
  first: Statement,
  second: Statement,
  later: readonly Statement[],
  timeVarying: boolean,
): Verdict {
  if (second.modality === 'corrected') {
    return {
      conflictClass: 'corrected_information',
      favours: 'second',
      rule: 'correction-cue',
      because: 'The later statement is worded as a correction of what was said before.',
      level: 'low',
    };
  }
  const hedge = second.hedge ?? first.hedge;
  if (hedge !== null) {
    return {
      conflictClass: 'ambiguous_wording',
      favours: null,
      rule: 'hedged-wording',
      because: `One side is hedged (“${hedge}”), so the two may differ only in wording.`,
      level: 'high',
    };
  }
  if (first.event.participantId === second.event.participantId) {
    return timeVarying
      ? {
          conflictClass: 'temporal_update',
          favours: 'second',
          rule: 'same-source-later-state',
          because:
            'The same person later described a state that can change, so the later one is taken as the current state.',
          level: 'medium',
        }
      : {
          conflictClass: 'direct_contradiction',
          favours: null,
          rule: 'same-source-opposite',
          because: 'The same person stated both, about something that does not change with time.',
          level: 'medium',
        };
  }
  const last = later[later.length - 1];
  if (last !== undefined) {
    const side =
      last.stance === first.stance ? 'first' : last.stance === second.stance ? 'second' : null;
    if (side !== null) {
      return {
        conflictClass: 'source_disagreement',
        favours: side,
        rule: 'different-sources-settled',
        because: `Two people disagree, and the most recent statement (${roleOf(last.event)}) takes the ${side} side.`,
        level: 'medium',
      };
    }
  }
  return {
    conflictClass: 'unresolved_conflict',
    favours: null,
    rule: 'different-sources-open',
    because: 'Two people disagree and nothing later in the record settles it.',
    level: 'medium',
  };
}

/**
 * The id is derived from the pack's key for the pair or the attribute, so rewording a label does not rename a conflict;
 * the subject a reviewer reads is that label, the one both sides carry.
 */
function conflictOf(
  caseId: string,
  key: string,
  first: Statement,
  second: Statement,
  verdict: Verdict,
): Conflict {
  const when = (s: Statement): string => s.event.timestamp.slice(11, 16);
  return {
    id: stableId('cfl', caseId, key, first.event.id, second.event.id),
    class: verdict.conflictClass,
    subject: first.subject.slice(0, 120),
    sides: [sideOf(first), sideOf(second)],
    favours: verdict.favours,
    explanation: (
      `At ${when(first)} UTC the ${roleOf(first.event)} said: ${first.text}. ` +
      `At ${when(second)} UTC the ${roleOf(second.event)} said: ${second.text}. ${verdict.because}`
    ).slice(0, 400),
    uncertainty: {
      level: verdict.level,
      note: 'Found by reading the wording of the two statements; check them against the quoted source text.',
    },
    ruleId: verdict.rule,
  };
}

const order = (a: Statement, b: Statement): number => a.eventIndex - b.eventIndex;

/** Statements that say one side of a signal pair, from the observations of the view. */
function pairStatements(
  input: ConflictInput,
): Map<string, { timeVarying: boolean; list: Statement[] }> {
  const { view, pack, observations } = input;
  const byEvent = new Map(view.events.map((event) => [event.id, event]));
  const out = new Map<string, { timeVarying: boolean; list: Statement[] }>();
  for (const pair of pack.pack.signalPairs) {
    const list: Statement[] = [];
    for (const obs of observations) {
      const asserts = obs.signalId === pair.positive;
      if (!asserts && obs.signalId !== pair.negative) continue;
      const event = byEvent.get(obs.eventId);
      if (!event) continue;
      const signal = pack.signals.get(obs.signalId);
      const span =
        obs.field !== null && obs.start !== null && obs.end !== null
          ? { field: obs.field, start: obs.start, end: obs.end }
          : null;
      const text = eventText(event);
      list.push({
        event,
        eventIndex: obs.eventIndex,
        subject: pair.label,
        text: signal?.label ?? obs.signalId,
        polarity: asserts ? 'asserts' : 'denies',
        stance: asserts ? 'positive' : 'negative',
        modality: obs.modality,
        span,
        excerpt: obs.excerpt,
        hedge: obs.start !== null && obs.end !== null ? hedgeNear(text, obs.start, obs.end) : null,
        approximate: null,
      });
    }
    list.sort(order);
    out.set(pair.id, { timeVarying: pair.timeVarying, list });
  }
  return out;
}

/** Two statements of the same pair that take opposite sides, in event order, that follow one another. */
function pairConflicts(input: ConflictInput): Conflict[] {
  const out: Conflict[] = [];
  for (const [pairId, { timeVarying, list }] of pairStatements(input)) {
    for (let i = 1; i < list.length; i += 1) {
      const first = list[i - 1];
      const second = list[i];
      if (!first || !second || first.stance === second.stance) continue;
      if (first.event.id === second.event.id) continue;
      // A fault that is found and later reported fixed is the story of the case, not a conflict in it.
      if (timeVarying && first.stance === 'positive' && second.stance === 'negative') continue;
      // A summary written at the end recounts what was found and fixed; it does not say the state changed again.
      if (timeVarying && RECAP_EVENT_TYPES.has(second.event.type)) continue;
      const verdict = judge(first, second, list.slice(i + 1), timeVarying);
      out.push(conflictOf(input.caseId, pairId, first, second, verdict));
    }
  }
  return out;
}

/** `08:50` and `8:50` are one time; the figures the pack reads have no other written form. */
const stanceOf = (value: string): string => value.toLowerCase().replace(/^0+(?=\d)/, '');

/** What a customer states about the case in numbers (how many users), read with the pack's claim patterns. */
function attributeStatements(input: ConflictInput): Map<string, Statement[]> {
  const { view, pack } = input;
  const bySubject = new Map<string, Statement[]>();
  view.events.forEach((event, eventIndex) => {
    for (const read of readAttributes(event, pack)) {
      const { pattern, value } = read;
      const list = bySubject.get(pattern.subject) ?? [];
      list.push({
        event,
        eventIndex,
        subject: pattern.label,
        text: `${pattern.label}: ${value}`,
        polarity: 'asserts',
        stance: stanceOf(value),
        modality: read.modality,
        span: { field: 'body', start: read.start, end: read.end },
        excerpt: read.excerpt.replace(/\s+/g, ' ').slice(0, 280),
        hedge: read.hedge,
        approximate: read.approximate,
      });
      bySubject.set(pattern.subject, list);
    }
  });
  return bySubject;
}

/** How far apart two restated figures may be and still be one rounded figure: a quarter of a count, half an hour. */
const COUNT_TOLERANCE = 0.25;
const TIME_TOLERANCE_MINUTES = 30;

const minutesOf = (value: string): number | null => {
  const clock = /^(\d{1,2}):(\d{2})$/.exec(value);
  return clock ? Number(clock[1]) * 60 + Number(clock[2]) : null;
};

/** Whether two figures could be one figure said twice with different rounding ("about 140" and "around 150"). */
function couldBeRounded(a: string, b: string): boolean {
  const timeA = minutesOf(a);
  const timeB = minutesOf(b);
  if (timeA !== null && timeB !== null) return Math.abs(timeA - timeB) <= TIME_TOLERANCE_MINUTES;
  const countA = Number(a);
  const countB = Number(b);
  const larger = Math.max(countA, countB);
  if (!Number.isFinite(larger) || larger <= 0) return false;
  return Math.abs(countA - countB) / larger <= COUNT_TOLERANCE;
}

function attributeConflicts(input: ConflictInput): Conflict[] {
  const out: Conflict[] = [];
  for (const [subject, list] of attributeStatements(input)) {
    for (let i = 1; i < list.length; i += 1) {
      const first = list[i - 1];
      const second = list[i];
      if (!first || !second || first.stance === second.stance) continue;
      // "About 140" then "about 150" may be one rounded figure said twice; "about 45" then "120" is not.
      const rounded =
        (first.approximate !== null || second.approximate !== null) &&
        couldBeRounded(first.stance, second.stance);
      const sideOne = rounded ? { ...first, hedge: first.hedge ?? first.approximate } : first;
      const sideTwo = rounded ? { ...second, hedge: second.hedge ?? second.approximate } : second;
      // An attribute such as a user count moves as a case goes on, so the same person's later value is an update.
      const verdict = judge(sideOne, sideTwo, list.slice(i + 1), true);
      out.push(conflictOf(input.caseId, subject, sideOne, sideTwo, verdict));
    }
  }
  return out;
}

/** The conflicts in the view, earlier side first, ordered by the time of the later side. */
export function detectConflicts(input: ConflictInput): Conflict[] {
  return [...pairConflicts(input), ...attributeConflicts(input)].sort(
    (a, b) => a.sides[1].timestamp.localeCompare(b.sides[1].timestamp) || a.id.localeCompare(b.id),
  );
}
