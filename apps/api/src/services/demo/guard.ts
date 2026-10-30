import { ConflictError } from '../../errors';
import type { RequestContext } from '../../http/request-context';
import { auditDemoQuietly, type DemoAuditAction } from './audit';

export const NOT_A_DEMO_TENANT = 'demo data can only be managed in a synthetic demo tenant';

/**
 * Seeding and resetting erase or create case data, so they are only allowed where that data is
 * synthetic by construction: demo mode is on (configuration already refuses it in production), or the
 * caller's tenant is flagged synthetic.
 */
export function demoManagementAllowed(input: {
  readonly demoMode: boolean;
  readonly tenantSynthetic: boolean;
}): boolean {
  return input.demoMode || input.tenantSynthetic;
}

/** Throws a 409 (and audits a denial) unless demo data may be managed in the caller's tenant. */
export async function assertDemoManageable(
  ctx: RequestContext,
  action: DemoAuditAction,
  details: Record<string, unknown> = {},
): Promise<void> {
  const tenant = await ctx.repos.governance.getTenant();
  if (
    demoManagementAllowed({ demoMode: ctx.config.demo.mode, tenantSynthetic: tenant.synthetic })
  ) {
    return;
  }
  await auditDemoQuietly(ctx, action, 'denied', { ...details, reason: 'not_a_demo_tenant' });
  throw new ConflictError(NOT_A_DEMO_TENANT, { reason: 'not_a_demo_tenant' });
}

/**
 * Erasing or seeding underneath a job that is still working on a case would write into rows that are
 * about to disappear (or analyse a case twice at once), so both wait for the tenant's jobs to finish.
 */
export async function assertNoActiveJobs(
  ctx: RequestContext,
  action: DemoAuditAction,
  details: Record<string, unknown> = {},
): Promise<void> {
  for (const status of ['queued', 'running'] as const) {
    const page = await ctx.repos.jobs.list({ status, limit: 1 });
    if (page.items.length > 0) {
      await auditDemoQuietly(ctx, action, 'denied', { ...details, reason: 'job_active' });
      throw new ConflictError(
        'A job is still queued or running in this workspace. Wait until it has finished, then try again.',
        { reason: 'job_active' },
      );
    }
  }
}
