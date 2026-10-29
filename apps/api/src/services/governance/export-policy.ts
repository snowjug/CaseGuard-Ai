import type { ExportBody, ExportControls } from '@caseguard/schemas';
import { ConflictError, ForbiddenError, ValidationFailedError } from '../../errors';
import type { FieldIssue } from './types';

export type ExportScope = ExportBody['scope'];

export type ExportRequest =
  | { readonly scope: 'case'; readonly caseId: string; readonly reason: string }
  | { readonly scope: 'audit'; readonly caseId: null; readonly reason: string };

export type ExportRefusalReason =
  'case_export_disabled' | 'audit_export_disabled' | 'record_cap_exceeded';

/** Why an export was refused and the HTTP status that explains it (403 policy, 409 size). */
export interface ExportRefusal {
  readonly reason: ExportRefusalReason;
  readonly status: 403 | 409;
  readonly message: string;
}

const MIN_REASON_LENGTH = 5;

/**
 * Cross-field rules of the export body that its schema cannot express: a real justification (the
 * schema counts spaces), a case id exactly when the scope is a case. Problems are 422s with paths.
 */
export function normalizeExportRequest(body: ExportBody): ExportRequest {
  const reason = body.reason.trim();
  const issues: FieldIssue[] = [];
  if (reason.length < MIN_REASON_LENGTH) {
    issues.push({
      path: 'body.reason',
      message: `State why the data is exported (at least ${MIN_REASON_LENGTH} characters).`,
    });
  }
  if (body.scope === 'case' && body.caseId === undefined) {
    issues.push({ path: 'body.caseId', message: 'caseId is required when the scope is "case".' });
  }
  if (body.scope === 'audit' && body.caseId !== undefined) {
    issues.push({ path: 'body.caseId', message: 'caseId applies only to the "case" scope.' });
  }
  if (issues.length > 0) {
    throw new ValidationFailedError('The export request is not valid', issues);
  }
  return body.scope === 'case' && body.caseId !== undefined
    ? { scope: 'case', caseId: body.caseId, reason }
    : { scope: 'audit', caseId: null, reason };
}

/** The tenant's export controls decide whether a kind of export may happen at all. */
export function checkExportEnabled(
  controls: ExportControls,
  scope: ExportScope,
): ExportRefusal | null {
  if (scope === 'case' && !controls.allowCaseExport) {
    return {
      reason: 'case_export_disabled',
      status: 403,
      message: 'Case export is disabled by the export controls of this tenant.',
    };
  }
  if (scope === 'audit' && !controls.allowAuditExport) {
    return {
      reason: 'audit_export_disabled',
      status: 403,
      message: 'Audit-log export is disabled by the export controls of this tenant.',
    };
  }
  return null;
}

/** An export larger than `maxRecordsPerExport` is refused, never silently truncated. */
export function recordCapRefusal(cap: number, recordCount: number): ExportRefusal {
  return {
    reason: 'record_cap_exceeded',
    status: 409,
    message: `This export would contain ${recordCount} records but the export controls allow at most ${cap}. Raise the limit in Governance (export controls) or narrow the export.`,
  };
}

export function refusalError(refusal: ExportRefusal): ForbiddenError | ConflictError {
  return refusal.status === 403
    ? new ForbiddenError(refusal.message)
    : new ConflictError(refusal.message, { reason: refusal.reason });
}
