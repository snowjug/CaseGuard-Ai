import vm from 'node:vm';
import type { CustomRedactionPattern } from './types';
import { placeholderFor } from './rules';

/*
 * Administrator-supplied patterns are untrusted input to a backtracking regex engine. Three layers
 * keep them from becoming a denial-of-service lever (NFR-SEC-05):
 *   1. Static checks: length, syntax, empty matches, nested/ambiguous repetition, back-references.
 *   2. A probe: the compiled pattern runs against 2000-character adversarial inputs under a hard
 *      wall-clock budget; patterns that cannot finish are rejected up front.
 *   3. A run-time budget: every evaluation happens in a `vm` context with a timeout, which really
 *      interrupts the regex engine. A pattern that blows the budget on some input is disabled and
 *      reported instead of hanging the process.
 * Invalid or unsafe patterns are skipped with a note; they never throw.
 */

export const MAX_CUSTOM_PATTERN_LENGTH = 200;
export const MAX_CUSTOM_PATTERNS = 20;
const MAX_NAME_LENGTH = 60;
const MAX_UNBOUNDED_QUANTIFIERS = 4;
const PROBE_LENGTH = 2000;
/** Probes are tiny, so any pattern that needs this long on 2000 characters is hopeless. */
const PROBE_BUDGET_MS = 200;
const RUN_BUDGET_BASE_MS = 200;

/** Wall-clock allowance for one evaluation: generous for linear patterns, scaled with input size. */
function runBudgetMs(textLength: number): number {
  return Math.min(2000, RUN_BUDGET_BASE_MS + Math.ceil(textLength / 2000));
}

interface PatternEntry {
  readonly name: string;
  readonly regex: RegExp;
  disabled: boolean;
}

/** Validated, probed patterns ready to run. Cheap to reuse across many `redactText` calls. */
export interface CompiledCustomPatterns {
  readonly signature: string;
  readonly entries: PatternEntry[];
  /** Why individual patterns were skipped at compile time. */
  readonly notes: readonly string[];
  readonly sandbox: vm.Context;
}

const COLLECT_MATCHES = new vm.Script(
  `(function () {
    const found = [];
    const re = __re;
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(__text)) !== null) {
      if (match[0].length === 0) { re.lastIndex += 1; continue; }
      found.push(match.index, match[0].length);
    }
    return found;
  })()`,
  { filename: 'caseguard-custom-redaction.js' },
);

type RunOutcome = { ok: true; spans: number[] } | { ok: false };

function runPattern(
  sandbox: vm.Context,
  regex: RegExp,
  text: string,
  budgetMs: number,
): RunOutcome {
  const scope = sandbox as { __re: RegExp | null; __text: string };
  scope.__re = regex;
  scope.__text = text;
  try {
    const spans = COLLECT_MATCHES.runInContext(sandbox, { timeout: budgetMs }) as unknown;
    return { ok: true, spans: Array.isArray(spans) ? (spans as number[]) : [] };
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return { ok: false };
    throw error;
  } finally {
    scope.__re = null;
    scope.__text = '';
  }
}

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
 * needs to catch the classic shapes (nested or alternated repetition); the sandbox is the backstop.
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

// ------------------------------------------------------------------ compilation

function skipNote(name: string, reason: string): string {
  return `Custom redaction pattern "${name}" was skipped: ${reason}`;
}

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

/** Names end up in admin-facing notes, so control, zero-width and bidi characters are dropped. */
function cleanName(name: unknown, index: number): string {
  const text = typeof name === 'string' ? name : '';
  const printable = [...text]
    .filter((char) => !isUnsafeNameChar(char.codePointAt(0) ?? 0))
    .join('')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  return printable.length > 0 ? printable : `pattern ${index + 1}`;
}

function signatureOf(patterns: readonly CustomRedactionPattern[]): string {
  return patterns.map((p) => `${String(p.name)}\u0000${String(p.pattern)}`).join('\u0001');
}

