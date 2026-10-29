import type { SkillAuditPayload } from '@caseguard/domain';
import type { TenantRepositories } from '../../db';
import type { AuditEventInput, RequestContext } from '../../http/request-context';

/** Keys whose value can carry a case reference or a person's wording: never audited. */
const NEVER_AUDITED = ['sourceCaseReference'] as const;

/**
 * The audit event for a domain payload. Audit details hold ids, enums, counters and versions only: on
 * success the domain includes the reviewer's reason, which lives on the approval record, so it is
 * replaced by a flag here. On a refusal `reason` is the domain's own sentence (a state, a version or a
 * permission name), which is what makes a denial understandable, so it stays.
 */
export function auditEventOf(payload: SkillAuditPayload): AuditEventInput {
  const details: Record<string, unknown> = { ...payload.details };
  for (const key of NEVER_AUDITED) delete details[key];
  if (payload.outcome === 'success' && 'reason' in details) {
    delete details.reason;
    details.reasonRecorded = true;
  }
  return {
    action: payload.action,
    targetType: payload.targetType,
    targetId: payload.targetId,
    caseId: payload.caseId,
    outcome: payload.outcome,
    details,
  };
}

/** Writes domain audit payloads inside the transaction that persists (or refuses) the change. */
export async function writeSkillAudits(
  ctx: RequestContext,
  tx: TenantRepositories,
  payloads: readonly (SkillAuditPayload | null)[],
): Promise<void> {
  for (const payload of payloads) {
    if (payload !== null) await ctx.audit(auditEventOf(payload), tx);
  }
}
