import type { ValidationIssue } from '@caseguard/schemas';
import { redactText, type RedactionOptions } from '@caseguard/security';

/** The preview contract allows at most this many issues. */
export const MAX_ISSUES = 200;
const MAX_PATH_CHARS = 300;
const MAX_MESSAGE_CHARS = 500;

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

/**
 * Parser and validator messages quote the input ("the value 'x' is not a timestamp"), so a secret
 * pasted into the wrong field would come straight back to the caller. Every message and path is
 * redacted before it leaves the pipeline.
 */
export function sanitizeIssues(
  issues: readonly ValidationIssue[],
  options: RedactionOptions,
): ValidationIssue[] {
  return issues.map((issue) => ({
    severity: issue.severity,
    path: redactText(issue.path, options).text.slice(0, MAX_PATH_CHARS),
    message: redactText(issue.message, options).text.slice(0, MAX_MESSAGE_CHARS),
  }));
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
