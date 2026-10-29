import type { FastifyBaseLogger } from 'fastify';
import type { AppConfig } from '@caseguard/config';
import type { ProductMetrics } from '@caseguard/observability';
import type { Permission, Role } from '@caseguard/schemas';
import { ROLE_PERMISSIONS, type AuthContext } from '@caseguard/security';
import type { AuditAppendInput, TenantRepositories, TenantScope } from '../db';
import type { Services } from '../services/ports';

export interface AuditEventInput {
  /** Dotted action name, e.g. `skill.publish` or `route.cases.create`. */
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly caseId: string | null;
  readonly outcome: AuditAppendInput['outcome'];
  /** Ids, counters and enum values only. Never case text, secrets or free-form user input. */
  readonly details?: Record<string, unknown>;
}

/**
 * Everything a service needs to act for one authenticated caller. Built once per request (or per job)
 * from a validated credential: the tenant and actor come from the identity provider, never from request
 * input, and `repos` can only see that tenant's rows.
 */
export interface RequestContext {
  readonly requestId: string;
  readonly auth: AuthContext;
  readonly scope: TenantScope;
  readonly repos: TenantRepositories;
  readonly config: AppConfig;
  readonly logger: FastifyBaseLogger;
  readonly metrics: ProductMetrics;
  readonly services: Services;
  readonly now: () => Date;
  readonly newId: (prefix: string) => string;
  /** Aborted when the client disconnects (requests) or the job is cancelled (jobs). */
  readonly signal: AbortSignal;
  /**
   * Appends an audit event for the current caller. Pass the `repos` handed to a
   * `repos.transaction` callback to make the audit event part of that transaction (do this for
   * security-critical mutations so the change and its record commit or roll back together).
   */
  audit(event: AuditEventInput, repos?: TenantRepositories): Promise<void>;
}

/** The role recorded on audit events: the first role that holds the permission, else the first role. */
export function auditRoleOf(auth: AuthContext, permission: Permission | null): Role | 'anonymous' {
  const roles = auth.roles;
  if (permission !== null) {
    const granting = roles.find((role) => ROLE_PERMISSIONS[role].includes(permission));
    if (granting !== undefined) return granting;
  }
  return roles[0] ?? 'anonymous';
}

/** Returns a copy of `ctx` with a different abort signal (used for background jobs). */
export function withSignal(ctx: RequestContext, signal: AbortSignal): RequestContext {
  return { ...ctx, signal };
}
