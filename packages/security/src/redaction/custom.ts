import vm from 'node:vm';
import type {
  CustomPatternBudget,
  CustomPatternFailure,
  CustomPatternFailureCode,
  CustomRedactionPattern,
} from './types';

/*
 * Administrator-supplied patterns are untrusted input to a backtracking regex engine (NFR-SEC-05).
 *
 * Safety layers:
 *   1. Static checks: length, syntax, empty matches, nested/ambiguous repetition, back-references.
 *   2. A probe: the compiled pattern runs once against adversarial 2000-character inputs under a hard
 *      wall-clock budget. This is a save-time check: its verdict is cached by pattern CONTENT in a small
 *      bounded LRU, so it runs at most once per distinct pattern, never per field or per request.
 *   3. A run-time deadline: every evaluation happens inside a `vm` context with a timeout, which really
 *      interrupts the regex engine.
 *
 * Cost model: Node's `timeout` option costs a watchdog thread per `runInContext` call (about 15 ms on
 * Windows, against 0.006 ms without it), so an evaluation covers a whole BATCH of strings in a single
 * call: one call per pattern per batch, never one per field. Matches are bounded per string and per
 * batch, and a request-wide time budget caps the total.
 *
 * Nothing here may skip a pattern silently. A pattern that is invalid, unsafe, too slow, over its match
 * limits or starved by the request budget becomes a typed `CustomPatternFailure` on the result; the
 * caller decides what to do (the ingestion pipeline refuses the payload). Nothing is carried from one
 * call to the next except the immutable analysis of a pattern's source.
 */

export const MAX_CUSTOM_PATTERN_LENGTH = 200;
export const MAX_CUSTOM_PATTERNS = 20;
const MAX_NAME_LENGTH = 60;
const MAX_UNBOUNDED_QUANTIFIERS = 4;
const PROBE_LENGTH = 2000;
/** The whole probe (every adversarial input, one call). Linear patterns need a few milliseconds. */
const PROBE_BUDGET_MS = 300;
/** A probe timeout may have been a stall (GC, CPU throttling), so that verdict expires. */
const PROBE_REJECTION_TTL_MS = 5 * 60_000;
const CACHE_LIMIT = 256;

/** Matches kept per pattern and string, and per pattern and batch. */
export const MAX_MATCHES_PER_STRING = 1_000;
export const MAX_MATCHES_PER_PATTERN = 25_000;

/** Custom-pattern evaluation time one request may spend in total unless the caller sets its own budget. */
export const DEFAULT_CUSTOM_PATTERN_BUDGET_MS = 3_000;
const DEADLINE_BASE_MS = 200;
const DEADLINE_MAX_MS = 2_000;
/** Less than this is not worth a vm call (its own overhead is larger). */
const MIN_SLICE_MS = 10;

/** Wall-clock allowance for one pattern over `totalChars` characters: generous when linear, bounded when not. */
export function deadlineFor(totalChars: number): number {
  return Math.min(DEADLINE_MAX_MS, DEADLINE_BASE_MS + Math.ceil(totalChars / 2000));
}

/** A request-wide allowance of custom-pattern evaluation time, shareable between calls. */
export function createCustomPatternBudget(
  totalMs: number = DEFAULT_CUSTOM_PATTERN_BUDGET_MS,
): CustomPatternBudget {
  let remaining = Math.max(0, totalMs);
  return {
    remainingMs: () => remaining,
    consume(ms) {
      remaining = Math.max(0, remaining - Math.max(0, ms));
    },
  };
}

// ------------------------------------------------------------------ sandboxed evaluation

export interface RunLimits {
  readonly perString: number;
  readonly perBatch: number;
}

export interface RunOutcome {
  /** `timeout` and `limit` keep the matches found before the run stopped. */
  readonly kind: 'ok' | 'timeout' | 'limit';
  /** Flat triples `[stringIndex, start, length, ...]`. */
  readonly spans: number[];
}

/** Evaluates `regex` over every string of `texts` in one call; replaceable so tests can count and fake runs. */
export type PatternRunner = (
  regex: RegExp,
  texts: readonly string[],
  limits: RunLimits,
  deadlineMs: number,
) => RunOutcome;

export interface PatternDeps {
  readonly runner: PatternRunner;
  /** Monotonic milliseconds, for the request budget. */
  readonly clock: () => number;
  /** Epoch milliseconds, for cache expiry. */
  readonly wallClock: () => number;
  /** Match bounds per evaluation; tests lower them to reach a limit with a handful of matches. */
  readonly limits?: RunLimits;
}

