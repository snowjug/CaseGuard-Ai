import type { RedactionCategory } from '@caseguard/schemas';
import {
  DEFAULT_PATTERN_DEPS,
  createCustomPatternBudget,
  evaluatePatterns,
  noteFor,
  resolveCustomPatterns,
  unsettledFailure,
  type PatternDeps,
  type UsablePattern,
} from './custom';
import { DEFAULT_REDACTION_OPTIONS } from './defaults';
import type { PseudonymState } from './pseudonyms';
import { Rewriter } from './rewriter';
import { BUILTIN_RULES, placeholderFor, type RedactionRule, type RuleContext } from './rules';
import { countHit, createTally, mergeCounts, type RedactionTally } from './tally';
import type { CustomPatternBudget, CustomPatternFailure, RedactionOptions } from './types';

/**
 * Upper bound on built-in rule passes per string. One pass is enough for virtually all input; the next
 * one only runs to confirm the text is stable (or to catch what the first pass exposed).
 */
export const MAX_REDACTION_PASSES = 4;
/** Rounds of custom-pattern evaluation per batch: the first covers everything, later ones only re-check. */
const MAX_CUSTOM_ROUNDS = 3;

/** The rule set and limits behind the engine; overridable so tests can exercise the loops. */
export interface EngineConfig {
  readonly rules: readonly RedactionRule[];
  readonly maxPasses: number;
  /** How custom patterns are evaluated (tests inject fakes and counters). */
  readonly patternDeps: PatternDeps;
  /** Tests only: track replacements back to the original text even when the text is plain. */
  readonly forceTracking: boolean;
}

export const DEFAULT_ENGINE: EngineConfig = {
  rules: BUILTIN_RULES,
  maxPasses: MAX_REDACTION_PASSES,
  patternDeps: DEFAULT_PATTERN_DEPS,
  forceTracking: false,
};

export interface BatchOutcome {
  /** The redacted strings, in input order. */
  readonly texts: string[];
  readonly notes: string[];
  readonly failures: CustomPatternFailure[];
}

