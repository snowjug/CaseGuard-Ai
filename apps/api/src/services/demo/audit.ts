import type { RequestContext } from '../../http/request-context';

export type DemoAuditAction = 'demo.seed' | 'demo.reset';

/**
 * Appends a demo audit event. `details` carry ids, counters and enums only: never case text, free-form
 * input or anything a person typed.
 */
export async function auditDemo(
  ctx: RequestContext,
  action: DemoAuditAction,
  outcome: 'success' | 'denied' | 'failure',
  details: Record<string, unknown>,
): Promise<void> {
  await ctx.audit({
    action,
    targetType: 'tenant',
    targetId: ctx.scope.tenantId,
    caseId: null,
    outcome,
    details,
  });
}

/**
 * Records a refusal or a failure without letting the audit write change what the caller is told: the
 * request is answered with its own error, and a failed audit write is logged with the action only.
 */
export async function auditDemoQuietly(
  ctx: RequestContext,
  action: DemoAuditAction,
  outcome: 'denied' | 'failure',
  details: Record<string, unknown>,
): Promise<void> {
  try {
    await auditDemo(ctx, action, outcome, details);
  } catch (error) {
    ctx.logger.error(
      { err: error, action, event: 'demo.audit_failed' },
      'demo audit event not written',
    );
  }
}
