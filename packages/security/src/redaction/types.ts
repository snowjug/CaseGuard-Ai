import type { RedactionCategory, RedactionFinding } from '@caseguard/schemas';

/** An administrator-supplied pattern (governance `RedactionConfig.customPatterns`). */
export interface CustomRedactionPattern {
  readonly name: string;
  /** JavaScript regular-expression source (no delimiters or flags), at most 200 characters. */
  readonly pattern: string;
}

/** Structurally compatible with the governance `RedactionConfig`, so settings can be passed as-is. */
export interface RedactionOptions {
  /** Categories to redact. Defaults to every category of `DEFAULT_REDACTION_CONFIG`. */
  readonly enabledCategories?: readonly RedactionCategory[];
  /**
   * Extra patterns. They run whenever the list is non-empty (a forgotten `custom` toggle must not
   * silently disable redaction), after all built-in categories.
   */
  readonly customPatterns?: readonly CustomRedactionPattern[];
  /**
   * Also redact values that are reserved for documentation and tests: e-mail addresses on
   * `.invalid/.example/.test/.localhost` and `example.com/net/org`, and IPv4 addresses in private,
   * loopback, link-local and RFC 5737 ranges. Off by default because synthetic case data uses them
   * and analysis needs to keep seeing them; turn it on to sanitise operational diagnostics.
   */
  readonly redactReservedValues?: boolean;
}

export interface RedactionResult {
  readonly text: string;
  /** One entry per category that fired, in canonical category order. Never contains matched text. */
  readonly findings: RedactionFinding[];
  readonly totalReplacements: number;
  /** Operator-facing remarks, for example a custom pattern that was skipped and why. */
  readonly notes: string[];
}

export interface RedactionValueResult<T> {
  readonly value: T;
  readonly findings: RedactionFinding[];
  readonly totalReplacements: number;
  readonly notes: string[];
}