interface Scope {
  __re: RegExp | null;
  __texts: readonly string[] | null;
  __out: number[] | null;
  __perString: number;
  __perBatch: number;
}

const COLLECT_MATCHES = new vm.Script(
  `(function () {
    const re = __re;
    const texts = __texts;
    const out = __out;
    const perString = __perString;
    const perBatch = __perBatch;
    let total = 0;
    for (let i = 0; i < texts.length; i += 1) {
      const text = texts[i];
      re.lastIndex = 0;
      let count = 0;
      let match;
      while ((match = re.exec(text)) !== null) {
        if (match[0].length === 0) { re.lastIndex += 1; continue; }
        count += 1;
        total += 1;
        if (count > perString || total > perBatch) return 1;
        out.push(i, match.index, match[0].length);
      }
    }
    return 0;
  })()`,
  { filename: 'caseguard-custom-redaction.js' },
);

let sandbox: vm.Context | undefined;

/** One context serves every run: it only holds the five variables above and they are cleared after each call. */
function sandboxContext(): vm.Context {
  sandbox ??= vm.createContext({
    __re: null,
    __texts: null,
    __out: null,
    __perString: 0,
    __perBatch: 0,
  } satisfies Scope);
  return sandbox;
}

export const runInSandbox: PatternRunner = (regex, texts, limits, deadlineMs) => {
  const scope = sandboxContext() as Scope & vm.Context;
  const spans: number[] = [];
  scope.__re = regex;
  scope.__texts = texts;
  scope.__out = spans;
  scope.__perString = limits.perString;
  scope.__perBatch = limits.perBatch;
  try {
    const status = COLLECT_MATCHES.runInContext(scope, {
      timeout: Math.max(1, Math.ceil(deadlineMs)),
    }) as unknown;
    return { kind: status === 1 ? 'limit' : 'ok', spans };
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      return { kind: 'timeout', spans };
    }
    throw error;
  } finally {
    scope.__re = null;
    scope.__texts = null;
    scope.__out = null;
  }
};

export const DEFAULT_PATTERN_DEPS: PatternDeps = {
  runner: runInSandbox,
  clock: () => performance.now(),
  wallClock: () => Date.now(),
};

// ------------------------------------------------------------------ static analysis

interface Quantifier {
  end: number;
  /** Can match more than once. */
  repeating: boolean;
  unbounded: boolean;
}

function readQuantifier(source: string, index: number): Quantifier | null {
  const ch = source.charAt(index);
  let quantifier: Quantifier | null = null;
  if (ch === '*' || ch === '+') {
    quantifier = { end: index + 1, repeating: true, unbounded: true };
  } else if (ch === '?') {
    quantifier = { end: index + 1, repeating: false, unbounded: false };
  } else if (ch === '{') {
    const braces = /^\{(\d{1,5})(?:(,)(\d{0,5}))?\}/.exec(source.slice(index, index + 14));
    if (braces) {
      const min = Number(braces[1]);
      const hasComma = braces[2] !== undefined;
      const max = hasComma ? (braces[3] === '' ? Infinity : Number(braces[3])) : min;
      quantifier = {
        end: index + braces[0].length,
        repeating: max > 1,
        unbounded: max === Infinity,
      };
    }
  }
  if (quantifier && source.charAt(quantifier.end) === '?') quantifier.end += 1; // lazy modifier
  return quantifier;
}

/**
 * Returns why a pattern is likely to backtrack badly, or null. Deliberately conservative: it only
 * needs to catch the classic shapes (nested or alternated repetition); the probe and the run-time
 * deadline are the backstops.
 */
