import type { RouteId } from '@caseguard/schemas';
import type { AuthContext } from '@caseguard/security';
import type { RequestContext } from './request-context';

/** Mutable per-request state, created by the lifecycle hook and read by the binder and error handler. */
export interface RequestState {
  readonly requestId: string;
  /** `performance.now()` when the request arrived. */
  readonly startedAt: number;
  routeId: RouteId | null;
  auth: AuthContext | null;
  ctx: RequestContext | null;
  /** True once the handler (or the binder) wrote an audit event for this request. */
  audited: boolean;
  /** Aborted when the client disconnects before the response was written. */
  readonly abort: AbortController;
}

declare module 'fastify' {
  interface FastifyRequest {
    cg: RequestState;
  }
  interface FastifyContextConfig {
    routeId?: RouteId;
  }
}
