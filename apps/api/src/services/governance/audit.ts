import type { AuditEvent, AuditVerification, Page } from '@caseguard/schemas';
import type { AuditQueryInput } from '../../db';
import { ValidationFailedError } from '../../errors';
import type { RequestContext } from '../../http/request-context';
import { maskSecrets } from './mask-secrets';

export type AuditReadContext = Pick<RequestContext, 'repos'>;

/**
 * Audit details are written as ids, counters and enums only, so this pass should never change anything.
 * It is defence in depth against a future writer that stores something it should not. An event whose
 * details were masked no longer matches its hash, which `masked` makes visible to exports.
 */
export function sanitizeAuditEvent(event: AuditEvent): { event: AuditEvent; masked: boolean } {
  const { value, replacements } = maskSecrets(event.details);
  return replacements === 0
    ? { event, masked: false }
    : { event: { ...event, details: value }, masked: true };
}

/** `from`/`to` bound an inclusive window, so a reversed pair can only ever be a mistake. */
function assertWindow(query: Pick<AuditQueryInput, 'from' | 'to'>): void {
  const { from, to } = query;
  if (from !== undefined && to !== undefined && Date.parse(from) > Date.parse(to)) {
    throw new ValidationFailedError('The time window is not valid', [
      { path: 'query.from', message: '"from" must not be later than "to".' },
    ]);
  }
}

/** The tenant's audit events, newest first. Tenant isolation is enforced by the repository and RLS. */
export async function listAuditEvents(
  ctx: AuditReadContext,
  query: AuditQueryInput,
): Promise<Page<AuditEvent>> {
  assertWindow(query);
  const page = await ctx.repos.audit.list(query);
  return { ...page, items: page.items.map((event) => sanitizeAuditEvent(event).event) };
}

/** Walks the tenant's whole hash chain and reports the first invalid sequence, if any. */
export function verifyAuditChain(ctx: AuditReadContext): Promise<AuditVerification> {
  return ctx.repos.audit.verify();
}
