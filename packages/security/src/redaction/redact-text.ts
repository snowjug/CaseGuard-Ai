import {
  DEFAULT_REDACTION_CONFIG,
  REDACTION_CATEGORIES,
  type RedactionCategory,
  type RedactionFinding,
} from '@caseguard/schemas';
import { applyCustomPatterns, compiledFor } from './custom';
import { createPseudonymState, type PseudonymState } from './pseudonyms';
import { BUILTIN_RULES, placeholderFor, type RedactionRule, type RuleContext } from './rules';
import type { RedactionOptions, RedactionResult } from './types';

/** Defaults mirror the governance `DEFAULT_REDACTION_CONFIG` so settings and code cannot drift apart. */
export const DEFAULT_REDACTION_OPTIONS: Readonly<Required<RedactionOptions>> = Object.freeze({
  enabledCategories: Object.freeze([...DEFAULT_REDACTION_CONFIG.enabledCategories]),
  customPatterns: Object.freeze([]),
  redactReservedValues: false,
});

/**
 * Credential categories only (no e-mail, IP or phone). Use these for logs and telemetry, where
 * client addresses and user ids are operationally useful but secrets must never appear.
 */
export const SECRET_REDACTION_CATEGORIES: readonly RedactionCategory[] = Object.freeze([
  'bearer_token',
  'api_key',
  'connection_string',
  'private_key',
  'password_assignment',
  'jwt',
  'github_token',
  'azure_storage_key',
]);

/** Mutable tally shared by `redactText` and `redactValue`. */
export interface RedactionTally {
  readonly counts: Map<RedactionCategory, number>;
  readonly notes: Set<string>;
}

export function createTally(): RedactionTally {
  return { counts: new Map(), notes: new Set() };
}

function countHit(tally: RedactionTally, category: RedactionCategory): void {
  tally.counts.set(category, (tally.counts.get(category) ?? 0) + 1);
}

export function findingsFrom(tally: RedactionTally): RedactionFinding[] {
  return REDACTION_CATEGORIES.filter((category) => (tally.counts.get(category) ?? 0) > 0).map(
    (category) => ({
      category,
      count: tally.counts.get(category) ?? 0,
      placeholder: placeholderFor(category),
    }),
  );
}

export function totalOf(tally: RedactionTally): number {
  let total = 0;
  for (const count of tally.counts.values()) total += count;
  return total;
}

/**
 * Upper bound on rule passes per string. One pass is enough for virtually all input; the next one
 * only runs to confirm the text is stable (or to catch what the first pass exposed).
 */
export const MAX_REDACTION_PASSES = 4;

/** The rule set and pass limit behind `redactInto`; overridable so tests can exercise the pass loop. */
export interface RedactionEngine {
  readonly rules: readonly RedactionRule[];
  readonly maxPasses: number;
}

const DEFAULT_ENGINE: RedactionEngine = { rules: BUILTIN_RULES, maxPasses: MAX_REDACTION_PASSES };

/**
 * Redacts `text` into `tally`; the engine shared by `redactText` and `redactValue`.
 *
 * Idempotency is guaranteed by construction rather than by pattern design alone: a rule can expose
 * text that an earlier rule skipped (a lookbehind that a later replacement satisfies, a match that a
 * neighbouring placeholder changes), so the rules are applied again until a pass changes nothing.
 * Replacements of the confirming pass are only counted when that pass actually changed the text.
 */
export function redactInto(
  text: string,
  options: RedactionOptions,
  state: PseudonymState,
  tally: RedactionTally,
  engine: RedactionEngine = DEFAULT_ENGINE,
): string {
  if (text.length === 0) return text;
  const enabled = new Set<RedactionCategory>(
    options.enabledCategories ?? DEFAULT_REDACTION_OPTIONS.enabledCategories,
  );
  const redactReserved = options.redactReservedValues === true;
  const customPatterns = options.customPatterns ?? [];
  const compiled = customPatterns.length > 0 ? compiledFor(customPatterns) : null;

  const runPass = (input: string, into: RedactionTally): string => {
    const context: RuleContext = {
      state,
      redactReserved,
      hit: (category) => countHit(into, category),
    };
    let current = input;
    for (const rule of engine.rules) {
      if (enabled.has(rule.category)) current = rule.apply(current, context);
    }
    if (compiled) {
      current = applyCustomPatterns(current, compiled, {
        hit: () => countHit(into, 'custom'),
        note: (message) => into.notes.add(message),
      });
    }
    return current;
  };

  state.reserveFrom(text);
  let current = runPass(text, tally);
  if (current === text) return current;
  for (let pass = 2; pass <= engine.maxPasses; pass += 1) {
    const confirming = createTally();
    const next = runPass(current, confirming);
    for (const note of confirming.notes) tally.notes.add(note);
    if (next === current) break;
    for (const [category, count] of confirming.counts) {
      tally.counts.set(category, (tally.counts.get(category) ?? 0) + count);
    }
    current = next;
  }
  return current;
}

/**
 * Replaces secret-like and personal values with stable placeholders (`[REDACTED:<category>]`).
 * E-mail addresses, IPv4 addresses and phone numbers get numbered pseudonyms per distinct value
 * (`[REDACTED:email_address#1]`) within one `state`, so analysis can still tell them apart.
 * Reserved test/documentation values are left alone unless `redactReservedValues` is set.
 *
 * Idempotent (redacting redacted text changes nothing and reports zero replacements), linear-time on
 * hostile input, and `findings` never contain the matched values.
 */
export function redactText(
  text: string,
  options: RedactionOptions = {},
  state: PseudonymState = createPseudonymState(),
): RedactionResult {
  const tally = createTally();
  const redacted = redactInto(text, options, state, tally);
  return {
    text: redacted,
    findings: findingsFrom(tally),
    totalReplacements: totalOf(tally),
    notes: [...tally.notes],
  };
}
