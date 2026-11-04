import type { StatementModality } from '@caseguard/schemas';

/**
 * How a sentence stands to the fact its words mention (wave 2).
 *
 * A detector that finds the words of a signal or an action in a sentence still has to know whether the sentence states
 * the fact: "the engineer did not check the logs", "I will check the logs", "if the logs had been checked" and "the
 * customer said the logs were checked" all contain the words and none of them is a log check by the engineer. This
 * module answers that question for one span of text.
 *
 * It is deliberately small, deterministic and explainable, in the manner of NegEx: a fixed list of cue phrases, each
 * with a modality, a priority and a reach (how many words after the cue it still applies), cut short at the end of the
 * clause (a sentence end, a semicolon, a colon, a line break or a contrast word such as "but"). No model, no
 * statistics, no state; the cost is proportional to the length of the clause before the match. Every cue carries its
 * purpose and examples, and a test runs them, so the list cannot drift away from what it says it does.
 */

type Cued = Exclude<StatementModality, 'asserted'>;

export interface ModalityCue {
  /** Stable name, quoted in explanations and tests. */
  readonly id: string;
  readonly modality: Cued;
  /** Lower wins when several cues reach the same span. */
  readonly priority: number;
  /** The words of the cue, as one bounded expression (the `g` flag is added when it is compiled). */
  readonly pattern: RegExp;
  /** How many words may stand between the end of the cue and the span for the cue to reach it. */
  readonly reach: number;
  /** A subordinate clause ("if ..., ..."): the cue does not reach past a comma. */
  readonly stopsAtComma: boolean;
  readonly purpose: string;
  /** Sentences with the span in square brackets that the cue must decide. */
  readonly fires: readonly string[];
  /** Look-alikes with the span in square brackets that the cue must NOT decide. */
  readonly quiet: readonly string[];
}

/** A cue that denies a fact is not a cue when it is the first half of "cannot rule out", "not only" or "do not forget". */
const RULE_OUT = String.raw`(?:yet\s+)?(?:rule|exclude|dismiss|discount)\b`;

