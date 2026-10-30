import type { FastifyBaseLogger } from 'fastify';
import type { Permission } from '@caseguard/schemas';
import type { AuthContext } from '@caseguard/security';
import type { Infrastructure } from '../infrastructure';
import { auditRoleOf, type RequestContext } from './request-context';

/**
 * The part of the infrastructure a context is built from. It is narrower than `Infrastructure` so that
 * a service can build the context of another persona (the demo seeder) without the identity provider.
 */
export type ContextInfrastructure = Pick<
  Infrastructure,
  'config' | 'metrics' | 'repos' | 'services' | 'now' | 'newId'
>;

export interface ContextInput {
  readonly requestId: string;
  readonly auth: AuthContext;
  /** Permission the route required; chooses which of the caller's roles is recorded on audit events. */
  readonly permission: Permission | null;
  readonly signal: AbortSignal;
  readonly logger: FastifyBaseLogger;
  /** Called whenever the handler writes an audit event (lets the binder skip its fallback record). */
  readonly onAudit?: () => void;
}

/**
 * Builds the per-caller context. The tenant and actor come from the authenticated identity only; the
 * repositories returned here are bound to that tenant, so a handler cannot read another tenant's rows
 * even by mistake.
 */
export function buildRequestContext(
  infra: ContextInfrastructure,
  input: ContextInput,
): RequestContext {
  const { auth } = input;
  const repos = infra.repos.forTenant({ tenantId: auth.tenantId, actorId: auth.userId });
  const actorRole = auditRoleOf(auth, input.permission);

  return {
    requestId: input.requestId,
    auth,
    scope: repos.scope,
    repos,
    config: infra.config,
    logger: input.logger,
    metrics: infra.metrics,
    services: infra.services,
    now: infra.now,
    newId: infra.newId,
    signal: input.signal,
    async audit(event, target = repos) {
      input.onAudit?.();
      await target.audit.append({
        actorId: auth.userId,
        actorRole,
        action: event.action,
        targetType: event.targetType,
        targetId: event.targetId,
        caseId: event.caseId,
        outcome: event.outcome,
        details: event.details ?? {},
        correlationId: input.requestId,
      });
    },
  };
}
