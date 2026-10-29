import type { ParseWarning, WarningCode, WarningSeverity } from './types';

const CRLF = /\r\n?/g;
// The patterns below match control characters on purpose: they are what is being removed.
// eslint-disable-next-line no-control-regex
const ANSI_SEQUENCE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const LONE_SURROGATES = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
/** Bidirectional overrides and zero-width characters can disguise text ("Trojan Source"). */
const INVISIBLE_CHARS = /[\u202A-\u202E\u2066-\u2069\u200B\u2060\uFEFF]/g;
const UNICODE_SPACES = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;
const REPLACEMENT_CHAR = /\uFFFD/g;

export interface SanitizeReport {
  controlChars: number;
  invisibleChars: number;
  replacementChars: number;
  loneSurrogates: number;
}

export interface Sanitized {
  text: string;
  report: SanitizeReport;
  bomRemoved: boolean;
}

function countAndRemove(text: string, pattern: RegExp, replacement: string): [string, number] {
  let count = 0;
  const out = text.replace(pattern, () => {
    count += 1;
    return replacement;
  });
  return [out, count];
}

/**
 * Normalises untrusted text for storage: one newline convention, no NUL or other control
 * characters (PostgreSQL rejects NUL), no unpaired surrogates, no invisible bidi controls.
 * Every class of change is counted so the caller can warn instead of silently altering evidence.
 * With `keepCarriageReturns` the line endings are left alone (the CSV tokenizer needs them).
 */
export function sanitizeText(
  input: string,
  options: { keepCarriageReturns?: boolean } = {},
): Sanitized {
  let text = input;
  const bomRemoved = text.charCodeAt(0) === 0xfeff;
  if (bomRemoved) text = text.slice(1);
  if (!options.keepCarriageReturns) text = text.replace(CRLF, '\n');
  const report: SanitizeReport = {
    controlChars: 0,
    invisibleChars: 0,
    replacementChars: 0,
    loneSurrogates: 0,
  };
  report.replacementChars = (text.match(REPLACEMENT_CHAR) ?? []).length;
  let n: number;
  [text, n] = countAndRemove(text, ANSI_SEQUENCE, '');
  report.controlChars += n;
  [text, n] = countAndRemove(text, CONTROL_CHARS, '');
  report.controlChars += n;
  [text, n] = countAndRemove(text, LONE_SURROGATES, '\uFFFD');
  report.loneSurrogates = n;
  [text, n] = countAndRemove(text, INVISIBLE_CHARS, '');
  report.invisibleChars = n;
  text = text.replace(UNICODE_SPACES, ' ');
  return { text, report, bomRemoved };
}

/** UTF-8 size without allocating a copy for the common case. */
export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** True when the text is certainly larger than `maxBytes` (bytes >= UTF-16 code units). */
export function exceedsBytes(text: string, maxBytes: number): boolean {
  if (text.length > maxBytes) return true;
  if (text.length * 3 <= maxBytes) return false;
  return utf8Bytes(text) > maxBytes;
}

/** Makes an arbitrary value safe and short enough to quote inside a message. */
export function displayValue(value: string, max = 60): string {
  const clean = value
    .replace(ANSI_SEQUENCE, '')
    .replace(CONTROL_CHARS, ' ')
    .replace(INVISIBLE_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > max ? `${safeSlice(clean, Math.max(1, max - 1))}…` : clean;
}

/** Whitespace-collapsed excerpt for previews. */
export function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${safeSlice(flat, Math.max(1, max - 1))}…` : flat;
}

/** `slice(0, max)` that never leaves half of a surrogate pair at the end. */
export function safeSlice(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/** Length in Unicode code points, which is how the case bundle schema counts characters. */
export const codePointLength = (text: string): number => {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
};

/** Cuts text at `max` characters, leaving an explicit marker so nobody mistakes it for the original. */
export function truncateWithMarker(text: string, max: number): { text: string; cut: number } {
  if (text.length <= max) return { text, cut: 0 };
  const marker = (omitted: number) => `\n[… ${omitted} characters omitted by CaseGuard]`;
  let keep = Math.max(0, max - marker(text.length).length);
  // Never split a surrogate pair.
  const code = text.charCodeAt(keep - 1);
  if (code >= 0xd800 && code <= 0xdbff) keep -= 1;
  const cut = text.length - keep;
  return { text: `${text.slice(0, keep)}${marker(cut)}`, cut };
}

/** Lower-cased, punctuation-free key used to compare speaker labels. */
export function labelKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/<[^>]{0,200}>/g, ' ')
    .replace(/[^\p{L}\p{N}@.]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const groupOf = (match: RegExpMatchArray | RegExpExecArray, index: number): string =>
  match[index] ?? '';

/** Per-call warning list with a hard cap, so hostile input cannot create unbounded output. */
export class WarningCollector {
  private readonly items: ParseWarning[] = [];
  private suppressed = 0;

  constructor(private readonly max: number) {}

  add(
    code: WarningCode,
    severity: WarningSeverity,
    message: string,
    extra: Partial<Pick<ParseWarning, 'hint' | 'line' | 'row' | 'column' | 'count'>> = {},
  ): void {
    if (this.items.length >= this.max) {
      this.suppressed += 1;
      return;
    }
    this.items.push({ code, severity, message, ...extra });
  }

  /** Warnings in the order raised, plus a final note when some were dropped. */
  toArray(): ParseWarning[] {
    if (this.suppressed === 0) return [...this.items];
    return [
      ...this.items,
      {
        code: 'warnings_truncated',
        severity: 'info',
        message: `${this.suppressed} further warning(s) were not listed.`,
        count: this.suppressed,
      },
    ];
  }

  get size(): number {
    return this.items.length;
  }
}

/** Raises the standard warnings for sanitisation changes. */
export function reportSanitization(sanitized: Sanitized, warnings: WarningCollector): void {
  const { report } = sanitized;
  if (sanitized.bomRemoved) {
    warnings.add('bom_removed', 'info', 'A byte-order mark at the start of the input was removed.');
  }
  if (report.controlChars > 0) {
    warnings.add(
      'control_characters_removed',
      'warning',
      `Removed ${report.controlChars} control character(s) that cannot be stored.`,
      { count: report.controlChars },
    );
  }
  if (report.invisibleChars > 0) {
    warnings.add(
      'invisible_characters_removed',
      'warning',
      `Removed ${report.invisibleChars} invisible or bidirectional-override character(s) that can disguise text.`,
      { count: report.invisibleChars },
    );
  }
  const invalid = report.replacementChars + report.loneSurrogates;
  if (invalid > 0) {
    warnings.add(
      'invalid_characters_replaced',
      'warning',
      `The input contains ${invalid} invalid or replaced character(s) (shown as �); the text may be corrupted.`,
      {
        hint: 'Re-export the source as UTF-8 and paste it again.',
        count: invalid,
      },
    );
  }
}
