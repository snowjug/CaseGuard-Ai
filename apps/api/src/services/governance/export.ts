import type { ExportBody, ExportResponse } from '@caseguard/schemas';
import { NotFoundError } from '../../errors';
import type { RequestContext } from '../../http/request-context';
import { loadAuditBundle, loadCaseBundle, type BundleOutcome } from './export-bundles';
import {
  checkExportEnabled,
  normalizeExportRequest,
  recordCapRefusal,
  refusalError,
  type ExportRefusal,
  type ExportRequest,
} from './export-policy';

export type ExportContext = Pick<RequestContext, 'repos' | 'audit' | 'now'>;

const SYNTHETIC_NOTICE = 'All data in this export is synthetic.';
const NOTICES: Record<ExportRequest['scope'], string> = {
  case:
    'Redacted case record for one case: source attestation, participants, timeline events, resolution and reviewer decisions. ' +
    'Derived analysis is not included; it is regenerated from this record. This export is recorded in the audit log.',
  audit:
    "The tenant's audit chain in sequence order with its verification result. This export is recorded in the audit log " +
    'after this snapshot, so it is not part of the chain shown here.',
};

/** One `export.created` record for every attempt: `success`, or `denied` with the reason. */
async function recordExport(
  ctx: Pick<ExportContext, 'audit'>,
  request: ExportRequest,
  outcome: 'success' | 'denied',
  recordCount: number,
  denialReason: string | null,
): Promise<void> {
  await ctx.audit({
    action: 'export.created',
    targetType: request.scope === 'case' ? 'case' : 'audit_log',
    targetId: request.caseId,
    caseId: request.caseId,
    outcome,
    details: {
      scope: request.scope,
      caseId: request.caseId,
      recordCount,
      ...(denialReason === null ? {} : { denialReason }),
    },
  });
}

async function deny(
  ctx: Pick<ExportContext, 'audit'>,
  request: ExportRequest,
  refusal: ExportRefusal,
  recordCount: number,
): Promise<never> {
  await recordExport(ctx, request, 'denied', recordCount, refusal.reason);
  throw refusalError(refusal);
}

/**
 * A case that does not exist for this tenant (a typo, or another tenant's id) is a refused attempt as
 * well: it is recorded in the caller's own audit trail before the 404 is answered.
 */
async function loadBundle(
  ctx: ExportContext,
  request: ExportRequest,
  cap: number,
): Promise<BundleOutcome> {
  if (request.scope === 'audit') return loadAuditBundle(ctx, cap);
  try {
    return await loadCaseBundle(ctx, request.caseId, cap);
  } catch (error) {
    if (error instanceof NotFoundError) {
      await recordExport(ctx, request, 'denied', 0, 'case_not_found');
    }
    throw error;
  }
}

/**
 * Exports a case record or the tenant's audit chain as JSON, subject to the tenant's export controls
 * (a kind of export may be switched off, and the record count is capped; an oversized export is
 * refused, never truncated). Every attempt on data is audited as `export.created`, with outcome
 * `denied` when refused (export switched off, over the cap, or the case does not exist for this
 * tenant). The audit record is written before the data is returned, so nothing leaves unrecorded.
 *
 * The justification (`reason`) is required and validated but, like other free text, is not copied into
 * the audit details (ids, counters and enums only).
 */
export async function exportData(ctx: ExportContext, body: ExportBody): Promise<ExportResponse> {
  const request = normalizeExportRequest(body);
  const controls = (await ctx.repos.governance.getSettings()).export_controls.value;

  const disabled = checkExportEnabled(controls, request.scope);
  if (disabled !== null) return deny(ctx, request, disabled, 0);

  const cap = controls.maxRecordsPerExport;
  const outcome = await loadBundle(ctx, request, cap);
  if (!outcome.ok) {
    return deny(ctx, request, recordCapRefusal(cap, outcome.recordCount), outcome.recordCount);
  }

  const { bundle } = outcome;
  await recordExport(ctx, request, 'success', bundle.recordCount, null);
  const notice = bundle.synthetic
    ? `${NOTICES[request.scope]} ${SYNTHETIC_NOTICE}`
    : NOTICES[request.scope];
  return {
    exportedAt: ctx.now().toISOString(),
    scope: request.scope,
    recordCount: bundle.recordCount,
    notice,
    data: bundle.data,
  };
}
