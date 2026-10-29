import type { ServiceDeps } from '..';
import type { CounterfactualPort } from '../ports';
import { unavailable } from '../unavailable';

/** Counterfactual service (owner: API counterfactual/skills workstream). Replace this stub. */
export function createCounterfactualService(_deps: ServiceDeps): CounterfactualPort {
  return unavailable<CounterfactualPort>('CounterfactualPort');
}
