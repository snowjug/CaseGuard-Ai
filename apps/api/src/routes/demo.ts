import type { HandlerMap } from '../http/route-binder';
import type { Infrastructure } from '../infrastructure';

/**
 * demo.state, demo.seed, demo.reset. Owner: API insights workstream.
 *
 * Only maps HTTP to the demo service (`services/demo`). The permissions come from the contract
 * (`case:read` to read the guide, `demo:manage` to seed or reset); the service additionally refuses
 * seeding and resetting outside a synthetic demo tenant and audits both.
 */
export function demoRoutes(_infra: Infrastructure): HandlerMap {
  return {
    'demo.state': ({ ctx }) => ctx.services.demo.state(ctx),

    'demo.seed': ({ body, ctx }) => ctx.services.demo.seed(ctx, { profile: body.profile }),

    'demo.reset': ({ ctx }) => ctx.services.demo.reset(ctx),
  };
}
