import type { ValidationIssue } from '@caseguard/schemas';
import { RedactionIncompleteError, redactTexts, type RedactionOptions } from '@caseguard/security';

/** The preview contract allows at most this many issues. */
export const MAX_ISSUES = 200;
const MAX_PATH_CHARS = 300;
const MAX_MESSAGE_CHARS = 500;
/** Path of the issue that says a tenant's redaction pattern could not be applied. */
export const REDACTION_PATH = 'redaction';

/** What stands in for an issue whose text could not be redacted completely (the original is never shown). */
const WITHHELD_PATH = '(withheld)';
const WITHHELD_MESSAGE =
  'Details withheld: the text of this issue could not be redacted completely.';

export function errorIssue(path: string, message: string): ValidationIssue {
  return {
    path: path.slice(0, MAX_PATH_CHARS),
    message: message.slice(0, MAX_MESSAGE_CHARS),
    severity: 'error',
  };
}

/** The contract has no "info" level: informational notes are warnings whose text starts with "Note:". */
export function warningIssue(path: string, message: string): ValidationIssue {
  return {
    path: path.slice(0, MAX_PATH_CHARS),
    message: message.slice(0, MAX_MESSAGE_CHARS),
    severity: 'warning',
  };
}

export interface SanitizedIssues {
  readonly issues: ValidationIssue[];
  /**
   * Set when a tenant pattern could not be applied to the issue texts. They were then replaced by a
   * fixed message, not shown partly redacted.
   */
  readonly incomplete: RedactionIncompleteError | null;
}

/**
 * Parser and validator messages quote the input ("the value 'x' is not a timestamp"), so a secret
 * pasted into the wrong field would come straight back to the caller. Every message and path is
 * redacted before it leaves the pipeline, all of them in one batch (a tenant pattern is evaluated
 * once, not once per text) that shares the request's custom-pattern budget through `options`.
 * A path can quote a key of the payload as well, so when the batch is incomplete both are replaced.
 */
export function sanitizeIssues(
  issues: readonly ValidationIssue[],
  options: RedactionOptions,
): SanitizedIssues {
  if (issues.length === 0) return { issues: [], incomplete: null };
  const result = redactTexts(
    issues.flatMap((issue) => [issue.path, issue.message]),
    options,
  );
  if (!result.complete) {
    const withheld = new Map<string, ValidationIssue>();
    for (const { severity } of issues) {
      withheld.set(severity, { severity, path: WITHHELD_PATH, message: WITHHELD_MESSAGE });
    }
    return {
      issues: [...withheld.values()],
      incomplete: new RedactionIncompleteError(result.failures),
    };
  }
  return {
    issues: issues.map((issue, index) => ({
      severity: issue.severity,
      path: (result.items[2 * index]?.value ?? '').slice(0, MAX_PATH_CHARS),
      message: (result.items[2 * index + 1]?.value ?? '').slice(0, MAX_MESSAGE_CHARS),
    })),
    incomplete: null,
  };
}

/**
 * Operator-facing lines for the log about a refused redaction: which pattern, by label, and the
 * fixed reason (never a pattern source and never any text of the payload).
 */
export function describeIncomplete(error: RedactionIncompleteError): string[] {
  return error.failures.map(
    (failure) =>
      `Custom redaction pattern "${failure.label}" could not be applied (${failure.code}): ${failure.message}`,
  );
}

/** Errors first (they decide `ok`), then warnings, capped at the contract's limit. */
export function orderIssues(issues: readonly ValidationIssue[]): ValidationIssue[] {
  const errors = issues.filter((issue) => issue.severity === 'error');
  const warnings = issues.filter((issue) => issue.severity === 'warning');
  return [...errors, ...warnings].slice(0, MAX_ISSUES);
}

/** `['events', 3, 'inResponseTo']` becomes `events[3].inResponseTo`. */
export function formatPath(path: readonly (string | number)[]): string {
  if (path.length === 0) return '(root)';
  return path.reduce<string>((text, part) => {
    if (typeof part === 'number') return `${text}[${part}]`;
    return text === '' ? part : `${text}.${part}`;
  }, '');
}
