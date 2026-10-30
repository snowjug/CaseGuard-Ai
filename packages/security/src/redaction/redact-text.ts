import type { RedactionFinding } from '@caseguard/schemas';
import { DEFAULT_REDACTION_OPTIONS, SECRET_REDACTION_CATEGORIES } from './defaults';
import { MAX_REDACTION_PASSES, redactBatchInto, type EngineConfig } from './engine';
import { createPseudonymState, type PseudonymState } from './pseudonyms';
import {
  countHit,
  createTally,
  findingsFrom,
  mergeCounts,
  totalOf,
  type RedactionTally,
} from './tally';
import type { RedactionBatchResult, RedactionOptions, RedactionResult } from './types';

export { DEFAULT_REDACTION_OPTIONS, SECRET_REDACTION_CATEGORIES, MAX_REDACTION_PASSES };
export { countHit, createTally, findingsFrom, mergeCounts, totalOf, type RedactionTally };

/**
 * Redacts many strings in one call. Prefer this over calling `redactText` per field: custom patterns
 * are evaluated once per pattern over the whole batch instead of once per pattern per string, which
 * is what keeps a large bundle with a tenant pattern from taking minutes.
 *
 * Replaces secret-like and personal values with stable placeholders (`[REDACTED:<category>]`).
 * E-mail addresses, IPv4 addresses and phone numbers get numbered pseudonyms per distinct value
 * within one `state` (`[REDACTED:email_address#1]`), so analysis can still tell them apart. Reserved
 * test/documentation values are left alone unless `redactReservedValues` is set.
 *
 * Detection runs on a folded view of each string (no-break and other Unicode spaces, full-width
 * punctuation, zero-width and bidi characters are looked through) but replacements are written onto
 * the original, so everything outside a redacted span is preserved byte for byte.
 *
 * Idempotent (redacting redacted text changes nothing and reports zero replacements), linear-time on
 * hostile input, and `findings` never contain the matched values.
 *
 * Check `complete`: when it is false a custom pattern could not be applied (see `failures`), the
 * items are only partly redacted and the payload must be refused.
 */
export function redactTexts(
  values: readonly string[],
  options: RedactionOptions = {},
  state: PseudonymState = createPseudonymState(),
): RedactionBatchResult<string> {
  return redactTextsWith(values, options, state, {});
}

/** `redactTexts` with the engine's internals exposed (rules, pass limit, sandbox runner): for tests. */
export function redactTextsWith(
  values: readonly string[],
  options: RedactionOptions,
  state: PseudonymState,
  engine: Partial<EngineConfig>,
): RedactionBatchResult<string> {
  const tallies = values.map(() => createTally());
  const outcome = redactBatchInto(values, options, state, tallies, engine);
  const all = createTally();
  for (const tally of tallies) mergeCounts(all, tally);
  return {
    items: outcome.texts.map((value, index) => {
      const tally = tallies[index] ?? createTally();
      return { value, findings: findingsFrom(tally), totalReplacements: totalOf(tally) };
    }),
    findings: findingsFrom(all),
    totalReplacements: totalOf(all),
    notes: outcome.notes,
    complete: outcome.failures.length === 0,
    failures: outcome.failures,
  };
}

/**
 * Redacts one string (see `redactTexts` for the rules).
 *
 * @deprecated Calls of this function in a loop evaluate every custom pattern once per string. Collect
 * the strings and call `redactTexts` (or `redactValues`) once per request instead. The result also
 * carries `complete`/`failures`: ignoring them means a custom pattern that could not run is skipped.
 */
export function redactText(
  text: string,
  options: RedactionOptions = {},
  state: PseudonymState = createPseudonymState(),
): RedactionResult {
  const batch = redactTexts([text], options, state);
  const item = batch.items[0];
  return {
    text: item?.value ?? text,
    findings: item?.findings ?? ([] as RedactionFinding[]),
    totalReplacements: item?.totalReplacements ?? 0,
    notes: batch.notes,
    complete: batch.complete,
    failures: batch.failures,
  };
}
