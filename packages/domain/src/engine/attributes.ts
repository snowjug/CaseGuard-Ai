import type { CaseEvent, StatementModality } from '@caseguard/schemas';
import type { CompiledPack } from '../knowledge/compile';
import { isCustomerSide } from './context';
import { assessModality, firesFor, hedgeNear, maskQuotedHistory } from './modality';
import { MAX_SCAN_CHARS } from './signals';

/**
 * What a customer states about the case in figures and times ("140 users", "since 08:50"), read with the claim patterns
 * of the knowledge pack. The evidence ledger and the conflict finder both read attributes through here, so a statement
 * that one of them counts is counted by the other, and one that neither should count (a denial such as "no sign-in
 * tickets since 11:45", a plan, a condition, a request, a quotation of an earlier message) is counted by neither.
 */

export type AttributePattern = CompiledPack['claimPatterns'][number];

export interface AttributeStatement {
  pattern: AttributePattern;
  value: string;
  /** Offsets into the stored body: the text read has the quoted earlier messages blanked, character for character. */
  start: number;
  end: number;
  /** The words that matched, as written. */
  excerpt: string;
  modality: StatementModality;
  /** What softens the statement ("seems", "probably"), or null. */
  hedge: string | null;
  /** The word that says the figure is rounded ("roughly", "about"), or null. A restated figure may be the same one. */
  approximate: string | null;
}

/** A pattern is looked for this many times in one event, so that an early denial cannot hide a later statement. */
const MAX_MATCHES_PER_PATTERN = 5;
/** How far before a figure an approximating word may stand and still be about it. */
const APPROXIMATOR_REACH = 20;
const MAX_MATCH_SCAN = 200;

const APPROXIMATE = String.raw`(?:roughly|about|around|approximately|approx\.?|nearly|almost|circa|~)`;
const JUST_BEFORE = new RegExp(String.raw`(?:^|[^\p{L}])(${APPROXIMATE})\s*$`, 'iu');
const INSIDE = new RegExp(String.raw`(?:^|[^\p{L}])(${APPROXIMATE})(?![\p{L}])`, 'iu');

/** "roughly 140 users", "since about 08:50": the word that makes a figure an estimate. */
function approximation(text: string, start: number, end: number): string | null {
  const before = JUST_BEFORE.exec(text.slice(Math.max(0, start - APPROXIMATOR_REACH), start));
  if (before?.[1]) return before[1];
  return INSIDE.exec(text.slice(start, Math.min(end, start + MAX_MATCH_SCAN)))?.[1] ?? null;
}

// `matchAll` needs the global flag and works on its own copy, so one shared copy per pattern holds no state.
const globalCopies = new WeakMap<RegExp, RegExp>();
function globally(regex: RegExp): RegExp {
  let copy = globalCopies.get(regex);
  if (copy === undefined) {
    copy = regex.flags.includes('g') ? regex : new RegExp(regex.source, `${regex.flags}g`);
    globalCopies.set(regex, copy);
  }
  return copy;
}

/**
 * The attribute statements one event makes, at most one per pattern: the first match the sentence actually states.
 * Only customer-side events state attributes of the case.
 */
export function readAttributes(event: CaseEvent, pack: CompiledPack): AttributeStatement[] {
  if (!isCustomerSide(event.participantRole)) return [];
  const text = maskQuotedHistory(event.body, event.type).slice(0, MAX_SCAN_CHARS);
  const out: AttributeStatement[] = [];
  for (const pattern of pack.claimPatterns) {
    if (pattern.subject === 'root_cause') continue;
    if (pattern.roles && !pattern.roles.includes(event.participantRole)) continue;
    if (pattern.eventTypes && !pattern.eventTypes.includes(event.type)) continue;
    let looked = 0;
    for (const match of text.matchAll(globally(pattern.regex))) {
      looked += 1;
      if (looked > MAX_MATCHES_PER_PATTERN) break;
      const value = match[pattern.valueGroup]?.trim();
      if (!value) continue;
      const start = match.index;
      const end = start + match[0].length;
      const read = assessModality(text, start, end);
      if (!firesFor('attribute', read.modality)) continue;
      out.push({
        pattern,
        value,
        start,
        end,
        excerpt: match[0],
        modality: read.modality,
        hedge: hedgeNear(text, start, end) ?? (read.modality === 'speculative' ? read.cue : null),
        approximate: approximation(text, start, end),
      });
      break;
    }
  }
  return out;
}
