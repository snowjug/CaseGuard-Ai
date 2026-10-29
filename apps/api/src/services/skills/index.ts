import type { ServiceDeps } from '..';
import type { SkillsPort } from '../ports';
import { unavailable } from '../unavailable';

/** SkillDNA service (owner: API counterfactual/skills workstream). Replace this stub. */
export function createSkillsService(_deps: ServiceDeps): SkillsPort {
  return unavailable<SkillsPort>('SkillsPort');
}
