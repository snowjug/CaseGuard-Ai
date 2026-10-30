import type { ContextInfrastructure } from '../../http/context-factory';
import type { ServiceDeps } from '..';
import type { DemoPort } from '../ports';
import { resetDemo } from './reset';
import { seedDemo } from './seed';
import { buildDemoState } from './state';

/** The infrastructure persona contexts are built from: the process-wide parts plus the live services. */
function contextInfrastructure(deps: ServiceDeps): ContextInfrastructure {
  const { config, metrics, repos, now, newId } = deps.infra;
  return { config, metrics, repos, now, newId, services: deps.services() };
}

/**
 * The guided demo: progress derived from stored facts, a seeder that drives the real services as the
 * story's personas, and a reset. Everything is tenant-scoped through `ctx.repos`.
 */
export function createDemoService(deps: ServiceDeps): DemoPort {
  return {
    state: (ctx) => buildDemoState(ctx),
    seed: (ctx, options) => seedDemo(contextInfrastructure(deps), ctx, options.profile),
    async reset(ctx) {
      await resetDemo(ctx);
      return buildDemoState(ctx);
    },
  };
}

export { administratorContext, type ProcessInfrastructure } from './actors';
export { DEMO_DATASET_LABEL } from './notices';
export { deriveSteps } from './derive';