/** Validates and probes `patterns`. Never throws: problems become notes and the pattern is skipped. */
export function compileCustomPatterns(
  patterns: readonly CustomRedactionPattern[],
): CompiledCustomPatterns {
  const sandbox = vm.createContext({ __re: null, __text: '' });
  const entries: PatternEntry[] = [];
  const notes: string[] = [];
  if (patterns.length > MAX_CUSTOM_PATTERNS) {
    notes.push(`Only the first ${MAX_CUSTOM_PATTERNS} custom redaction patterns are applied`);
  }

  patterns.slice(0, MAX_CUSTOM_PATTERNS).forEach((spec, index) => {
    const name = cleanName(spec.name, index);
    const source: unknown = spec.pattern;
    if (typeof source !== 'string' || source.length === 0) {
      notes.push(skipNote(name, 'the pattern is empty'));
      return;
    }
    if (source.length > MAX_CUSTOM_PATTERN_LENGTH) {
      notes.push(
        skipNote(name, `the pattern is longer than ${MAX_CUSTOM_PATTERN_LENGTH} characters`),
      );
      return;
    }
    let regex: RegExp;
    try {
      regex = new RegExp(source, 'g');
    } catch {
      notes.push(skipNote(name, 'it is not a valid regular expression'));
      return;
    }
    if (new RegExp(source).test('')) {
      notes.push(skipNote(name, 'it can match an empty string'));
      return;
    }
    const risk = describeBacktrackingRisk(source);
    if (risk !== null) {
      notes.push(skipNote(name, `${risk} (potential catastrophic backtracking)`));
      return;
    }
    // One retry rules out a transient stall (GC pause, a busy machine) before rejecting a pattern.
    const finishes = (input: string): boolean =>
      runPattern(sandbox, regex, input, PROBE_BUDGET_MS).ok ||
      runPattern(sandbox, regex, input, PROBE_BUDGET_MS).ok;
    if (!probeInputs(source).every(finishes)) {
      notes.push(skipNote(name, 'it exceeded the evaluation time budget on adversarial input'));
      return;
    }
    entries.push({ name, regex, disabled: false });
  });

  return { signature: signatureOf(patterns), entries, notes, sandbox };
}

const COMPILED = new WeakMap<readonly CustomRedactionPattern[], CompiledCustomPatterns>();

/** Compiles once per distinct pattern list (identity plus content check) and reuses the result. */
export function compiledFor(patterns: readonly CustomRedactionPattern[]): CompiledCustomPatterns {
  const cached = COMPILED.get(patterns);
  if (cached && cached.signature === signatureOf(patterns)) return cached;
  const compiled = compileCustomPatterns(patterns);
  COMPILED.set(patterns, compiled);
  return compiled;
}

// ------------------------------------------------------------------ application

const PLACEHOLDER_SPAN = /\[REDACTED:[a-z_]+(?:#\d+)?\]/g;

function placeholderSpans(text: string): [number, number][] {
  if (!text.includes('[REDACTED:')) return [];
  return [...text.matchAll(PLACEHOLDER_SPAN)].map((m) => [m.index, m.index + m[0].length]);
}

export interface CustomApplyReport {
  hit(): void;
  note(message: string): void;
}

/** Applies compiled patterns in order; matches that would overlap an existing placeholder are ignored. */
export function applyCustomPatterns(
  text: string,
  compiled: CompiledCustomPatterns,
  report: CustomApplyReport,
): string {
  const placeholder = placeholderFor('custom');
  let current = text;
  for (const note of compiled.notes) report.note(note);

  for (const entry of compiled.entries) {
    if (entry.disabled) {
      report.note(
        skipNote(entry.name, 'it exceeded its evaluation time budget earlier and is disabled'),
      );
      continue;
    }
    const budget = runBudgetMs(current.length);
    // One retry rules out a transient stall (GC pause, a busy machine) before a pattern is switched off.
    let outcome = runPattern(compiled.sandbox, entry.regex, current, budget);
    if (!outcome.ok) outcome = runPattern(compiled.sandbox, entry.regex, current, budget);
    if (!outcome.ok) {
      entry.disabled = true;
      report.note(
        skipNote(
          entry.name,
          'it exceeded the evaluation time budget on this input and is now disabled',
        ),
      );
      continue;
    }
    if (outcome.spans.length === 0) continue;

    const protectedSpans = placeholderSpans(current);
    let cursor = 0;
    let guard = 0;
    let out = '';
    for (let i = 0; i + 1 < outcome.spans.length; i += 2) {
      const start = outcome.spans[i] ?? 0;
      const end = start + (outcome.spans[i + 1] ?? 0);
      while (guard < protectedSpans.length && (protectedSpans[guard]?.[1] ?? 0) <= start)
        guard += 1;
      const overlapping = protectedSpans[guard];
      if (overlapping && overlapping[0] < end) continue;
      out += current.slice(cursor, start) + placeholder;
      cursor = end;
      report.hit();
    }
    current = out + current.slice(cursor);
  }
  return current;
}
