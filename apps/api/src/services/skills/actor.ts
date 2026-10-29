import type { SkillActor, SkillOpContext } from '@caseguard/domain';
import type { RequestContext } from '../../http/request-context';

/** The acting person: id and permissions come from the validated credential, never from request input. */
export function actorOf(ctx: RequestContext): SkillActor {
  return { id: ctx.auth.userId, permissions: ctx.auth.permissions, kind: 'user' };
}

/** Injected clock, tenant and id generator, so domain operations are reproducible in tests. */
export function opOf(ctx: RequestContext): SkillOpContext {
  return {
    tenantId: ctx.scope.tenantId,
    now: ctx.now().toISOString(),
    nextId: (prefix) => ctx.newId(prefix),
  };
}
