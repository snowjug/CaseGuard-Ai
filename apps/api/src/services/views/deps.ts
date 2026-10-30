import { engineBudgetFor } from '../engine-budget';
import { ViewCache, type ViewDeps } from './computation';

const shared = new WeakMap<object, ViewDeps>();

/**
 * The recomputation caches of one app, with the app's engine budget: created on first use, so the
 * routes and the tests of one app see the same instance (a test can read `deps.cache.passes.stats`
 * to count the engine passes a request really ran).
 */
export function viewDepsFor(infra: object): ViewDeps {
  let deps = shared.get(infra);
  if (deps === undefined) {
    deps = { cache: new ViewCache({ budget: engineBudgetFor(infra) }) };
    shared.set(infra, deps);
  }
  return deps;
}