export function describeBacktrackingRisk(source: string): string | null {
  const stack: { repeats: boolean; alternates: boolean }[] = [];
  let unbounded = 0;
  let inClass = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source.charAt(i);
    if (ch === '\\') {
      const next = source.charAt(i + 1);
      if (!inClass && (/[1-9]/.test(next) || next === 'k')) return 'it uses a back-reference';
      i += 1;
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      continue;
    }
    if (ch === '(') {
      if (/^\(\?<?[=!]/.test(source.slice(i, i + 4))) return 'it uses a look-around assertion';
      stack.push({ repeats: false, alternates: false });
      continue;
    }
    if (ch === '|') {
      const frame = stack[stack.length - 1];
      if (frame) frame.alternates = true;
      continue;
    }
    if (ch === ')') {
      const frame = stack.pop();
      if (!frame) continue;
      const quantifier = readQuantifier(source, i + 1);
      const parent = stack[stack.length - 1];
      if (quantifier?.repeating) {
        if (frame.repeats || frame.alternates)
          return 'it repeats a group that itself repeats or branches';
        if (quantifier.unbounded) unbounded += 1;
        if (parent) parent.repeats = true;
        i = quantifier.end - 1;
      } else if (parent) {
        parent.repeats ||= frame.repeats;
        parent.alternates ||= frame.alternates;
      }
      continue;
    }
    const quantifier = readQuantifier(source, i);
    if (quantifier) {
      if (quantifier.repeating) {
        const frame = stack[stack.length - 1];
        if (frame) frame.repeats = true;
        if (quantifier.unbounded) unbounded += 1;
      }
      i = quantifier.end - 1;
    }
  }
  return unbounded > MAX_UNBOUNDED_QUANTIFIERS ? 'it has too many unbounded repetitions' : null;
}

/** Hostile inputs for the probe: long runs of characters the pattern itself mentions, plus generic runs. */
function probeInputs(source: string): string[] {
  const own = [...new Set(source.replace(/\\./g, '').match(/[A-Za-z0-9]/g) ?? [])].slice(0, 6);
  const runs = ['a', '0', ' ', '-', ...own];
  const inputs = new Set<string>();
  for (const unit of runs) {
    inputs.add(unit.repeat(PROBE_LENGTH));
    inputs.add(`${unit.repeat(PROBE_LENGTH - 1)}!`);
  }
  inputs.add('ab'.repeat(PROBE_LENGTH / 2));
  inputs.add('a '.repeat(PROBE_LENGTH / 2));
  inputs.add('a1-'.repeat(Math.floor(PROBE_LENGTH / 3)));
  return [...inputs];
}

/**
 * Assertions look at the characters around a match, so a replacement next to a match can create or
 * remove matches of such a pattern. Without them a match depends only on its own characters.
 */
function dependsOnContext(source: string): boolean {
  return /[\^$]|\\[bB]/.test(source);
}

// ------------------------------------------------------------------ analysis cache

interface Rejection {
  readonly code: 'invalid' | 'unsafe';
  readonly message: string;
}

interface Analysis {
  readonly regex: RegExp | null;
  readonly rejection: Rejection | null;
  readonly contextual: boolean;
  /** Set when the rejection came from the timing probe: it is retried after this epoch time. */
  readonly expiresAt: number | null;
}

const analysisCache = new Map<string, Analysis>();

function rejected(code: Rejection['code'], message: string, expiresAt: number | null = null) {
  return { regex: null, rejection: { code, message }, contextual: false, expiresAt } as Analysis;
}

function probe(regex: RegExp, source: string, deps: PatternDeps): boolean {
  const inputs = probeInputs(source);
  const unlimited: RunLimits = {
    perString: Number.MAX_SAFE_INTEGER,
    perBatch: Number.MAX_SAFE_INTEGER,
  };
  // One retry rules out a transient stall before a pattern is declared too slow.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (deps.runner(regex, inputs, unlimited, PROBE_BUDGET_MS).kind !== 'timeout') return true;
  }
  return false;
}

function analyse(source: string, deps: PatternDeps): Analysis {
  let regex: RegExp;
  try {
    regex = new RegExp(source, 'g');
  } catch {
    return rejected('invalid', 'it is not a valid regular expression');
  }
  if (new RegExp(source).test('')) return rejected('invalid', 'it can match an empty string');
  const risk = describeBacktrackingRisk(source);
  if (risk !== null) return rejected('unsafe', `${risk} (potential catastrophic backtracking)`);
  if (!probe(regex, source, deps)) {
    return rejected(
      'unsafe',
      'it exceeded the evaluation time budget on adversarial input',
      deps.wallClock() + PROBE_REJECTION_TTL_MS,
    );
  }
  return { regex, rejection: null, contextual: dependsOnContext(source), expiresAt: null };
}

