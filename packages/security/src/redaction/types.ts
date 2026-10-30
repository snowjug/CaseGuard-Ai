import type { RedactionCategory, RedactionFinding } from '@caseguard/schemas';

/** An administrator-supplied pattern (governance `RedactionConfig.customPatterns`). */
export interface CustomRedactionPattern {
  readonly name: string;
  /** JavaScript regular-expression source (no delimiters or flags), at most 200 characters. */
  readonly pattern: string;
}

/**
 * Why a custom pattern did not (fully) run:
 * - `invalid`: empty, too long, not a regular expression, or able to match the empty string;
 * - `unsafe`: rejected for catastrophic backtracking by the static checks or the timing probe;
 * - `too_many`: the list is longer than the limit and the extra patterns are ignored;
 * - `timeout`: it exceeded its evaluation deadline on this input (the text may hold unredacted matches);
 * - `budget_exhausted`: the request's custom-pattern time budget ran out before it could run;
 * - `match_limit`: it matched more often than the per-text or per-request bound allows;
 * - `unstable`: replacements kept exposing new matches until the engine's re-check limit was reached;
 * - `error`: the sandbox failed to evaluate it.
 */
export type CustomPatternFailureCode =
  | 'invalid'
  | 'unsafe'
  | 'too_many'
  | 'timeout'
  | 'budget_exhausted'
  | 'match_limit'
  | 'unstable'
  | 'error';

/** A custom pattern that was not applied. Identifies the pattern by label and position, never by source. */
export interface CustomPatternFailure {
  readonly code: CustomPatternFailureCode;
  /** Position in `RedactionOptions.customPatterns` (the first ignored position for `too_many`). */
  readonly index: number;
  /** The pattern's name with control, zero-width and bidi characters removed, at most 60 characters. */
  readonly label: string;
  /** Fixed explanation, safe to show to an operator. Contains neither the pattern source nor any input text. */
  readonly message: string;
}

/** A request-wide allowance of custom-pattern evaluation time that several redaction calls can share. */
export interface CustomPatternBudget {
  /** Milliseconds of evaluation this budget still allows. */
  remainingMs(): number;
  /** Records time spent. */
  consume(ms: number): void;
}

/** Structurally compatible with the governance `RedactionConfig`, so settings can be passed as-is. */
export interface RedactionOptions {
  /** Categories to redact. Defaults to every category of `DEFAULT_REDACTION_CONFIG`. */
  readonly enabledCategories?: readonly RedactionCategory[];
  /**
   * Extra patterns. They run whenever the list is non-empty (a forgotten `custom` toggle must not
   * silently disable redaction), after all built-in categories. A pattern that cannot run is never
   * skipped silently: the result reports it in `failures` and sets `complete` to false.
   */
  readonly customPatterns?: readonly CustomRedactionPattern[];
  /**
   * Also redact values that are reserved for documentation and tests: e-mail addresses on
   * `.invalid/.example/.test/.localhost` and `example.com/net/org`, and IPv4 addresses in private,
   * loopback, link-local and RFC 5737 ranges. Off by default because synthetic case data uses them
   * and analysis needs to keep seeing them; turn it on to sanitise operational diagnostics.
   */
  readonly redactReservedValues?: boolean;
  /**
   * Custom-pattern evaluation time for the whole request. Pass one budget (see
   * `createCustomPatternBudget`) to every call that belongs to the same request so they share it;
   * without one, each call gets its own default.
   */
  readonly customPatternBudget?: CustomPatternBudget;
}

export interface RedactionResult {
  readonly text: string;
  /** One entry per category that fired, in canonical category order. Never contains matched text. */
  readonly findings: RedactionFinding[];
  readonly totalReplacements: number;
  /** Operator-facing remarks, one per entry of `failures`. */
  readonly notes: string[];
  /**
   * False when a custom pattern could not be applied. The text is then only partly redacted and must
   * not be stored, indexed or shown: refuse the payload (see `assertRedactionComplete`).
   */
  readonly complete: boolean;
  readonly failures: readonly CustomPatternFailure[];
}

export interface RedactionValueResult<T> {
  readonly value: T;
  readonly findings: RedactionFinding[];
  readonly totalReplacements: number;
  readonly notes: string[];
  readonly complete: boolean;
  readonly failures: readonly CustomPatternFailure[];
}

/** The outcome for one input of a batch. */
export interface RedactionItem<T> {
  readonly value: T;
  readonly findings: RedactionFinding[];
  readonly totalReplacements: number;
}

/** Result of redacting many strings (or JSON-like values) in one call, in input order. */
export interface RedactionBatchResult<T> {
  readonly items: RedactionItem<T>[];
  /** All items together. */
  readonly findings: RedactionFinding[];
  readonly totalReplacements: number;
  readonly notes: string[];
  readonly complete: boolean;
  readonly failures: readonly CustomPatternFailure[];
}