const CUE_DEFINITIONS: readonly ModalityCue[] = [
  {
    id: 'cannot-rule-out',
    modality: 'speculative',
    priority: 1,
    pattern: new RegExp(
      String.raw`\b(?:cannot|can['’]t|couldn['’]t|can\s+not|could\s+not)\s+${RULE_OUT}`,
      'i',
    ),
    reach: 6,
    stopsAtComma: false,
    purpose:
      'A denial of the denial: the writer keeps a possibility open, which is a guess and not a finding.',
    fires: ['We cannot rule out [a DNS fault] yet.'],
    quiet: ['We can [rule out DNS] now.'],
  },
  {
    id: 'not-sure',
    modality: 'speculative',
    priority: 2,
    pattern:
      /\b(?:not\s+sure|unsure|uncertain|no\s+idea|(?:don['’]t|do\s+not)\s+know|wonder(?:ing)?)\s+(?:if|whether)\b/i,
    reach: 4,
    stopsAtComma: false,
    purpose: 'The writer says they do not know whether it holds.',
    fires: ['I am not sure whether [the proxy is involved].'],
    quiet: ['I am not sure about the date, but [the proxy is failing].'],
  },
  {
    id: 'condition',
    modality: 'conditional',
    priority: 3,
    pattern:
      /\bif\b(?!\s+(?:possible|needed|necessary|required|appropriate|convenient|applicable|you\s+(?:can|could|would|are\s+able|don['’]t\s+mind|wish|like|prefer|have\s+time)|it\s+is\s+(?:possible|ok|okay|fine)))|\b(?:unless|provided\s+that|assuming|supposing)\b|\bin\s+case\b(?!\s+of\b)/i,
    reach: 12,
    stopsAtComma: true,
    purpose:
      'The clause depends on a condition, so what it describes is not stated as having happened.',
    fires: [
      'If [the logs had been checked], the cause would be known.',
      'Unless [the cache is cleared], the failure remains.',
    ],
    quiet: ['Please send the HAR capture if possible, and [the logs] too.'],
  },
  {
    id: 'counterfactual',
    modality: 'conditional',
    priority: 3,
    pattern:
      /\b(?:would|could|might|should)\s+(?:also\s+)?have\b|\bhad\s+(?:we|you|they|i|he|she|it)\s+(?:been|checked|done|made|run|looked|tried|known)\b/i,
    reach: 10,
    stopsAtComma: false,
    purpose: 'Something that did not happen, described as it would have been.',
    fires: ['The engineer would have [checked the logs] first.'],
    quiet: ['They have [checked the logs].'],
  },
  {
    id: 'negation-verb',
    modality: 'negated',
    priority: 4,
    pattern: new RegExp(
      [
        String.raw`\b(?:not|never)\b(?!\s+(?:only|forget)\b)`,
        String.raw`\bcannot\b(?!\s+${RULE_OUT})`,
        String.raw`\b[a-z]+n['’]t\b(?!\s+${RULE_OUT})`,
      ].join('|'),
      'i',
    ),
    reach: 5,
    stopsAtComma: true,
    purpose:
      'The writer denies what the verb phrase after it says: it did not happen or is not so. The denial ends at a comma, so an adjunct after it is not denied with it.',
    fires: [
      'The engineer did not [check the logs].',
      "Don't [clear the cache] yet.",
      'This is not [intermittent].',
    ],
    quiet: [
      'This is not only [a DNS problem] but also a proxy problem.',
      'Users cannot sign in, about [300 users] so far.',
    ],
  },
  {
    id: 'negation-quantifier',
    modality: 'negated',
    priority: 4,
    pattern:
      /\b(?:none|nothing|nobody|neither|nor|without)\b|\bno\b(?!\s+(?:problem|worries|matter|idea)\b)/i,
    reach: 4,
    stopsAtComma: false,
    purpose:
      'The writer says there is none of it: no, nothing, none, without. It reaches over a short list ("no DNS, proxy or CA issues").',
    fires: [
      'No [log review] was performed.',
      'The logs show no evidence of [a token issue].',
      'They signed in without [any problem].',
      'Service health lists nothing [active].',
      'No DNS, proxy or [CA issues] found.',
    ],
    quiet: [
      'No problem, [the logs] are attached.',
      'Muitos utilizadores bloqueados no Teams, in all offices, more than [100 people].',
    ],
  },
  {
    id: 'guess',
    modality: 'speculative',
    priority: 5,
    pattern:
      /\b(?:might|maybe|perhaps|possibly|probably|presumably|supposedly|conceivably|potentially)\b|\bmay\s+(?:be|well|have|also)\b|\bcould\s+(?:also\s+)?(?:be|have\s+been|indicate|point|explain|mean)\b|\b(?:i|we)\s+(?:suspect|guess|assume|suppose|speculate)\b|\b(?:suspect(?:s|ed)?|suspicion)\b|\bhypothes(?:is|e|ise|ize)\b|\blikely\s+(?:a|an|the|due|caused|because|related)\b/i,
    reach: 8,
    stopsAtComma: false,
    purpose: 'A guess or hypothesis, not an observation.',
    fires: ['It might be [a DNS issue].', 'I suspect [the proxy] is to blame.'],
    quiet: ['It seems that [the proxy times out].'],
  },
  {
    id: 'request',
    modality: 'requested',
    priority: 6,
    pattern:
      /\bplease\b(?!\s+(?:note|be\s+aware|find|see|refer|accept|advise))|\bkindly\b|\b(?:could|can|would|will|shall)\s+you\b|\b(?:could|can|would)\s+(?:your|the)\s+\w+\s+(?:team|admin)\b|\b(?:i|we)\s+(?:need|would\s+like|want|ask|request|require)\s+(?:you|your|the\s+\w+\s+to)\b|\b(?:you|your\s+\w+)\s+(?:need|should|must|have)\s+to\b|\bmake\s+sure\b|\bdo\s+not\s+forget\b|\blet\s+me\s+know\b|\bwould\s+be\s+(?:great|helpful|good|useful)\s+if\b/i,
    reach: 8,
    stopsAtComma: false,
    purpose: 'The writer asks for it; the asking is real, what is asked for has not happened yet.',
    fires: ['Please [send a HAR capture].', 'Could you [clear the Teams cache]?'],
    quiet: ['Please note that [users are signed out hourly].'],
  },
  {
    id: 'intention',
    modality: 'future_intent',
    priority: 7,
    pattern:
      /\b(?:will|shall)\b(?!\s+not\b)|\b(?:going\s+to|gonna|plans?\s+to|planned\s+to|planning\s+to|intend(?:s|ed)?\s+to|about\s+to|propos(?:e|es|ed)\s+to)\b|\b(?:i|we)['’]ll\b|\blet(?:['’]s|\s+us|\s+me)\b|\bnext\s+(?:step|up)\b|\bto\s+be\s+(?:checked|reviewed|done|confirmed|verified|tested)\b/i,
    reach: 8,
    stopsAtComma: false,
    purpose: 'Intended or planned, not done.',
    fires: ['I will [check the logs] tomorrow.', 'The engineer planned to [check the logs].'],
    quiet: ['The engineer [checked the logs] yesterday.'],
  },
  {
    id: 'reported-by-someone',
    modality: 'attributed',
    priority: 8,
    pattern:
      /\b(?:said|says|saying|claimed|claims|stated|states|mentioned|mentions|reported|reports|wrote|writes|insisted|insists|told\s+(?:us|me|them))\b|\baccording\s+to\b|\b(?:apparently|allegedly|reportedly)\b/i,
    reach: 10,
    stopsAtComma: false,
    purpose: 'Reported on someone else’s authority, not observed by the writer.',
    fires: ['The customer said [the logs were checked].'],
    quiet: ['[The logs were checked] by the engineer.'],
  },
  {
    id: 'correction',
    modality: 'corrected',
    priority: 9,
    pattern:
      /\bcorrection\b|\bcorrected\b|\bscratch\s+that\b|\bmy\s+mistake\b|\bi\s+was\s+wrong\b|\bi\s+meant\b|\bignore\s+(?:my|the)\s+(?:previous|earlier|last)\b/i,
    reach: 12,
    stopsAtComma: false,
    purpose: 'Replaces an earlier statement; what follows is the writer’s current position.',
    fires: ['Correction: [the proxy was changed on Tuesday].'],
    quiet: ['[The proxy was changed on Tuesday].'],
  },
];

interface CompiledCue extends ModalityCue {
  /** `pattern` with the global flag, for scanning every occurrence in the text before a span. */
  readonly scan: RegExp;
}

export const MODALITY_CUES: readonly ModalityCue[] = CUE_DEFINITIONS;

const CUES: readonly CompiledCue[] = [...CUE_DEFINITIONS]
  .sort((a, b) => a.priority - b.priority)
  .map((cue) => ({
    ...cue,
    scan: new RegExp(
      cue.pattern.source,
      cue.pattern.flags.includes('g') ? cue.pattern.flags : `${cue.pattern.flags}g`,
    ),
  }));

export interface ModalityAssessment {
  readonly modality: StatementModality;
  /** The cue that decided it; null when no cue reaches the span, which makes the span a statement of fact. */
  readonly cueId: string | null;
  /** The words of the cue, as written. */
  readonly cue: string | null;
}

export const ASSERTED: ModalityAssessment = { modality: 'asserted', cueId: null, cue: null };

/** How far before a span the search for a cue and for the start of its clause goes. */
const LOOKBACK_CHARS = 200;
/** The longest stretch of the span itself that is searched for cues. */
const MAX_SPAN_CHARS = 400;

/** Where a clause ends: a line break, a semicolon, a sentence end or colon followed by space, or a contrast word. */
const CLAUSE_BOUNDARY =
  /[\n;]|[.!?:](?=\s|$)|\b(?:but|however|although|though|whereas|except|which)\b/gi;
const ABBREVIATIONS: ReadonlySet<string> = new Set([
  'e.g',
  'i.e',
  'etc',
  'vs',
  'approx',
  'incl',
  'inc',
  'ltd',
  'dr',
  'mr',
  'mrs',
  'ms',
  'no',
]);

const LABEL_WORDS: ReadonlySet<string> = new Set([
  'correction',
  'corrected',
  'update',
  'edit',
  'clarification',
  'amendment',
  'addendum',
  'erratum',
]);

/**
 * Where the clause that ends at `limit` starts. `probe` is the text up to `limit` plus the character that follows it, so
 * that a full stop right before the span is judged by what really follows it (the span), not by the end of the slice.
 */
function clauseStartIn(probe: string, limit: number): number {
  let start = 0;
  for (const boundary of probe.matchAll(CLAUSE_BOUNDARY)) {
    const index = boundary.index ?? 0;
    const mark = boundary[0] ?? '';
    if (index + mark.length > limit) break;
    if (mark === '.') {
      const word = /([A-Za-z][A-Za-z.]*)$/.exec(probe.slice(Math.max(0, index - 8), index));
      if (word?.[1] && ABBREVIATIONS.has(word[1].toLowerCase())) continue;
    }
    // "Correction: the proxy was changed" is one clause: the label belongs to what follows it.
    if (mark === ':') {
      const label = /([A-Za-z]+)$/.exec(probe.slice(Math.max(0, index - 14), index));
      if (label?.[1] && LABEL_WORDS.has(label[1].toLowerCase())) continue;
    }
    start = index + mark.length;
  }
  return start;
}

/** The text of the clause before a span, from its start to the span. */
function clauseBefore(text: string, start: number): string {
  const from = Math.max(0, start - LOOKBACK_CHARS);
  const lead = text.slice(from, start);
  return lead.slice(clauseStartIn(text.slice(from, start + 1), lead.length));
}

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
const wordsIn = (text: string): number => text.match(WORD)?.length ?? 0;

export interface AssessOptions {
  /**
   * The detector is built to match a denial ("no active incident"): the negations inside its own match are what it
   * looks for, so they must not count against it. Cues before the match still do.
   */
  readonly negativeContent?: boolean;
}

/**
 * "If you wait and try again it sometimes goes through" states a habit, not a hypothesis: a frequency word next to the
 * span makes the "if" a description of how things usually go.
 */
const HABITUAL =
  /\b(?:sometimes|often|usually|always|occasionally|normally|typically|every time|each time|now and then|again and again)\b/i;
const isHabitual = (text: string, start: number, end: number): boolean =>
  HABITUAL.test(text.slice(Math.max(0, start - 30), Math.min(end, start + 40)));

/** The first cue, by priority, that reaches the span `[start, end)` of `text`; asserted when none does. */
export function assessModality(
  text: string,
  start: number,
  end: number,
  options: AssessOptions = {},
): ModalityAssessment {
  const before = clauseBefore(text, start);
  const inside = options.negativeContent
    ? ''
    : text.slice(start, Math.min(end, start + MAX_SPAN_CHARS));

  for (const cue of CUES) {
    if (cue.id === 'condition' && isHabitual(text, start, end)) continue;
    if (inside !== '') {
      const hit = cue.pattern.exec(inside);
      if (hit) return { modality: cue.modality, cueId: cue.id, cue: hit[0] ?? null };
    }
    if (before === '') continue;
    let nearest: RegExpMatchArray | null = null;
    // `matchAll` works on its own copy of the expression, so nothing is shared between calls.
    for (const hit of before.matchAll(cue.scan)) {
      const mark = hit[0] ?? '';
      if (mark === '') continue;
      const gap = before.slice((hit.index ?? 0) + mark.length);
      if (cue.stopsAtComma && gap.includes(',')) continue;
      if (wordsIn(gap) > cue.reach) continue;
      nearest = hit;
    }
    if (nearest) return { modality: cue.modality, cueId: cue.id, cue: nearest[0] ?? null };
  }
  return ASSERTED;
}

const HEDGE =
  /\b(?:seems?|seemed|appears?|appeared|looks?\s+like|apparently|i\s+think|i\s+believe|sort\s+of|kind\s+of|partly|partially|mostly|mainly|somewhat|more\s+or\s+less)\b/gi;
const HEDGE_REACH = 5;

/**
 * The hedge ("seems", "mostly", "I think") that softens the statement the span makes, or null. A hedged statement is
 * still stated, so it fires; the hedge only says that a clash with another statement may be a difference of wording.
 */
export function hedgeNear(text: string, start: number, end: number): string | null {
  const before = clauseBefore(text, start);
  let found: string | null = null;
  for (const hit of before.matchAll(HEDGE)) {
    const mark = hit[0] ?? '';
    if (wordsIn(before.slice((hit.index ?? 0) + mark.length)) <= HEDGE_REACH) found = mark;
  }
  if (found !== null) return found;
  const inside = text.slice(start, Math.min(end, start + MAX_SPAN_CHARS));
  const hit = inside.matchAll(HEDGE).next();
  return hit.done ? null : (hit.value[0] ?? null);
}

/** What a detector is used for decides which modalities let it fire. */
export type DetectionUse = 'signal' | 'requirement' | 'action' | 'delegated_action' | 'attribute';

const FIRES_ON: Readonly<Record<DetectionUse, ReadonlySet<StatementModality>>> = {
  // A fact the writer states, one reported from a customer, or a correction of an earlier statement.
  signal: new Set<StatementModality>(['asserted', 'attributed', 'corrected']),
  requirement: new Set<StatementModality>(['asserted', 'attributed', 'corrected']),
  // A step the engineer took: not one that was planned, denied, imagined or only reported by someone else.
  action: new Set<StatementModality>(['asserted', 'corrected']),
  // A step the customer takes at the engineer's request: the request in the engineer's message is the action in the record.
  delegated_action: new Set<StatementModality>([
    'asserted',
    'corrected',
    'requested',
    'future_intent',
  ]),
  // A figure or a time the customer gives ("140 users", "since 08:50"). A guess is still a figure the customer gave, and
  // is read as softened; a denial ("no tickets since 11:45"), a plan, a condition or a request is not a figure given.
  attribute: new Set<StatementModality>(['asserted', 'attributed', 'corrected', 'speculative']),
};

export const firesFor = (use: DetectionUse, modality: StatementModality): boolean =>
  FIRES_ON[use].has(modality);

// ---------------------------------------------------------------- quoted history

const QUOTE_BEARING_TYPES: ReadonlySet<string> = new Set([
  'customer_email',
  'engineer_email',
  'escalation_response',
]);

/** A line that opens the earlier message an email quotes below it. */
const HISTORY_MARKER =
  /^[ \t]*(?:-{2,}[ \t]*(?:original|forwarded)\s+message[ \t]*-{2,}|on\s.{10,200}\swrote:|_{8,})[ \t\r]*$/i;
const QUOTED_LINE = /^[ \t]*>/;

/**
 * The text with the earlier messages an email quotes blanked out, character for character, so that offsets into it
 * are offsets into the stored text. A quoted reply is not the writer's statement (and the original event already
 * holds it), so detectors must not read it again as the sender's own words.
 */
export function maskQuotedHistory(text: string, eventType: string): string {
  if (
    !QUOTE_BEARING_TYPES.has(eventType) ||
    (!text.includes('>') && !/message|wrote:|_{8}/i.test(text))
  )
    return text;
  const lines = text.split('\n');
  let inHistory = false;
  let changed = false;
  const masked = lines.map((line) => {
    if (!inHistory && HISTORY_MARKER.test(line)) inHistory = true;
    if (inHistory || QUOTED_LINE.test(line)) {
      changed = true;
      return line.replace(/[^\r]/g, ' ');
    }
    return line;
  });
  return changed ? masked.join('\n') : text;
}
