import type { AnyProposal } from '@caseguard/schemas';
import { collectProposalTexts } from '../text';
import type { ProposalIssue } from '../types';

const WORD_NUMBER =
  'a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|ninety|hundred';
const NUMBER = String.raw`(?:\d+(?:[.,]\d+)?|\bhalf\s+an?\b|\b(?:${WORD_NUMBER})\b)`;
const UNIT = String.raw`(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?)`;
/** A number of time units ("3 hours", "two days", "90-minute") or a share ("40%", "twenty percent"). */
const QUANTITY = String.raw`(?:${NUMBER}[\s-]*${UNIT}\b|${NUMBER}\s*(?:%|percent\b|per\s+cent\b))`;
const SAVE = String.raw`sav(?:e|ed|es|ing|ings)`;
const REDUCE = String.raw`(?:reduc(?:e|ed|es|ing|tion)|shorten(?:ed|s|ing)?|decreas(?:e|ed|es|ing)|cut(?:s|ting)?)`;
const AVOID = String.raw`(?:avoid(?:ed|s|ing)?|eliminat(?:e|ed|es|ing))`;
/** What a saving is about. "Reduce the log window to 24 hours" is advice about a window, not a claim about time saved. */
const TIME_NOUN =
  /\b(?:time|delay|wait(?:ing)?|duration|resolution|turnaround|downtime|effort|handling|investigation|diagnosis|outage)\b/i;
const MODAL = /\b(?:would|could|might|may|can|should|likely|probably|potentially|possibly)\b/i;

const q = (source: string): RegExp => new RegExp(source, 'i');
const SAVED_QUANTITY = q(String.raw`\b${SAVE}\b[^.!?\n]{0,50}?${QUANTITY}`);
const REDUCED_TIME_QUANTITY = q(
  String.raw`\b${REDUCE}\b[^.!?\n]{0,50}?\b${TIME_NOUN.source}[^.!?\n]{0,40}?${QUANTITY}`,
);
const REDUCED_BY_QUANTITY = q(String.raw`\b${REDUCE}\b[^.!?\n]{0,50}?\bby\s+${QUANTITY}`);
const REDUCED_FROM_TO = q(
  String.raw`\b${REDUCE}\b[^.!?\n]{0,30}?\bfrom\s+${QUANTITY}\s+to\s+${QUANTITY}`,
);
const QUANTITY_SAVED = q(
  String.raw`${QUANTITY}[^.!?\n]{0,40}?\b(?:saved|shorter|faster|quicker|less\s+time)\b`,
);
const AVOIDED_QUANTITY = q(String.raw`\b${AVOID}\b[^.!?\n]{0,20}?${QUANTITY}`);
const QUANTITY_AVOIDED = q(
  String.raw`${QUANTITY}[^.!?\n]{0,60}?\b(?:avoided|avoidable|eliminated)\b`,
);
const QUANTITY_EARLIER = q(String.raw`${QUANTITY}[^.!?\n]{0,30}?\b(?:earlier|sooner)\b`);
const HALVING = /\b(?:half the (?:time|duration|effort)|twice as (?:fast|quick))\b/i;

/** True when the text claims a time saving by a number. Sentence by sentence, so a figure elsewhere does not count. */
export function claimsNumericTimeSaving(text: string): boolean {
  for (const sentence of text.split(/[.!?;]+(?=\s|$)|\n+/)) {
    if (HALVING.test(sentence)) return true;
    if (SAVED_QUANTITY.test(sentence) || QUANTITY_SAVED.test(sentence)) return true;
    if (REDUCED_TIME_QUANTITY.test(sentence)) return true;
    if (
      TIME_NOUN.test(sentence) &&
      (REDUCED_BY_QUANTITY.test(sentence) || REDUCED_FROM_TO.test(sentence))
    ) {
      return true;
    }
    if (AVOIDED_QUANTITY.test(sentence) || QUANTITY_AVOIDED.test(sentence)) return true;
    // "2 days earlier" states a fact in a sentence about what happened and a claim in one about what could have.
    if (MODAL.test(sentence) && QUANTITY_EARLIER.test(sentence)) return true;
  }
  return false;
}

/**
 * A model cannot state saved minutes: there is no numeric field, and wording that says time was saved, reduced or
 * shortened by a number is refused wherever it appears in what the model wrote. The engine computes estimates and says
 * what they rest on; a number from a model would read like one. The critic's own critiques are not read: it may have to
 * repeat a claim it criticises. A quotation of the record is not read either.
 */
export function checkNumericTimeClaim(proposal: AnyProposal): ProposalIssue[] {
  if (proposal.type === 'critic_result') return [];
  const { own } = collectProposalTexts(proposal);
  return own
    .filter((t) => claimsNumericTimeSaving(t.text))
    .slice(0, 3)
    .map((t) => ({
      code: 'numeric_time_claim' as const,
      path: t.path,
      message:
        'The proposal states a saved, reduced or shortened time as a number; only the engine may estimate that.',
    }));
}