/** Analysis of a pattern source, cached by content in a small LRU; the probe runs on a miss only. */
function analysisFor(source: string, deps: PatternDeps): Analysis {
  const known = analysisCache.get(source);
  if (known !== undefined && (known.expiresAt === null || known.expiresAt > deps.wallClock())) {
    analysisCache.delete(source);
    analysisCache.set(source, known);
    return known;
  }
  const fresh = analyse(source, deps);
  analysisCache.delete(source);
  analysisCache.set(source, fresh);
  while (analysisCache.size > CACHE_LIMIT) {
    const oldest = analysisCache.keys().next();
    if (oldest.done === true) break;
    analysisCache.delete(oldest.value);
  }
  return fresh;
}

/** Tests only. */
export function resetCustomPatternCache(): void {
  analysisCache.clear();
}

/** Tests only: how many distinct pattern sources are cached. */
export function customPatternCacheSize(): number {
  return analysisCache.size;
}

// ------------------------------------------------------------------ resolving a pattern list

function isUnsafeNameChar(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff
  );
}

/** Names end up in admin-facing messages, so control, zero-width and bidi characters are dropped. */
function cleanName(name: unknown, index: number): string {
  const text = typeof name === 'string' ? name : '';
  const printable = [...text]
    .filter((char) => !isUnsafeNameChar(char.codePointAt(0) ?? 0))
    .join('')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  return printable.length > 0 ? printable : `pattern ${index + 1}`;
}

const RUN_MESSAGES: Record<
  'timeout' | 'budget_exhausted' | 'match_limit' | 'unstable' | 'error',
  string
> = {
  timeout: 'it exceeded its evaluation time budget on this input',
  budget_exhausted:
    'the request ran out of its custom-pattern time budget before this pattern could run',
  match_limit: `it matched too many times (over ${MAX_MATCHES_PER_STRING} in one text or ${MAX_MATCHES_PER_PATTERN} in one request)`,
  unstable: 'its replacements kept exposing new matches until the re-check limit was reached',
  error: 'it could not be evaluated',
};

function failure(
  code: CustomPatternFailureCode,
  index: number,
  label: string,
  message: string,
): CustomPatternFailure {
  return { code, index, label, message };
}

/** A pattern whose matches had not settled when the engine stopped re-checking. */
export function unsettledFailure(pattern: UsablePattern): CustomPatternFailure {
  return failure('unstable', pattern.index, pattern.label, RUN_MESSAGES.unstable);
}

/** The human-readable note that accompanies a failure (kept for log lines and old callers). */
export function noteFor(item: CustomPatternFailure): string {
  if (item.code === 'too_many') {
    return `Only the first ${MAX_CUSTOM_PATTERNS} custom redaction patterns are applied`;
  }
  const verb =
    item.code === 'invalid' || item.code === 'unsafe' ? 'was skipped' : 'was not applied';
  return `Custom redaction pattern "${item.label}" ${verb}: ${item.message}`;
}

export interface UsablePattern {
  /** Position in the caller's list. */
  readonly index: number;
  readonly label: string;
  readonly regex: RegExp;
  readonly contextual: boolean;
}

export interface ResolvedPatterns {
  readonly usable: readonly UsablePattern[];
  /** Patterns that cannot run at all (invalid, unsafe, beyond the limit). */
  readonly failures: readonly CustomPatternFailure[];
}

/** Validates (and, once per distinct content, probes) a pattern list. Never throws. */
export function resolveCustomPatterns(
  patterns: readonly CustomRedactionPattern[],
  deps: PatternDeps = DEFAULT_PATTERN_DEPS,
): ResolvedPatterns {
  const usable: UsablePattern[] = [];
  const failures: CustomPatternFailure[] = [];

  patterns.slice(0, MAX_CUSTOM_PATTERNS).forEach((spec: unknown, index) => {
    const fields = (spec ?? {}) as { name?: unknown; pattern?: unknown };
    const label = cleanName(fields.name, index);
    const source = fields.pattern;
    if (typeof source !== 'string' || source.length === 0) {
      failures.push(failure('invalid', index, label, 'the pattern is empty'));
      return;
    }
    if (source.length > MAX_CUSTOM_PATTERN_LENGTH) {
      failures.push(
        failure(
          'invalid',
          index,
          label,
          `the pattern is longer than ${MAX_CUSTOM_PATTERN_LENGTH} characters`,
        ),
      );
      return;
    }
    const analysis = analysisFor(source, deps);
    if (analysis.rejection !== null || analysis.regex === null) {
      const reason = analysis.rejection ?? {
        code: 'invalid' as const,
        message: 'it cannot be used',
      };
      failures.push(failure(reason.code, index, label, reason.message));
      return;
    }
    usable.push({ index, label, regex: analysis.regex, contextual: analysis.contextual });
  });

  if (patterns.length > MAX_CUSTOM_PATTERNS) {
    failures.unshift(
      failure(
        'too_many',
        MAX_CUSTOM_PATTERNS,
        `patterns after the first ${MAX_CUSTOM_PATTERNS}`,
        `only the first ${MAX_CUSTOM_PATTERNS} patterns are applied`,
      ),
    );
  }
  return { usable, failures };
}