const PLACEHOLDER_SPAN = /\[REDACTED:[a-z_]+(?:#\d+)?\]/g;

/**
 * Flat `[start, length, ...]` for the union of `found` (flat `[start, end, ...]`, any order), without
 * any match that overlaps an existing placeholder (custom patterns never rewrite those) and with
 * overlapping matches of different patterns merged, so no part of an overlap is left behind.
 */
function mergeMatches(found: readonly number[], view: string): number[] {
  const protectedSpans: number[] = [];
  if (view.includes('[REDACTED:')) {
    for (const match of view.matchAll(PLACEHOLDER_SPAN)) {
      protectedSpans.push(match.index, match.index + match[0].length);
    }
  }
  const pairs: [number, number][] = [];
  for (let k = 0; k + 1 < found.length; k += 2) pairs.push([found[k] ?? 0, found[k + 1] ?? 0]);
  pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const out: number[] = [];
  let guard = 0;
  let open: [number, number] | null = null;
  const flush = (): void => {
    if (open !== null) out.push(open[0], open[1] - open[0]);
  };
  for (const [start, end] of pairs) {
    while (guard < protectedSpans.length && (protectedSpans[guard + 1] ?? 0) <= start) guard += 2;
    if (guard < protectedSpans.length && (protectedSpans[guard] ?? 0) < end) continue;
    if (open !== null && start < open[1]) {
      open[1] = Math.max(open[1], end);
    } else {
      flush();
      open = [start, end];
    }
  }
  flush();
  return out;
}

/**
 * Redacts every string of `inputs` in one go and adds the replacement counts to `tallies[i]` (the same
 * tally object may serve several inputs). Strings are processed in order with the shared pseudonym
 * `state`, so the numbering equals that of redacting them one by one.
 *
 * Built-in rules run per string on its detection view (see `fold.ts`) and write onto the original
 * text. Idempotency is guaranteed by construction: a rule can expose text that an earlier rule skipped
 * (a lookbehind that a later replacement satisfies, a match that a neighbouring placeholder changes),
 * so the rules are applied again until a pass changes nothing. Replacements of the confirming pass are
 * only counted when that pass actually changed the text.
 *
 * Custom patterns then run once per pattern over ALL strings (see `custom.ts`). Their matches are
 * collected on the same snapshot and merged, so the result does not depend on pattern order and
 * overlapping matches of two patterns leave nothing behind. Only when custom replacements changed a
 * string are its built-in rules re-checked, and its custom patterns re-evaluated only if a built-in
 * replacement followed or some pattern uses an assertion (`^`, `$`, `\b`), whose result depends on the
 * neighbouring characters.
 *
 * A custom pattern that cannot run is never skipped silently: it is returned in `failures`.
 */
export function redactBatchInto(
  inputs: readonly string[],
  options: RedactionOptions,
  state: PseudonymState,
  tallies: readonly RedactionTally[],
  overrides: Partial<EngineConfig> = {},
): BatchOutcome {
  const config: EngineConfig = { ...DEFAULT_ENGINE, ...overrides };
  const enabled = new Set<RedactionCategory>(
    options.enabledCategories ?? DEFAULT_REDACTION_OPTIONS.enabledCategories,
  );
  const redactReserved = options.redactReservedValues === true;

  const runPass = (text: string, into: RedactionTally, reserve: boolean): string => {
    const doc = new Rewriter(text, { forceTracking: config.forceTracking });
    if (reserve) state.reserveFrom(doc.text);
    const context: RuleContext = {
      state,
      redactReserved,
      hit: (category) => countHit(into, category),
    };
    for (const rule of config.rules) {
      if (enabled.has(rule.category)) rule.apply(doc, context);
    }
    return doc.finish();
  };

  const builtinFixpoint = (text: string, tally: RedactionTally, first: boolean): string => {
    if (text.length === 0) return text;
    let current = runPass(text, tally, first);
    if (current === text) return current;
    for (let pass = 2; pass <= config.maxPasses; pass += 1) {
      const confirming = createTally();
      const next = runPass(current, confirming, false);
      if (next === current) break;
      mergeCounts(tally, confirming);
      current = next;
    }
    return current;
  };

  const tallyOf = (index: number): RedactionTally => tallies[index] ?? createTally();
  const texts = inputs.map((text, index) => builtinFixpoint(text, tallyOf(index), true));

  const failures: CustomPatternFailure[] = [];
  const notes = new Set<string>();
  const seen = new Set<string>();
  const report = (item: CustomPatternFailure): void => {
    const key = `${item.code}:${item.index}`;
    if (seen.has(key)) return;
    seen.add(key);
    failures.push(item);
    notes.add(noteFor(item));
  };

  const customPatterns = options.customPatterns ?? [];
  if (customPatterns.length > 0) {
    const resolved = resolveCustomPatterns(customPatterns, config.patternDeps);
    resolved.failures.forEach(report);
    if (resolved.usable.length > 0) {
      customStage(texts, resolved.usable, {
        budget: options.customPatternBudget ?? createCustomPatternBudget(),
        config,
        report,
        tallyOf,
        builtinFixpoint,
      });
    }
  }
  return { texts, notes: [...notes], failures };
}

interface CustomStageContext {
  readonly budget: CustomPatternBudget;
  readonly config: EngineConfig;
  readonly report: (item: CustomPatternFailure) => void;
  readonly tallyOf: (index: number) => RedactionTally;
  readonly builtinFixpoint: (text: string, tally: RedactionTally, first: boolean) => string;
}

function customStage(
  texts: string[],
  patterns: readonly UsablePattern[],
  context: CustomStageContext,
): void {
  const placeholder = placeholderFor('custom');
  const contextual = patterns.some((pattern) => pattern.contextual);
  let dirty: number[] = [];
  texts.forEach((text, index) => {
    if (text.length > 0) dirty.push(index);
  });

  for (let round = 0; dirty.length > 0 && round < MAX_CUSTOM_ROUNDS; round += 1) {
    const docs = dirty.map(
      (index) => new Rewriter(texts[index] ?? '', { forceTracking: context.config.forceTracking }),
    );
    const views = docs.map((doc) => doc.text);
    const evaluation = evaluatePatterns(
      patterns,
      views,
      context.budget,
      context.config.patternDeps,
    );
    evaluation.failures.forEach(context.report);

    const changed: number[] = [];
    dirty.forEach((index, slot) => {
      const found = evaluation.spans[slot];
      const doc = docs[slot];
      if (found === undefined || doc === undefined) return;
      const merged = mergeMatches(found, views[slot] ?? '');
      if (merged.length === 0) return;
      doc.replaceSpans(merged, placeholder);
      countHit(context.tallyOf(index), 'custom', merged.length >> 1);
      const next = doc.finish();
      if (next !== texts[index]) {
        texts[index] = next;
        changed.push(index);
      }
    });

    // Built-in rules may now see something new next to a placeholder; custom patterns need another look
    // when that happened, or when an assertion in one of them reads the characters around its match.
    dirty = [];
    for (const index of changed) {
      const before = texts[index] ?? '';
      const after = context.builtinFixpoint(before, context.tallyOf(index), false);
      if (after !== before) texts[index] = after;
      if (after !== before || contextual) dirty.push(index);
    }
  }

  // Strings that still wait for another look when the limit is reached may hold matches nobody has seen.
  if (dirty.length > 0) {
    for (const pattern of patterns) context.report(unsettledFailure(pattern));
  }
}
