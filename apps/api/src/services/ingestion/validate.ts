import {
  BundleValidationError,
  normalizeBundle,
  toValidationIssues,
  validateCaseBundleValue,
} from '@caseguard/domain';
import type { CaseBundle, ValidationIssue } from '@caseguard/schemas';
import { errorIssue, formatPath } from './issues';

/**
 * `normalizeBundle` is what rejects replies that point at later events. Running it here (with
 * throwaway ids) makes a preview refuse exactly what ingestion would, with the same field paths.
 */
export function semanticIssues(bundle: CaseBundle, now: string): ValidationIssue[] {
  try {
    normalizeBundle(bundle, {
      tenantId: 'preview',
      caseId: 'preview',
      sourceId: 'preview',
      createdBy: 'preview',
      now,
      sourceKind: 'pasted_text',
      storedPayload: '{}',
      redactionReplacements: 0,
    });
    return [];
  } catch (error) {
    if (error instanceof BundleValidationError) {
      return error.issues.map((issue) => errorIssue(formatPath(issue.path), issue.message));
    }
    throw error;
  }
}

/**
 * Redaction swaps text for placeholders that can be longer than what they replace, so a value that
 * fitted its limit when it was parsed can exceed it afterwards: 28 short e-mail addresses are 195
 * characters in an action label and several times that once redacted. The repository enforces the
 * label and structured-value limits again when it stores the case, so a preview that only checked
 * the input said "ok" and the create then failed with 422. The bundle schema is run on the redacted
 * bundle here instead, and what fails is reported with its field path.
 */
export function redactedBundleIssues(bundle: CaseBundle): ValidationIssue[] {
  const result = validateCaseBundleValue(bundle);
  if (result.ok) return [];
  return toValidationIssues(result.errors, []).map((issue) =>
    errorIssue(issue.path, `After redaction: ${issue.message}`),
  );
}