/** What settings validation needs: which patterns can run, and why the others cannot. */
export interface CompiledCustomPatterns {
  readonly entries: readonly { readonly name: string; readonly index: number }[];
  readonly notes: readonly string[];
  readonly failures: readonly CustomPatternFailure[];
}

/** Save-time validation of a pattern list (never throws). Probe results are cached by content. */
export function compileCustomPatterns(
  patterns: readonly CustomRedactionPattern[],
  deps: PatternDeps = DEFAULT_PATTERN_DEPS,
): CompiledCustomPatterns {
  const { usable, failures } = resolveCustomPatterns(patterns, deps);
  return {
    entries: usable.map(({ label, index }) => ({ name: label, index })),
    notes: failures.map(noteFor),
    failures,
  };
}

// ------------------------------------------------------------------ evaluation

export interface PatternEvaluation {
  /** Per input string: flat `[start, end, start, end, ...]` of every match of every pattern (unsorted). */
  readonly spans: readonly (number[] | undefined)[];
  readonly failures: readonly CustomPatternFailure[];
}

const DEFAULT_RUN_LIMITS: RunLimits = {
  perString: MAX_MATCHES_PER_STRING,
  perBatch: MAX_MATCHES_PER_PATTERN,
};

/**
 * Runs each pattern once over all of `texts` (one sandbox call per pattern) within `budget`. Matches
 * found before a timeout or a limit are kept; the pattern is also reported as failed. A run that times
 * out is repeated once if the budget allows, so a stall of the machine (GC, CPU throttling) does not
 * refuse a payload that a second attempt would have scanned in milliseconds; an input that really is
 * too slow for the pattern times out again and is reported.
 */
export function evaluatePatterns(
  patterns: readonly UsablePattern[],
  texts: readonly string[],
  budget: CustomPatternBudget,
  deps: PatternDeps = DEFAULT_PATTERN_DEPS,
): PatternEvaluation {
  const spans: (number[] | undefined)[] = new Array<number[] | undefined>(texts.length);
  const failures: CustomPatternFailure[] = [];
  let totalChars = 0;
  for (const text of texts) totalChars += text.length;

  /** One sandbox call charged to the budget; null when the budget cannot afford it or it threw. */
  const attempt = (pattern: UsablePattern): RunOutcome | 'error' | null => {
    const remaining = budget.remainingMs();
    if (remaining < MIN_SLICE_MS) return null;
    const started = deps.clock();
    try {
      return deps.runner(
        pattern.regex,
        texts,
        deps.limits ?? DEFAULT_RUN_LIMITS,
        Math.min(remaining, deadlineFor(totalChars)),
      );
    } catch {
      return 'error';
    } finally {
      budget.consume(deps.clock() - started);
    }
  };

  for (const pattern of patterns) {
    let outcome = attempt(pattern);
    if (outcome === null) {
      failures.push(
        failure('budget_exhausted', pattern.index, pattern.label, RUN_MESSAGES.budget_exhausted),
      );
      continue;
    }
    if (outcome !== 'error' && outcome.kind === 'timeout') {
      const second = attempt(pattern);
      if (second !== null) outcome = second;
    }
    if (outcome === 'error') {
      failures.push(failure('error', pattern.index, pattern.label, RUN_MESSAGES.error));
      continue;
    }
    if (outcome.kind === 'timeout') {
      failures.push(failure('timeout', pattern.index, pattern.label, RUN_MESSAGES.timeout));
    } else if (outcome.kind === 'limit') {
      failures.push(failure('match_limit', pattern.index, pattern.label, RUN_MESSAGES.match_limit));
    }
    for (let k = 0; k + 2 < outcome.spans.length; k += 3) {
      const text = outcome.spans[k] ?? 0;
      const start = outcome.spans[k + 1] ?? 0;
      const found = spans[text] ?? [];
      found.push(start, start + (outcome.spans[k + 2] ?? 0));
      spans[text] = found;
    }
  }
  return { spans, failures };
}
